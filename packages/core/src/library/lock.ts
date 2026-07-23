import { randomUUID } from "crypto";

import { openSharedStateDatabase, type Database } from "../document/index.js";
import { getNumber, getString } from "../document/database.js";
import { resolveWikiGraphCoreDatabasePath } from "../runtime/common/wiki-graph/dir.js";

const LIBRARY_LOCK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS library_locks (
    library_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export type LibraryLockMode = "read" | "write";

export async function withWikiGraphLibraryLock<T>(
  libraryId: number,
  mode: LibraryLockMode,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireWikiGraphLibraryLock(libraryId, mode);

  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function acquireWikiGraphLibraryLock(
  libraryId: number,
  mode: LibraryLockMode,
): Promise<() => Promise<void>> {
  const ownerId = `${process.pid}-${randomUUID()}`;
  const database = await openLibraryLockDatabase();

  try {
    await database.transaction(async () => {
      const existing = await database.queryOne(
        "SELECT mode, owner_id FROM library_locks WHERE library_id = ?",
        [libraryId],
        (row) => ({
          mode: getString(row, "mode"),
          ownerId: getString(row, "owner_id"),
        }),
      );

      if (existing !== undefined) {
        throw new Error(
          `Wiki Graph library is locked for ${existing.mode}: ${libraryId}.`,
        );
      }

      await database.run(
        `
          INSERT INTO library_locks (
            library_id, mode, owner_id, owner_pid, created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        [libraryId, mode, ownerId, process.pid, Date.now()],
      );
    });
  } finally {
    await database.close();
  }

  return async () => {
    const releaseDatabase = await openLibraryLockDatabase();

    try {
      await releaseDatabase.run(
        "DELETE FROM library_locks WHERE library_id = ? AND owner_id = ?",
        [libraryId, ownerId],
      );
    } finally {
      await releaseDatabase.close();
    }
  };
}

export async function isWikiGraphLibraryLocked(
  libraryId: number,
): Promise<boolean> {
  return await withLibraryLockDatabase(async (database) => {
    const found = await database.queryOne(
      "SELECT 1 AS found FROM library_locks WHERE library_id = ?",
      [libraryId],
      (row) => getNumber(row, "found"),
    );

    return found === 1;
  });
}

async function withLibraryLockDatabase<T>(
  operation: (database: Database) => Promise<T>,
): Promise<T> {
  const database = await openLibraryLockDatabase();

  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

async function openLibraryLockDatabase(): Promise<Database> {
  return await openSharedStateDatabase(
    resolveWikiGraphCoreDatabasePath(),
    LIBRARY_LOCK_SCHEMA_SQL,
  );
}
