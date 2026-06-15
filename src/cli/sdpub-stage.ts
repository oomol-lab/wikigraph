import {
  advanceChapterStages,
  listChapters,
  type AdvanceChapterStagesProgressEvent,
  type AdvanceChapterStagesResult,
  type ChapterEntry,
} from "../facade/index.js";
import { SpineDigestFile } from "../facade/spine-digest-file.js";

import type { CLISdpubStageArguments } from "./args.js";
import { writeTextToStderr, writeTextToStdout } from "./io.js";
import {
  createStageLLM,
  loadRequiredStageConfig,
  resolveExtractionPrompt,
} from "./stage-runtime.js";

export async function runSdpubStageCommand(
  args: CLISdpubStageArguments,
): Promise<void> {
  switch (args.action) {
    case "pending":
      await new SpineDigestFile(args.path).openEditableSession(
        async (document) => {
          await writePendingChapters(await listChapters(document));
        },
      );
      return;
    case "advance":
      await new SpineDigestFile(args.path).openEditableSession(
        async (document) => {
          const targetStage = args.targetStage ?? "summarized";

          if (targetStage === "planned") {
            await writeAdvanceResult({
              advanced: [],
              pending: [],
              skipped: [],
            });
            return;
          }

          const config = await loadRequiredStageConfig(args);
          const progressWriter = createStageAdvanceProgressWriter();
          let result: AdvanceChapterStagesResult;

          try {
            result = await advanceChapterStages(document, {
              ...(args.chapterId === undefined
                ? {}
                : { chapterId: args.chapterId }),
              extractionPrompt: resolveExtractionPrompt(
                args.prompt ?? config.prompt,
              ),
              llm: createStageLLM(config),
              onProgress: progressWriter.onProgress,
              targetStage,
            });
          } finally {
            await progressWriter.stop();
          }

          await writeAdvanceResult(result);
        },
      );
      return;
  }
}

function createStageAdvanceProgressWriter(input?: {
  readonly heartbeatIntervalMs?: number;
}): {
  readonly onProgress: (
    event: AdvanceChapterStagesProgressEvent,
  ) => Promise<void>;
  stop(): Promise<void>;
} {
  const heartbeatIntervalMs = input?.heartbeatIntervalMs ?? 15_000;
  let heartbeat: NodeJS.Timeout | undefined;
  let activeLabel: string | undefined;
  let writeQueue = Promise.resolve();

  const writeLine = async (line: string): Promise<void> => {
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        await writeTextToStderr(`${line}\n`);
      });
    await writeQueue;
  };

  const clearHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const startHeartbeat = (label: string): void => {
    clearHeartbeat();
    activeLabel = label;
    heartbeat = setInterval(() => {
      const currentLabel = activeLabel;

      if (currentLabel === undefined) {
        return;
      }

      void writeLine(`Still ${currentLabel.toLowerCase()}...`);
    }, heartbeatIntervalMs);
    heartbeat.unref();
  };

  return {
    async onProgress(event) {
      switch (event.type) {
        case "selected":
          await writeLine(
            `Selected ${event.totalChapters} ${event.totalChapters === 1 ? "chapter" : "chapters"}; target: ${event.targetStage}.`,
          );
          return;
        case "skipped":
          await writeLine(
            `Skipping ${formatProgressChapter(event.chapter)}: source is missing.`,
          );
          return;
        case "started": {
          const label = `${formatProgressVerb(event.step)} for ${formatProgressChapter(event.chapter)}`;
          startHeartbeat(label);
          await writeLine(`${label}...`);
          return;
        }
        case "completed":
          clearHeartbeat();
          activeLabel = undefined;
          await writeLine(
            `Finished ${formatProgressStep(event.step)} for ${formatProgressChapter(event.chapter)}.`,
          );
          return;
      }
    },
    async stop() {
      clearHeartbeat();
      activeLabel = undefined;
      await writeQueue.catch(() => undefined);
    },
  };
}

async function writePendingChapters(
  entries: readonly ChapterEntry[],
): Promise<void> {
  const pending = entries.filter((entry) => entry.stage !== "summarized");

  if (pending.length === 0) {
    await writeTextToStdout("No pending chapters.\n");
    return;
  }

  await writeTextToStdout(`${pending.map(formatChapterEntry).join("\n")}\n`);
}

async function writeAdvanceResult(
  result: AdvanceChapterStagesResult,
): Promise<void> {
  const lines = [
    `Advanced: ${result.advanced.length}`,
    `Pending: ${result.pending.length}`,
    `Skipped: ${result.skipped.length}`,
  ];

  if (result.pending.length > 0) {
    lines.push("", "Pending chapters:");
    lines.push(...result.pending.map(formatChapterEntry));
  }
  if (result.skipped.some((entry) => entry.stage === "planned")) {
    lines.push(
      "",
      "Next: set source for planned chapters, then advance again.",
      "Example: spinedigest sdpub chapter set-source <path> --chapter <id> --input <file> --input-format txt",
    );
  }

  await writeTextToStdout(`${lines.join("\n")}\n`);
}

function formatChapterEntry(entry: ChapterEntry): string {
  return `[${entry.chapterId}] ${entry.stage.padEnd(10)} ${formatTocPath(entry)}`;
}

function formatTocPath(entry: ChapterEntry): string {
  if (entry.tocPath.length === 0) {
    return entry.title ?? "[untitled]";
  }

  return entry.tocPath.join(" / ");
}

function formatProgressChapter(entry: ChapterEntry): string {
  return `chapter ${entry.chapterId} (${formatTocPath(entry)})`;
}

function formatProgressVerb(step: "graph" | "summary"): string {
  switch (step) {
    case "graph":
      return "Generating graph";
    case "summary":
      return "Generating summary";
  }
}

function formatProgressStep(step: "graph" | "summary"): string {
  switch (step) {
    case "graph":
      return "graph";
    case "summary":
      return "summary";
  }
}
