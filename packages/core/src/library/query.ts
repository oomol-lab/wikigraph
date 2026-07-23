import { WikiGraphArchiveFile } from "../storage/wikg/index.js";
import type { ReadonlyDocument } from "../document/index.js";
import {
  listArchiveCollection,
  listArchiveEvidence,
  listRelatedArchiveObjects,
  packArchiveContext,
  readArchivePage,
} from "../retrieval/query/archive-view/index.js";
import {
  createCollectionResult,
  createFindResult,
} from "../retrieval/query/archive-view/helper/results.js";
import { hydrateSearchIndexHits } from "../retrieval/query/archive-view/search/hydration.js";
import type {
  ArchiveCollectionOptions,
  ArchiveCollectionResult,
  ArchiveEvidence,
  ArchiveEvidenceItem,
  ArchiveEvidenceOptions,
  ArchiveFindHit,
  ArchiveFindOptions,
  ArchiveFindResult,
  ArchiveListItem,
  ArchivePack,
  ArchivePage,
  ArchiveRelatedOptions,
  ArchiveRelatedResult,
} from "../retrieval/query/archive-view/types.js";
import {
  getWikiGraphLibraryArchiveById,
  listWikiGraphLibraryArchives,
  type WikiGraphLibraryArchiveRecord,
} from "./membership.js";
import {
  parseWikiGraphLibraryUri,
  resolveWikiGraphLibrary,
  resolveWikiGraphLibraryById,
  type ParsedWikiGraphLibraryUri,
} from "./registry.js";
import {
  assertWikiGraphLibraryIndexReady,
  listWikiGraphLibraryIndexArchiveIdsForObject,
  queryWikiGraphLibrarySearchIndex,
} from "./search-index.js";

export async function findWikiGraphLibraryObjects(
  target: ParsedWikiGraphLibraryUri,
  query: string,
  options: ArchiveFindOptions = {},
): Promise<ArchiveFindResult> {
  const result = await queryWikiGraphLibrarySearchIndex(target, query);

  if (result === undefined) {
    return createFindResult(query, [], options);
  }

  const hits: ArchiveFindHit[] = [];
  for (const archive of await listReadyLibraryArchives(target)) {
    const source = createLibrarySource(archive);
    const hydrated = await readLibraryArchiveDocument(
      archive,
      async (document) =>
        await hydrateSearchIndexHits(document, {
          objectHits: result.objectHits.filter(
            (hit) => hit.archiveId === archive.id,
          ),
          terms: result.terms,
          textHits: result.textHits.filter(
            (hit) => hit.archiveId === archive.id,
          ),
        }),
    );

    hits.push(...hydrated.map((hit) => ({ ...hit, ...source })));
  }

  return createFindResult(query, hits, options, result.terms);
}

export async function listWikiGraphLibraryObjects(
  target: ParsedWikiGraphLibraryUri,
  options: ArchiveCollectionOptions = {},
): Promise<ArchiveCollectionResult> {
  await assertWikiGraphLibraryIndexReady(target);

  const hits: ArchiveFindHit[] = [];
  for (const archive of await listReadyLibraryArchives(target)) {
    const source = createLibrarySource(archive);
    const result = await readLibraryArchiveDocument(
      archive,
      async (document) => await listArchiveCollection(document, options),
    );

    hits.push(...result.items.map((item) => ({ ...item, ...source })));
  }

  return createCollectionResult(hits, options);
}

export async function readWikiGraphLibraryPage(
  target: ParsedWikiGraphLibraryUri,
  objectUri: string,
  options: Parameters<typeof readArchivePage>[2] = {},
): Promise<ArchivePage> {
  return await readFirstIndexedArchiveResult(
    target,
    objectUri,
    async (document, archive) => ({
      ...(await readArchivePage(document, objectUri, options)),
      ...createLibrarySource(archive),
    }),
  );
}

export async function listWikiGraphLibraryEvidence(
  target: ParsedWikiGraphLibraryUri,
  objectUri: string,
  options: ArchiveEvidenceOptions = {},
): Promise<ArchiveEvidence> {
  const page = await readFirstIndexedArchiveResult(
    target,
    objectUri,
    async (document, archive) => {
      const result = await listArchiveEvidence(document, objectUri, options);
      const source = createLibrarySource(archive);

      return {
        ...result,
        items: result.items.map(
          (item): ArchiveEvidenceItem => ({
            ...item,
            ...source,
          }),
        ),
      };
    },
  );

  return page;
}

export async function listRelatedWikiGraphLibraryObjects(
  target: ParsedWikiGraphLibraryUri,
  objectUri: string,
  options: ArchiveRelatedOptions = {},
): Promise<ArchiveRelatedResult> {
  return await readFirstIndexedArchiveResult(
    target,
    objectUri,
    async (document, archive) => {
      const result = await listRelatedArchiveObjects(
        document,
        objectUri,
        options,
      );
      const source = createLibrarySource(archive);

      return {
        ...result,
        items: result.items.map(
          (item): ArchiveListItem => ({
            ...item,
            ...source,
          }),
        ),
      };
    },
  );
}

export async function packWikiGraphLibraryContext(
  target: ParsedWikiGraphLibraryUri,
  objectUri: string,
  budget: number,
): Promise<ArchivePack> {
  return await readFirstIndexedArchiveResult(
    target,
    objectUri,
    async (document, archive) => {
      const pack = await packArchiveContext(document, objectUri, budget);
      const source = createLibrarySource(archive);

      return {
        ...pack,
        anchor: { ...pack.anchor, ...source },
        related: pack.related.map((item) => ({ ...item, ...source })),
      };
    },
  );
}

export async function resolveWikiGraphLibraryQueryTargetById(
  libraryId: number,
): Promise<ParsedWikiGraphLibraryUri> {
  const library = await resolveWikiGraphLibraryById(libraryId);
  return (
    parseWikiGraphLibraryUri(library.uri) ?? {
      isDefault: library.isDefault,
      kind: "scope",
      publicId: library.publicId,
    }
  );
}

async function readFirstIndexedArchiveResult<T>(
  target: ParsedWikiGraphLibraryUri,
  objectUri: string,
  operation: (
    document: ReadonlyDocument,
    archive: WikiGraphLibraryArchiveRecord,
  ) => Promise<T>,
): Promise<T> {
  const library = await resolveWikiGraphLibrary(target);
  const archiveIds = await listWikiGraphLibraryIndexArchiveIdsForObject(
    target,
    objectUri,
  );
  let lastError: unknown;

  for (const archiveId of archiveIds) {
    const archive = await getWikiGraphLibraryArchiveById(library, archiveId);
    if (!isReadableLibraryArchive(archive)) {
      continue;
    }

    try {
      return await readLibraryArchiveDocument(
        archive,
        async (document) => await operation(document, archive),
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`Wiki Graph library object was not found: ${objectUri}`);
}

async function listReadyLibraryArchives(
  target: ParsedWikiGraphLibraryUri,
): Promise<readonly WikiGraphLibraryArchiveRecord[]> {
  await assertWikiGraphLibraryIndexReady(target);
  return (await listWikiGraphLibraryArchives(target)).filter(
    isReadableLibraryArchive,
  );
}

function isReadableLibraryArchive(
  archive: WikiGraphLibraryArchiveRecord,
): boolean {
  return archive.exists && archive.status === "present";
}

async function readLibraryArchiveDocument<T>(
  archive: WikiGraphLibraryArchiveRecord,
  operation: (document: ReadonlyDocument) => Promise<T>,
): Promise<T> {
  return await new WikiGraphArchiveFile(archive.path).readDocument(operation);
}

function createLibrarySource(archive: WikiGraphLibraryArchiveRecord): {
  readonly archiveId: number;
  readonly libraryArchiveUri: string;
} {
  return {
    archiveId: archive.id,
    libraryArchiveUri: archive.uri,
  };
}
