import {
  markWikiGraphLibraryIndexDirty,
  WikiGraphArchiveFile,
  type DirectoryDocument,
  type ReadonlyDocument,
} from "wiki-graph-core";

import { resolveArchiveRuntimeLocation } from "./uri.js";

export async function readArchiveDocument<T>(
  path: string,
  operation: (document: ReadonlyDocument) => Promise<T> | T,
): Promise<void> {
  const location = await resolveArchiveRuntimeLocation(path);
  await new WikiGraphArchiveFile(location.archivePath).readDocument(operation);
}

export async function writeArchiveDocument<T>(
  path: string,
  operation: (document: DirectoryDocument) => Promise<T> | T,
  options: Parameters<WikiGraphArchiveFile["write"]>[1] = {},
): Promise<T> {
  const location = await resolveArchiveRuntimeLocation(path);
  const result = await new WikiGraphArchiveFile(location.archivePath).write(
    operation,
    options,
  );

  if (location.libraryDirtyTarget !== undefined) {
    await markWikiGraphLibraryIndexDirty(location.libraryDirtyTarget);
  }

  return result;
}
