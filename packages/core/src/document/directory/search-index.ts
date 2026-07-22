import { join } from "path";

import { Database } from "../database.js";
import { SEARCH_INDEX_SCHEMA_SQL } from "../schema.js";
import type { DocumentFileStore } from "./types.js";

export async function openSearchIndexDatabase<T>(input: {
  readonly documentPath: string;
  readonly fileStore: DocumentFileStore;
  readonly operation: (database: Database) => Promise<T> | T;
  readonly readonly: boolean;
}): Promise<T> {
  const databasePath =
    input.fileStore.resolveSearchIndexDatabasePath === undefined
      ? join(input.documentPath, "fts.db")
      : await input.fileStore.resolveSearchIndexDatabasePath(
          input.documentPath,
        );
  const database = await Database.open(
    databasePath,
    input.readonly ? "" : SEARCH_INDEX_SCHEMA_SQL,
    {
      onWrite: () => {
        input.fileStore.markSearchIndexDatabaseDirty?.();
      },
      readonly: input.readonly,
    },
  );

  if (!input.readonly) {
    await migrateSearchIndexSchema(database);
  }

  try {
    return await input.operation(database);
  } finally {
    await database.close();
  }
}

async function migrateSearchIndexSchema(database: Database): Promise<void> {
  await ensureColumn(
    database,
    "text_sentence_records",
    "archive_id",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    database,
    "search_object_properties_records",
    "archive_id",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await database.run(`
    CREATE TABLE IF NOT EXISTS index_dirty_chapters (
      archive_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (archive_id, chapter_id)
    )
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_text_sentence_records_archive_chapter
    ON text_sentence_records(archive_id, kind, chapter_id, sentence_index)
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_search_object_properties_records_archive_owner
    ON search_object_properties_records(archive_id, owner_kind, owner_id)
  `);
  await database.run(`
    CREATE INDEX IF NOT EXISTS idx_search_object_properties_records_archive_chapter
    ON search_object_properties_records(
      archive_id,
      chapter_id,
      owner_kind,
      owner_id
    )
  `);
}

async function ensureColumn(
  database: Database,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await database.queryAll(
    `PRAGMA table_info(${table})`,
    undefined,
    (row) => String(row.name),
  );

  if (columns.includes(column)) {
    return;
  }

  await database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
