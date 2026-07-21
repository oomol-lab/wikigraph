import { randomUUID } from "crypto";
import { resolve } from "path";
import { appendFile, readFile, rm } from "fs/promises";
import { openSharedStateDatabase } from "../../document/index.js";
import type { Database } from "../../document/index.js";
import { readPathSize, removeDisposableChildDirectories } from "../../gc/files.js";
import type { GcContext, GcJobResult } from "../../gc/index.js";
import { BUILD_QUEUE_SCHEMA_SQL } from "./schema.js";
import {
  createJobCachePath,
  createJobEventsPath,
  createJobLogPath,
  createJobWorkspacePath,
  getBuildQueueDatabasePath,
  getBuildJobWorkspaceRootPath,
} from "./paths.js";
import {
  createArchiveKey,
  delay,
  formatErrorEvent,
  isProcessAlive,
} from "./helpers.js";
import { BuildJobProgressAccumulator, BuildJobStoppedError } from "./progress.js";
import {
  formatBuildJobLane,
  getNumber,
  getOptionalString,
  getString,
  mapBuildJob,
} from "./row.js";
export { BUILD_JOB_STATES } from "./types.js";
export type {
  AddBuildJobOptions,
  BuildJob,
  BuildJobConflictScope,
  BuildJobEvent,
  BuildJobExecutionContext,
  BuildJobListOptions,
  BuildJobProgressCounter,
  BuildJobProgressPhase,
  BuildJobProgressReporter,
  BuildJobProgressUnit,
  BuildJobState,
  BuildJobTarget,
  BuildJobTokenUsage,
  BuildJobWorkerOptions,
} from "./types.js";
import type {
  AddBuildJobOptions,
  BuildJob,
  BuildJobConflictScope,
  BuildJobEvent,
  BuildJobListOptions,
  BuildJobState,
  BuildJobTarget,
  BuildJobWorkerOptions,
} from "./types.js";

const ACTIVE_JOB_STATES = new Set<BuildJobState>([
  "queued",
  "running",
  "canceling",
  "paused",
]);
const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;

export async function addBuildJob(
  options: AddBuildJobOptions,
): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await state.transaction(async () => {
      const archivePath = resolve(options.archivePath);
      const archiveKey = createArchiveKey(archivePath);
      const now = Date.now();
      const existing = await findActiveBuildJobInLane(state, {
        archiveKey,
        chapterId: options.chapterId,
        target: options.target,
      });

      if (existing !== undefined) {
        return await mergeActiveBuildJob(state, existing, options, now);
      }

      const jobId = options.jobId ?? randomUUID();
      const workspacePath = await createJobWorkspacePath(jobId);
      const cachePath = await createJobCachePath(jobId);
      const logPath = await createJobLogPath(jobId);
      const eventsPath = await createJobEventsPath(jobId);
      const queueRank =
        options.boost === true
          ? (await readMinQueueRank(state)) - 1
          : (await readMaxQueueRank(state)) + 1;

      await state.run(
        `
INSERT INTO build_jobs (
  job_id, archive_key, archive_path, chapter_id, target, state, queue_rank,
  workspace_path, cache_path, log_path, events_path, llm_json, prompt,
  created_at, updated_at
) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
        [
          jobId,
          archiveKey,
          archivePath,
          options.chapterId,
          options.target,
          queueRank,
          workspacePath,
          cachePath,
          logPath,
          eventsPath,
          options.llmJSON ?? null,
          options.prompt ?? null,
          now,
          now,
        ],
      );

      const job = await requireBuildJobById(state, jobId);

      await appendBuildJobEvent(job, {
        at: now,
        jobId,
        seq: 0,
        state: "queued",
        type: "created",
      });
      return job;
    });
  } finally {
    await state.close();
  }
}

export async function recordBuildJobInputRevision(input: {
  readonly currentRevision: number;
  readonly jobId: string;
  readonly ownerId: string;
}): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await state.transaction(async () => {
      await state.run(
        `
UPDATE build_jobs
SET input_revision = ?,
    updated_at = ?
WHERE job_id = ?
  AND owner_id = ?
  AND state = 'running'
`,
        [input.currentRevision, Date.now(), input.jobId, input.ownerId],
      );
    });

    return await requireBuildJobById(state, input.jobId);
  } finally {
    await state.close();
  }
}

export async function assertBuildJobInputRevision(input: {
  readonly currentRevision: number;
  readonly jobId: string;
  readonly ownerId: string;
}): Promise<void> {
  const job = await getBuildJob(input.jobId);

  if (job.state !== "running" || job.ownerId !== input.ownerId) {
    throw new BuildJobStoppedError(
      `Job ${input.jobId} is ${job.state}. Stop current worker execution.`,
    );
  }
  if (job.inputRevision === undefined) {
    throw new Error(
      `Job ${input.jobId} has no recorded chapter input revision. Requeue the job before committing build output.`,
    );
  }
  if (job.inputRevision === input.currentRevision) {
    return;
  }

  throw new Error(
    `Chapter ${job.chapterId} changed while job ${job.jobId} was running. Requeue the job before committing build output.`,
  );
}

export async function listBuildJobs(
  options: BuildJobListOptions = {},
): Promise<BuildJob[]> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    const params: Array<number | string> = [];
    const filters: string[] = [];

    if (options.archivePath !== undefined) {
      params.push(createArchiveKey(resolve(options.archivePath)));
      filters.push("archive_key = ?");
    }
    if (options.activeOnly === true || options.all !== true) {
      filters.push("state IN ('queued', 'running', 'canceling', 'paused')");
    }

    return await state.queryAll(
      `
SELECT *
FROM build_jobs
${filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`}
ORDER BY
  CASE state
    WHEN 'running' THEN 0
    WHEN 'canceling' THEN 1
    WHEN 'queued' THEN 2
    WHEN 'paused' THEN 3
    ELSE 4
  END,
  queue_rank ASC,
  updated_at DESC
`,
      params,
      mapBuildJob,
    );
  } finally {
    await state.close();
  }
}

async function findActiveBuildJobInLane(
  state: Database,
  input: {
    readonly archiveKey: string;
    readonly chapterId: number;
    readonly target: BuildJobTarget;
  },
): Promise<BuildJob | undefined> {
  const laneFilter =
    input.target === "knowledge-graph"
      ? "target = 'knowledge-graph'"
      : "target IN ('reading-graph', 'reading-summary')";

  return await state.queryOne(
    `
SELECT *
FROM build_jobs
WHERE archive_key = ?
  AND chapter_id = ?
  AND state IN ('queued', 'running', 'canceling', 'paused')
  AND ${laneFilter}
ORDER BY updated_at DESC
LIMIT 1
`,
    [input.archiveKey, input.chapterId],
    mapBuildJob,
  );
}

async function mergeActiveBuildJob(
  state: Database,
  job: BuildJob,
  options: AddBuildJobOptions,
  now: number,
): Promise<BuildJob> {
  const nextTarget =
    job.target === "reading-graph" && options.target === "reading-summary"
      ? "reading-summary"
      : job.target;
  const nextQueueRank =
    options.boost === true && job.state === "queued"
      ? (await readMinQueueRank(state)) - 1
      : job.queueRank;

  if (nextTarget === job.target && nextQueueRank === job.queueRank) {
    return job;
  }

  await state.run(
    `
UPDATE build_jobs
SET target = ?, queue_rank = ?, updated_at = ?
WHERE job_id = ?
`,
    [nextTarget, nextQueueRank, now, job.jobId],
  );

  const updated = await requireBuildJobById(state, job.jobId);

  if (nextTarget !== job.target) {
    await appendBuildJobEvent(updated, {
      at: now,
      from: job.target,
      jobId: job.jobId,
      seq: 0,
      to: nextTarget,
      type: "target_changed",
    });
  }
  if (nextQueueRank !== job.queueRank) {
    await appendBuildJobEvent(updated, {
      at: now,
      jobId: job.jobId,
      seq: 0,
      state: updated.state,
      type: "boosted",
    });
  }

  return updated;
}

export async function getBuildJob(jobId: string): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await requireBuildJobById(state, jobId);
  } finally {
    await state.close();
  }
}

async function readBuildJobForStopCheck(jobId: string): Promise<BuildJob> {
  const state = await openReadonlyBuildQueueDatabase();

  try {
    return await requireBuildJobById(state, jobId);
  } finally {
    await state.close();
  }
}

export async function resolveBuildJobId(jobIdPrefix: string): Promise<string> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await resolveBuildJobIdInState(state, jobIdPrefix);
  } finally {
    await state.close();
  }
}

export async function pauseBuildJob(jobId: string): Promise<BuildJob> {
  return await updateBuildJobState(jobId, "paused", "paused", {
    allowedStates: ["queued", "running"],
  });
}

export async function resumeBuildJob(jobId: string): Promise<BuildJob> {
  return await updateBuildJobState(jobId, "queued", "resumed", {
    allowedStates: ["paused"],
    clearOwner: true,
  });
}

export async function cancelBuildJob(jobId: string): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (job.state === "running") {
        return await markBuildJobCanceling(state, job);
      }
      if (job.state === "queued" || job.state === "paused") {
        return await markBuildJobCanceled(state, job);
      }

      throw new Error(`Cannot cancel ${job.state} job ${jobId}.`);
    });
  } finally {
    await state.close();
  }
}

export async function boostBuildJob(jobId: string): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (job.state !== "queued") {
        throw new Error(
          `Only queued jobs can be boosted. Job ${jobId} is ${job.state}.`,
        );
      }

      const now = Date.now();
      await state.run(
        `
UPDATE build_jobs
SET queue_rank = ?, updated_at = ?
WHERE job_id = ?
`,
        [(await readMinQueueRank(state)) - 1, now, jobId],
      );

      const updated = await requireBuildJobById(state, jobId);
      await appendBuildJobEvent(updated, {
        at: now,
        jobId,
        seq: 0,
        state: "queued",
        type: "boosted",
      });
      return updated;
    });
  } finally {
    await state.close();
  }
}

export async function updateBuildJobTarget(
  jobId: string,
  target: BuildJobTarget,
): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (!ACTIVE_JOB_STATES.has(job.state)) {
        throw new Error(`Cannot change target for ${job.state} job ${jobId}.`);
      }
      if (job.target === target) {
        return job;
      }
      const existing = await findActiveBuildJobInLane(state, {
        archiveKey: job.archiveKey,
        chapterId: job.chapterId,
        target,
      });

      if (existing !== undefined && existing.jobId !== job.jobId) {
        throw new Error(
          `Chapter ${job.chapterId} already has active ${formatBuildJobLane(target)} job ${existing.jobId}.`,
        );
      }
      if (job.target === "reading-summary" && target === "reading-graph") {
        if (
          job.readingSummaryStartedAt !== undefined ||
          job.currentStep === "reading-summary"
        ) {
          throw new Error(
            `Cannot downgrade job ${jobId} after summary has started. Cancel it explicitly instead.`,
          );
        }
      }

      const now = Date.now();
      await state.run(
        `
UPDATE build_jobs
SET target = ?, updated_at = ?
WHERE job_id = ?
`,
        [target, now, jobId],
      );

      const updated = await requireBuildJobById(state, jobId);
      await appendBuildJobEvent(updated, {
        at: now,
        from: job.target,
        jobId,
        seq: 0,
        to: target,
        type: "target_changed",
      });
      return updated;
    });
  } finally {
    await state.close();
  }
}

export async function assertNoActiveBuildJobs(input: {
  readonly archivePath: string;
  readonly chapterIds: readonly number[];
  readonly operation: string;
  readonly requiresTarget?: BuildJobTarget;
}): Promise<void> {
  await assertNoActiveBuildJobConflicts({
    archivePath: input.archivePath,
    operation: input.operation,
    ...(input.requiresTarget === undefined
      ? {}
      : { requiresTarget: input.requiresTarget }),
    scope: { chapterIds: input.chapterIds, kind: "chapter" },
  });
}

export async function assertNoActiveBuildJobConflicts(input: {
  readonly archivePath: string;
  readonly operation: string;
  readonly requiresTarget?: BuildJobTarget;
  readonly scope: BuildJobConflictScope;
}): Promise<void> {
  if (input.scope.kind === "chapter" && input.scope.chapterIds.length === 0) {
    return;
  }

  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    const archiveKey = createArchiveKey(resolve(input.archivePath));
    const targetFilter =
      input.requiresTarget === undefined ? "" : "AND target = ?";
    const params: Array<number | string> = [archiveKey];
    let scopeFilter = "";

    if (input.scope.kind === "chapter") {
      const placeholders = input.scope.chapterIds.map(() => "?").join(", ");

      scopeFilter = `AND chapter_id IN (${placeholders})`;
      params.push(...input.scope.chapterIds);
    }
    if (input.requiresTarget !== undefined) {
      params.push(input.requiresTarget);
    }

    const job = await state.queryOne(
      `
SELECT *
FROM build_jobs
WHERE archive_key = ?
  ${scopeFilter}
  AND state IN ('queued', 'running', 'canceling', 'paused')
  ${targetFilter}
ORDER BY updated_at DESC
LIMIT 1
`,
      params,
      mapBuildJob,
    );

    if (job === undefined) {
      return;
    }

    throw new Error(
      `Chapter ${job.chapterId} has active ${job.target} job ${job.jobId}. ${input.operation} is blocked until the job is paused/canceled or completed.`,
    );
  } finally {
    await state.close();
  }
}

export async function runBuildJobWorker(
  options: BuildJobWorkerOptions,
): Promise<void> {
  const state = await openBuildQueueDatabase();
  const ownerId = `${process.pid}-${randomUUID()}`;
  const concurrency = Math.max(1, options.concurrency);
  const idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
  let stopping = false;
  let busySlotCount = 0;
  let idleSince = Date.now();

  const stop = (_signal: NodeJS.Signals): void => {
    stopping = true;
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const heartbeat = setInterval(() => {
    void heartbeatBuildWorker(ownerId).catch(() => undefined);
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  try {
    const acquired = await acquireBuildWorkerLease(state, ownerId);

    if (!acquired) {
      return;
    }

    const runSlot = async (): Promise<void> => {
      while (!stopping) {
        await heartbeatBuildWorker(ownerId, state);
        await recoverStaleBuildJobs(state);

        busySlotCount += 1;
        let job: BuildJob | undefined;

        try {
          job = await claimQueuedBuildJob(state, ownerId);
        } finally {
          if (job === undefined) {
            busySlotCount -= 1;
          }
        }

        if (job === undefined) {
          if (busySlotCount === 0 && Date.now() - idleSince >= idleTimeoutMs) {
            break;
          }
          await delay(500);
          continue;
        }

        idleSince = Date.now();

        try {
          await executeClaimedBuildJob(job, ownerId, options);
        } finally {
          busySlotCount -= 1;
          if (busySlotCount === 0) {
            idleSince = Date.now();
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, async () => await runSlot()),
    );
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await releaseBuildWorkerLease(state, ownerId);
    await state.close();
  }
}

async function executeClaimedBuildJob(
  job: BuildJob,
  ownerId: string,
  options: BuildJobWorkerOptions,
): Promise<void> {
  const reporter = new BuildJobProgressAccumulator(job, ownerId, {
    appendBuildJobEvent,
    markBuildJobStep,
    readBuildJobForStopCheck,
  });
  const abortController = new AbortController();
  const stopWatcher = setInterval(() => {
    void abortJobWhenStopped(job, ownerId, abortController).catch(
      () => undefined,
    );
  }, 500);

  try {
    await appendBuildJobEvent(job, {
      at: Date.now(),
      jobId: job.jobId,
      seq: 0,
      state: "running",
      type: "started",
    });
    await options.executeJob(job, reporter, {
      signal: abortController.signal,
    });
    await reporter.throwIfStopped();
    await markBuildJobSucceeded(job.jobId, ownerId);
  } catch (error) {
    if (
      error instanceof BuildJobStoppedError ||
      abortController.signal.aborted
    ) {
      await markBuildJobStopped(job.jobId, ownerId);
      return;
    }

    await markBuildJobFailed(job.jobId, ownerId, error);
  } finally {
    clearInterval(stopWatcher);
  }
}

async function abortJobWhenStopped(
  job: BuildJob,
  ownerId: string,
  abortController: AbortController,
): Promise<void> {
  if (abortController.signal.aborted) {
    return;
  }

  const latest = await readBuildJobForStopCheck(job.jobId);

  if (latest.state === "running" && latest.ownerId === ownerId) {
    return;
  }

  abortController.abort(
    new BuildJobStoppedError(
      `Job ${job.jobId} is ${latest.state}. Stop current worker execution.`,
    ),
  );
}

export async function readBuildJobEvents(
  job: Pick<BuildJob, "eventsPath">,
): Promise<BuildJobEvent[]> {
  let content: string;

  try {
    content = await readFile(job.eventsPath, "utf8");
  } catch {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as BuildJobEvent);
}

export async function cleanBuildJobs(
  options: {
    readonly olderThanMs?: number;
    readonly states?: readonly BuildJobState[];
  } = {},
): Promise<number> {
  const state = await openBuildQueueDatabase();
  const cutoff = Date.now() - (options.olderThanMs ?? 7 * 24 * 60 * 60 * 1000);
  const states = options.states ?? ["succeeded", "failed", "canceled"];

  try {
    const placeholders = states.map(() => "?").join(", ");
    const jobs = await state.queryAll(
      `
SELECT *
FROM build_jobs
WHERE state IN (${placeholders})
  AND updated_at <= ?
`,
      [...states, cutoff],
      mapBuildJob,
    );

    for (const job of jobs) {
      await rm(job.workspacePath, { force: true, recursive: true });
      await rm(job.cachePath, { force: true, recursive: true });
      await rm(job.logPath, { force: true, recursive: true });
      await rm(job.eventsPath, { force: true });
      await state.run("DELETE FROM build_jobs WHERE job_id = ?", [job.jobId]);
    }

    return jobs.length;
  } finally {
    await state.close();
  }
}

export async function runBuildQueueGc(
  context: GcContext,
): Promise<GcJobResult> {
  const state = await openBuildQueueDatabase();
  const cutoff = context.force
    ? context.now
    : context.now - 7 * 24 * 60 * 60 * 1000;

  try {
    const scanned = await state.queryOne(
      "SELECT COUNT(*) AS count FROM build_jobs",
      undefined,
      (row) => getNumber(row, "count"),
    );
    const jobs = await state.queryAll(
      `
SELECT *
FROM build_jobs
WHERE state IN ('succeeded', 'failed', 'canceled')
  AND updated_at <= ?
`,
      [cutoff],
      mapBuildJob,
    );
    const childDirectories = context.dryRun
      ? { freedBytes: 0, removed: 0, scanned: 0 }
      : await removeDisposableChildDirectories(getBuildJobWorkspaceRootPath());
    let freedBytes = 0;

    for (const job of jobs) {
      freedBytes += await readPathSize(job.workspacePath);
      freedBytes += await readPathSize(job.cachePath);
      freedBytes += await readPathSize(job.logPath);
      freedBytes += await readPathSize(job.eventsPath);
      if (!context.dryRun) {
        await rm(job.workspacePath, { force: true, recursive: true });
        await rm(job.cachePath, { force: true, recursive: true });
        await rm(job.logPath, { force: true, recursive: true });
        await rm(job.eventsPath, { force: true });
        await state.run("DELETE FROM build_jobs WHERE job_id = ?", [job.jobId]);
      }
    }

    return {
      freedBytes: freedBytes + childDirectories.freedBytes,
      removed: jobs.length + childDirectories.removed,
      scanned: (scanned ?? 0) + childDirectories.scanned,
    };
  } finally {
    await state.close();
  }
}

async function updateBuildJobState(
  jobId: string,
  stateName: BuildJobState,
  eventType: Extract<BuildJobEvent["type"], "paused" | "resumed">,
  options: {
    readonly allowedStates: readonly BuildJobState[];
    readonly clearOwner?: boolean;
    readonly finished?: boolean;
  },
): Promise<BuildJob> {
  const state = await openBuildQueueDatabase();

  try {
    await recoverStaleBuildJobs(state);
    return await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (!options.allowedStates.includes(job.state)) {
        throw new Error(`Cannot ${eventType} ${job.state} job ${jobId}.`);
      }

      const now = Date.now();
      await state.run(
        `
UPDATE build_jobs
SET state = ?, updated_at = ?, finished_at = ?,
    owner_id = CASE WHEN ? = 1 THEN NULL ELSE owner_id END,
    owner_pid = CASE WHEN ? = 1 THEN NULL ELSE owner_pid END
WHERE job_id = ?
`,
        [
          stateName,
          now,
          options.finished === true ? now : null,
          options.clearOwner === true || options.finished === true ? 1 : 0,
          options.clearOwner === true || options.finished === true ? 1 : 0,
          jobId,
        ],
      );

      const updated = await requireBuildJobById(state, jobId);
      await appendBuildJobEvent(updated, {
        at: now,
        jobId,
        seq: 0,
        state: stateName as "queued" | "paused",
        type: eventType,
      } as BuildJobEvent);
      return updated;
    });
  } finally {
    await state.close();
  }
}

async function markBuildJobCanceling(
  state: Database,
  job: BuildJob,
): Promise<BuildJob> {
  const now = Date.now();

  await state.run(
    `
UPDATE build_jobs
SET state = 'canceling', updated_at = ?
WHERE job_id = ? AND state = 'running'
`,
    [now, job.jobId],
  );

  const updated = await requireBuildJobById(state, job.jobId);
  await appendBuildJobEvent(updated, {
    at: now,
    jobId: job.jobId,
    seq: 0,
    state: "canceling",
    type: "canceling",
  });
  return updated;
}

async function markBuildJobCanceled(
  state: Database,
  job: BuildJob,
): Promise<BuildJob> {
  const now = Date.now();

  await state.run(
    `
UPDATE build_jobs
SET state = 'canceled', owner_id = NULL, owner_pid = NULL,
    current_step = NULL, finished_at = ?, updated_at = ?
WHERE job_id = ?
`,
    [now, now, job.jobId],
  );

  const updated = await requireBuildJobById(state, job.jobId);
  await appendBuildJobEvent(updated, {
    at: now,
    jobId: job.jobId,
    seq: 0,
    state: "canceled",
    type: "canceled",
  });
  return updated;
}

async function markBuildJobFailedInState(
  state: Database,
  job: BuildJob,
  error: unknown,
): Promise<void> {
  const now = Date.now();
  const formattedError = formatErrorEvent(error);
  const errorJSON = JSON.stringify(formattedError);

  await state.run(
    `
UPDATE build_jobs
SET state = 'failed', owner_id = NULL, owner_pid = NULL,
    current_step = NULL, finished_at = ?, updated_at = ?, error_json = ?
WHERE job_id = ?
`,
    [now, now, errorJSON, job.jobId],
  );
  await appendBuildJobEvent(job, {
    at: now,
    error: formattedError,
    jobId: job.jobId,
    seq: 0,
    state: "failed",
    type: "failed",
  });
}

async function markBuildJobSucceeded(
  jobId: string,
  ownerId: string,
): Promise<void> {
  const state = await openBuildQueueDatabase();

  try {
    await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (job.ownerId !== ownerId || job.state !== "running") {
        return;
      }

      const now = Date.now();
      await state.run(
        `
UPDATE build_jobs
SET state = 'succeeded', owner_id = NULL, owner_pid = NULL,
    current_step = NULL, finished_at = ?, updated_at = ?
WHERE job_id = ?
`,
        [now, now, jobId],
      );
      await appendBuildJobEvent(job, {
        at: now,
        jobId,
        seq: 0,
        state: "succeeded",
        type: "succeeded",
      });
      await rm(job.workspacePath, { force: true, recursive: true });
    });
  } finally {
    await state.close();
  }
}

async function markBuildJobFailed(
  jobId: string,
  ownerId: string,
  error: unknown,
): Promise<void> {
  const state = await openBuildQueueDatabase();

  try {
    await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (job.ownerId !== ownerId || job.state !== "running") {
        return;
      }

      await markBuildJobFailedInState(state, job, error);
    });
  } finally {
    await state.close();
  }
}

async function markBuildJobStopped(
  jobId: string,
  ownerId: string,
): Promise<void> {
  const state = await openBuildQueueDatabase();

  try {
    await state.transaction(async () => {
      const job = await requireBuildJobById(state, jobId);

      if (job.ownerId !== ownerId || job.state !== "canceling") {
        return;
      }

      await markBuildJobCanceled(state, job);
    });
  } finally {
    await state.close();
  }
}

async function claimQueuedBuildJob(
  state: Database,
  ownerId: string,
): Promise<BuildJob | undefined> {
  return await state.transaction(async () => {
    const job = await state.queryOne(
      `
SELECT *
FROM build_jobs
WHERE state = 'queued'
ORDER BY queue_rank ASC, created_at ASC
LIMIT 1
`,
      undefined,
      mapBuildJob,
    );

    if (job === undefined) {
      return undefined;
    }

    const now = Date.now();
    await state.run(
      `
UPDATE build_jobs
SET state = 'running', owner_id = ?, owner_pid = ?, updated_at = ?
WHERE job_id = ? AND state = 'queued'
`,
      [ownerId, process.pid, now, job.jobId],
    );

    return await requireBuildJobById(state, job.jobId);
  });
}

async function recoverStaleBuildJobs(state: Database): Promise<void> {
  const workspacePathsToDelete: string[] = [];

  await state.transaction(async () => {
    const jobs = await state.queryAll(
      `
SELECT *
FROM build_jobs
WHERE state IN ('running', 'canceling')
  AND owner_pid IS NOT NULL
`,
      undefined,
      mapBuildJob,
    );

    for (const job of jobs) {
      if (job.ownerPid !== undefined && isProcessAlive(job.ownerPid)) {
        continue;
      }

      if (job.state === "canceling") {
        await markBuildJobCanceled(state, job);
        continue;
      }

      await markBuildJobFailedInState(state, job, {
        message: "Build worker process disappeared before finishing the job.",
        name: "BuildJobWorkerLost",
      });
      workspacePathsToDelete.push(job.workspacePath);
    }
  });

  for (const workspacePath of workspacePathsToDelete) {
    await rm(workspacePath, { force: true, recursive: true });
  }
}

async function acquireBuildWorkerLease(
  state: Database,
  ownerId: string,
): Promise<boolean> {
  await recoverStaleBuildWorkerLease(state);

  return await state.transaction(async () => {
    const lease = await state.queryOne(
      `
SELECT owner_pid
FROM build_worker_lease
WHERE id = 1
`,
      undefined,
      (row) => ({
        ownerPid:
          row.owner_pid === null ? undefined : getNumber(row, "owner_pid"),
      }),
    );

    if (lease?.ownerPid !== undefined && isProcessAlive(lease.ownerPid)) {
      return false;
    }

    await state.run(
      `
UPDATE build_worker_lease
SET owner_id = ?, owner_pid = ?, heartbeat_at = ?
WHERE id = 1
`,
      [ownerId, process.pid, Date.now()],
    );
    return true;
  });
}

async function heartbeatBuildWorker(
  ownerId: string,
  existingState?: Database,
): Promise<void> {
  const state = existingState ?? (await openBuildQueueDatabase());

  try {
    await state.run(
      `
UPDATE build_worker_lease
SET heartbeat_at = ?
WHERE id = 1 AND owner_id = ?
`,
      [Date.now(), ownerId],
    );
  } finally {
    if (existingState === undefined) {
      await state.close();
    }
  }
}

async function releaseBuildWorkerLease(
  state: Database,
  ownerId: string,
): Promise<void> {
  await state.run(
    `
UPDATE build_worker_lease
SET owner_id = NULL, owner_pid = NULL, heartbeat_at = NULL
WHERE id = 1 AND owner_id = ?
`,
    [ownerId],
  );
}

async function recoverStaleBuildWorkerLease(state: Database): Promise<void> {
  const lease = await state.queryOne(
    `
SELECT owner_id, owner_pid
FROM build_worker_lease
WHERE id = 1
`,
    undefined,
    (row) => ({
      ownerId: getOptionalString(row, "owner_id"),
      ownerPid:
        row.owner_pid === null ? undefined : getNumber(row, "owner_pid"),
    }),
  );

  if (lease?.ownerPid === undefined || isProcessAlive(lease.ownerPid)) {
    return;
  }

  await state.run(
    `
UPDATE build_worker_lease
SET owner_id = NULL, owner_pid = NULL, heartbeat_at = NULL
WHERE id = 1
`,
  );
}

async function requireBuildJobById(
  state: Database,
  jobId: string,
): Promise<BuildJob> {
  const job = await state.queryOne(
    "SELECT * FROM build_jobs WHERE job_id = ?",
    [jobId],
    mapBuildJob,
  );

  if (job === undefined) {
    throw new Error(`Build job not found: ${jobId}`);
  }

  return job;
}

async function resolveBuildJobIdInState(
  state: Database,
  jobIdPrefix: string,
): Promise<string> {
  const normalizedPrefix = jobIdPrefix.trim();

  if (normalizedPrefix === "") {
    throw new Error("Build job id is empty.");
  }

  const jobs = await state.queryAll(
    `
SELECT job_id
FROM build_jobs
WHERE substr(job_id, 1, ?) = ?
ORDER BY created_at DESC
`,
    [normalizedPrefix.length, normalizedPrefix],
    (row) => getString(row, "job_id"),
  );

  if (jobs.length === 0) {
    throw new Error(`Build job not found: ${jobIdPrefix}`);
  }
  if (jobs.length > 1) {
    throw new Error(
      `Build job id prefix is ambiguous: ${jobIdPrefix}. Matches: ${jobs.join(
        ", ",
      )}`,
    );
  }

  return jobs[0]!;
}

async function appendBuildJobEvent(
  job: Pick<BuildJob, "eventsPath" | "jobId">,
  event: BuildJobEvent,
): Promise<void> {
  const seq = (await readLastBuildJobEventSeq(job)) + 1;
  const nextEvent = {
    ...event,
    jobId: job.jobId,
    seq,
  };

  await appendFile(job.eventsPath, `${JSON.stringify(nextEvent)}\n`, "utf8");
}

async function readLastBuildJobEventSeq(
  job: Pick<BuildJob, "eventsPath">,
): Promise<number> {
  const events = await readBuildJobEvents(job);

  return events.at(-1)?.seq ?? 0;
}

async function readMaxQueueRank(state: Database): Promise<number> {
  return (
    (await state.queryOne(
      "SELECT COALESCE(MAX(queue_rank), 0) AS rank FROM build_jobs",
      undefined,
      (row) => getNumber(row, "rank"),
    )) ?? 0
  );
}

async function readMinQueueRank(state: Database): Promise<number> {
  return (
    (await state.queryOne(
      "SELECT COALESCE(MIN(queue_rank), 0) AS rank FROM build_jobs",
      undefined,
      (row) => getNumber(row, "rank"),
    )) ?? 0
  );
}

async function openBuildQueueDatabase(): Promise<Database> {
  return await openSharedStateDatabase(
    getBuildQueueDatabasePath(),
    BUILD_QUEUE_SCHEMA_SQL,
  );
}

async function openReadonlyBuildQueueDatabase(): Promise<Database> {
  return await openBuildQueueDatabase();
}

async function markBuildJobStep(
  jobId: string,
  step: BuildJobTarget,
): Promise<void> {
  const state = await openBuildQueueDatabase();

  try {
    await state.run(
      `
UPDATE build_jobs
SET current_step = ?,
    reading_summary_started_at = CASE
      WHEN ? = 'reading-summary' AND reading_summary_started_at IS NULL THEN ?
      ELSE reading_summary_started_at
    END,
    updated_at = ?
WHERE job_id = ?
`,
      [step, step, Date.now(), Date.now(), jobId],
    );
  } finally {
    await state.close();
  }
}
