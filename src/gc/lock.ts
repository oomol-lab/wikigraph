import { randomUUID } from "crypto";
import { join } from "path";

import { resolveWikiGraphStateRootPath } from "../common/wiki-graph-temp.js";
import { getNumber, getString, type SqlRow } from "../document/database.js";
import { openSharedStateDatabase } from "../document/index.js";
import type { Database } from "../document/index.js";
import { isNodeError } from "../utils/node-error.js";

const GC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gc_locks (
  scope TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const GC_LOCK_STALE_TIMEOUT_MS = 60_000;
const GC_HEARTBEAT_INTERVAL_MS = 20_000;

interface GcLock {
  readonly createdAt: number;
  readonly heartbeatAt: number;
  readonly ownerId: string;
  readonly ownerPid: number;
}

export async function tryAcquireGcLock(
  scope = "global",
): Promise<(() => Promise<void>) | undefined> {
  const database = await openGcStateDatabase();
  const ownerId = `${process.pid}-${randomUUID()}`;
  const now = Date.now();

  try {
    await cleanupStaleGcLocks(database);
    const existing = await database.queryOne(
      "SELECT * FROM gc_locks WHERE scope = ?",
      [scope],
      mapGcLock,
    );

    if (existing !== undefined) {
      return undefined;
    }

    await database.run(
      `
INSERT INTO gc_locks (
  scope, owner_id, owner_pid, heartbeat_at, created_at
) VALUES (?, ?, ?, ?, ?)
`,
      [scope, ownerId, process.pid, now, now],
    );
  } finally {
    await database.close();
  }

  const heartbeat = setInterval(() => {
    void heartbeatGcLock(scope, ownerId).catch(() => undefined);
  }, GC_HEARTBEAT_INTERVAL_MS);

  return async () => {
    clearInterval(heartbeat);
    const releaseDatabase = await openGcStateDatabase();

    try {
      await releaseDatabase.run(
        "DELETE FROM gc_locks WHERE scope = ? AND owner_id = ?",
        [scope, ownerId],
      );
    } finally {
      await releaseDatabase.close();
    }
  };
}

async function heartbeatGcLock(scope: string, ownerId: string): Promise<void> {
  const database = await openGcStateDatabase();

  try {
    await database.run(
      `
UPDATE gc_locks
SET heartbeat_at = ?, owner_pid = ?
WHERE scope = ? AND owner_id = ?
`,
      [Date.now(), process.pid, scope, ownerId],
    );
  } finally {
    await database.close();
  }
}

async function cleanupStaleGcLocks(database: Database): Promise<void> {
  const locks = await database.queryAll(
    "SELECT * FROM gc_locks",
    undefined,
    mapGcLockWithScope,
  );
  const staleScopes = locks
    .filter(({ lock }) => isStaleGcLock(lock))
    .map(({ scope }) => scope);

  for (const scope of staleScopes) {
    await database.run("DELETE FROM gc_locks WHERE scope = ?", [scope]);
  }
}

function isStaleGcLock(lock: GcLock): boolean {
  if (Date.now() - lock.heartbeatAt < GC_LOCK_STALE_TIMEOUT_MS) {
    return false;
  }

  return !isProcessAlive(lock.ownerPid);
}

async function openGcStateDatabase(): Promise<Database> {
  return await openSharedStateDatabase(
    join(resolveWikiGraphStateRootPath(), "gc.sqlite"),
    GC_SCHEMA_SQL,
  );
}

function mapGcLock(row: SqlRow): GcLock {
  return {
    createdAt: getNumber(row, "created_at"),
    heartbeatAt: getNumber(row, "heartbeat_at"),
    ownerId: getString(row, "owner_id"),
    ownerPid: getNumber(row, "owner_pid"),
  };
}

function mapGcLockWithScope(row: SqlRow): {
  readonly lock: GcLock;
  readonly scope: string;
} {
  return {
    lock: mapGcLock(row),
    scope: getString(row, "scope"),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }

    return true;
  }
}
