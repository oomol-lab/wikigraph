import { randomBytes } from "crypto";
import {
  constants,
  copyFile,
  mkdir,
  opendir,
  realpath,
  rename,
  rm,
  stat,
} from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";

import {
  getNumber,
  getString,
  type Database,
  type SqlRow,
} from "../document/database.js";
import { openSharedStateDatabase } from "../document/index.js";
import { resolveWikiGraphCoreDatabasePath } from "../runtime/common/wiki-graph/dir.js";
import { WIKI_GRAPH_ARCHIVE_EXTENSION } from "../runtime/common/wiki-graph/uri.js";
import { isNodeError } from "../utils/node-error.js";
import {
  resolveWikiGraphLibrary,
  type ParsedWikiGraphLibraryUri,
  type WikiGraphLibraryRecord,
} from "./registry.js";

const PUBLIC_ID_BYTES = 6;
const LIBRARY_ARCHIVE_MEMBERSHIP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS library_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    public_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(library_id, public_id),
    UNIQUE(library_id, relative_path)
  );

  CREATE INDEX IF NOT EXISTS idx_library_archives_library
  ON library_archives(library_id);
`;

export interface WikiGraphLibraryArchiveRecord {
  readonly id: number;
  readonly publicId: string;
  readonly uri: string;
  readonly libraryId: number;
  readonly libraryUri: string;
  readonly relativePath: string;
  readonly path: string;
  readonly exists: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiGraphLibraryScanResult {
  readonly library: WikiGraphLibraryRecord;
  readonly archives: readonly WikiGraphLibraryArchiveRecord[];
}

export async function scanWikiGraphLibrary(
  target: ParsedWikiGraphLibraryUri,
): Promise<WikiGraphLibraryScanResult> {
  const library = await resolveWikiGraphLibrary(target);
  const files = await listWikgFiles(library.folderPath);

  await withLibraryArchiveMembershipDatabase(async (database) => {
    await database.transaction(async () => {
      for (const relativePath of files) {
        await ensureLibraryArchiveByRelativePath(
          database,
          library.id,
          relativePath,
        );
      }
    });
  });

  return { library, archives: await listWikiGraphLibraryArchives(target) };
}

export async function listWikiGraphLibraryArchives(
  target: ParsedWikiGraphLibraryUri,
): Promise<readonly WikiGraphLibraryArchiveRecord[]> {
  const library = await resolveWikiGraphLibrary(target);
  return await withLibraryArchiveMembershipDatabase(
    async (database) => await listLibraryArchives(database, library),
  );
}

export async function addWikiGraphLibraryArchive(input: {
  readonly target: ParsedWikiGraphLibraryUri;
  readonly inputPath: string;
  readonly to?: string;
}): Promise<WikiGraphLibraryArchiveRecord> {
  if (input.inputPath.startsWith("wikg://")) {
    throw new Error(
      "Library add --input accepts a file path, not a Wiki Graph URI.",
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(input.inputPath)) {
    throw new Error("Library add does not support URL inputs yet.");
  }

  const library = await resolveWikiGraphLibrary(input.target);
  await mkdir(library.folderPath, { recursive: true });
  const sourcePath = resolve(input.inputPath);
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error(`Library add --input must be a file: ${input.inputPath}`);
  }
  const sourceBasename = sourcePath.split(/[\\/]/u).at(-1) ?? "";
  const targetRelativePath = validateLibraryArchiveRelativePath(
    input.to ?? sourceBasename,
  );
  const targetPath = resolveLibraryRelativePath(
    library.folderPath,
    targetRelativePath,
  );

  await mkdir(dirname(targetPath), { recursive: true });
  await assertInsideLibrary(
    await realpath(dirname(targetPath)),
    library.folderPath,
  );
  await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  await assertInsideLibrary(await realpath(targetPath), library.folderPath);

  return await withLibraryArchiveMembershipDatabase(async (database) => {
    await database.transaction(async () => {
      await ensureLibraryArchiveByRelativePath(
        database,
        library.id,
        targetRelativePath,
      );
    });
    return await requireLibraryArchiveByRelativePath(
      database,
      library,
      targetRelativePath,
    );
  });
}

export async function removeWikiGraphLibraryArchive(input: {
  readonly target: ParsedWikiGraphLibraryUri;
}): Promise<WikiGraphLibraryArchiveRecord> {
  const library = await resolveWikiGraphLibrary(input.target);
  const archive = await resolveLibraryArchiveTarget(input.target, library);

  await rm(archive.path, { force: true });
  await withLibraryArchiveMembershipDatabase(async (database) => {
    await database.run("DELETE FROM library_archives WHERE id = ?", [
      archive.id,
    ]);
  });

  return archive;
}

export async function moveWikiGraphLibraryArchive(input: {
  readonly target: ParsedWikiGraphLibraryUri;
  readonly to: string;
}): Promise<WikiGraphLibraryArchiveRecord> {
  const library = await resolveWikiGraphLibrary(input.target);
  const archive = await resolveLibraryArchiveTarget(input.target, library);
  const targetRelativePath = validateLibraryArchiveRelativePath(input.to);
  const targetPath = resolveLibraryRelativePath(
    library.folderPath,
    targetRelativePath,
  );

  await mkdir(dirname(targetPath), { recursive: true });
  await assertInsideLibrary(
    await realpath(dirname(targetPath)),
    library.folderPath,
  );
  if (await pathExists(targetPath)) {
    throw new Error(
      `Library archive target already exists: ${targetRelativePath}`,
    );
  }
  await rename(archive.path, targetPath);
  await assertInsideLibrary(await realpath(targetPath), library.folderPath);

  return await withLibraryArchiveMembershipDatabase(async (database) => {
    await database.run(
      "UPDATE library_archives SET relative_path = ?, updated_at = ? WHERE id = ?",
      [targetRelativePath, new Date().toISOString(), archive.id],
    );
    return await requireLibraryArchiveByPublicId(
      database,
      library,
      archive.publicId,
    );
  });
}

async function withLibraryArchiveMembershipDatabase<T>(
  operation: (database: Database) => Promise<T>,
): Promise<T> {
  const database = await openSharedStateDatabase(
    resolveWikiGraphCoreDatabasePath(),
    LIBRARY_ARCHIVE_MEMBERSHIP_SCHEMA_SQL,
  );

  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

async function listLibraryArchives(
  database: Database,
  library: WikiGraphLibraryRecord,
): Promise<WikiGraphLibraryArchiveRecord[]> {
  const rows = await database.queryAll(
    `
      SELECT id, public_id, relative_path, created_at, updated_at
      FROM library_archives
      WHERE library_id = ?
      ORDER BY relative_path
    `,
    [library.id],
    (row) => row,
  );
  const archives: WikiGraphLibraryArchiveRecord[] = [];
  for (const row of rows) {
    const relativePath = getString(row, "relative_path");
    archives.push(
      mapLibraryArchiveRecord(
        library,
        row,
        await pathExists(join(library.folderPath, relativePath)),
      ),
    );
  }
  return archives;
}

async function ensureLibraryArchiveByRelativePath(
  database: Database,
  libraryId: number,
  relativePath: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await database.queryOne(
    "SELECT id FROM library_archives WHERE library_id = ? AND relative_path = ?",
    [libraryId, relativePath],
    (row) => getNumber(row, "id"),
  );
  if (existing !== undefined) {
    await database.run(
      "UPDATE library_archives SET updated_at = ? WHERE id = ?",
      [now, existing],
    );
    return;
  }

  await database.run(
    `
      INSERT INTO library_archives (library_id, public_id, relative_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [
      libraryId,
      await createUniqueLibraryArchivePublicId(database, libraryId),
      relativePath,
      now,
      now,
    ],
  );
}

async function requireLibraryArchiveByRelativePath(
  database: Database,
  library: WikiGraphLibraryRecord,
  relativePath: string,
): Promise<WikiGraphLibraryArchiveRecord> {
  const archive = await database.queryOne(
    `
      SELECT id, public_id, relative_path, created_at, updated_at
      FROM library_archives
      WHERE library_id = ? AND relative_path = ?
    `,
    [library.id, relativePath],
    (row) => mapLibraryArchiveRecord(library, row, true),
  );
  if (archive === undefined) {
    throw new Error(
      `Library archive registry record is missing: ${relativePath}`,
    );
  }
  return archive;
}

async function requireLibraryArchiveByPublicId(
  database: Database,
  library: WikiGraphLibraryRecord,
  publicId: string,
): Promise<WikiGraphLibraryArchiveRecord> {
  const archive = await database.queryOne(
    `
      SELECT id, public_id, relative_path, created_at, updated_at
      FROM library_archives
      WHERE library_id = ? AND public_id = ?
    `,
    [library.id, publicId],
    (row) => mapLibraryArchiveRecord(library, row, false),
  );
  if (archive === undefined) {
    throw new Error(`Unknown Wiki Graph library archive: ${publicId}`);
  }
  return {
    ...archive,
    exists: await pathExists(archive.path),
  };
}

async function resolveLibraryArchiveTarget(
  target: ParsedWikiGraphLibraryUri,
  library: WikiGraphLibraryRecord,
): Promise<WikiGraphLibraryArchiveRecord> {
  if (target.kind !== "archive" || target.archivePublicId === undefined) {
    throw new Error("Expected a Wiki Graph library archive URI.");
  }
  return await withLibraryArchiveMembershipDatabase(
    async (database) =>
      await requireLibraryArchiveByPublicId(
        database,
        library,
        target.archivePublicId!,
      ),
  );
}

function mapLibraryArchiveRecord(
  library: WikiGraphLibraryRecord,
  row: SqlRow,
  exists: boolean,
): WikiGraphLibraryArchiveRecord {
  const publicId = getString(row, "public_id");
  const relativePath = getString(row, "relative_path");
  return {
    createdAt: getString(row, "created_at"),
    exists,
    id: getNumber(row, "id"),
    libraryId: library.id,
    libraryUri: library.uri,
    path: join(library.folderPath, relativePath),
    publicId,
    relativePath,
    updatedAt: getString(row, "updated_at"),
    uri: `${library.uri}/${publicId}`,
  };
}

async function listWikgFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkLibraryDirectory(root, root, files);
  return files.sort((a, b) => a.localeCompare(b));
}

async function walkLibraryDirectory(
  root: string,
  directory: string,
  files: string[],
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkLibraryDirectory(root, path, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(WIKI_GRAPH_ARCHIVE_EXTENSION)
    ) {
      files.push(relative(root, path).replace(/\\/gu, "/"));
    }
  }
}

function validateLibraryArchiveRelativePath(relativePath: string): string {
  const normalized = relativePath
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
  if (
    normalized === "" ||
    isAbsolute(relativePath) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(
      "Library archive target must be a relative path inside the library folder.",
    );
  }
  if (!normalized.endsWith(WIKI_GRAPH_ARCHIVE_EXTENSION)) {
    throw new Error("Library archive target must end with .wikg.");
  }
  return normalized;
}

function resolveLibraryRelativePath(
  root: string,
  relativePath: string,
): string {
  const path = resolve(root, relativePath);
  const rel = relative(resolve(root), path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Library archive target escapes the library folder.");
  }
  return path;
}

async function assertInsideLibrary(path: string, root: string): Promise<void> {
  const rootRealPath = await realpath(root);
  const rel = relative(rootRealPath, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Library archive path escapes the library folder.");
  }
}

async function createUniqueLibraryArchivePublicId(
  database: Database,
  libraryId: number,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const publicId = randomBytes(PUBLIC_ID_BYTES).toString("hex");
    const existing = await database.queryOne(
      "SELECT public_id FROM library_archives WHERE library_id = ? AND public_id = ?",
      [libraryId, publicId],
      (row) => getString(row, "public_id"),
    );
    if (existing === undefined) {
      return publicId;
    }
  }
  throw new Error("Could not generate a unique library archive id.");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
