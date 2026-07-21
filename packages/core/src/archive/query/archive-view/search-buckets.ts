import type { ReadonlyDocument } from "../../../document/index.js";
import { listChapters } from "../../../facade/chapter.js";
import { createLexicalQuery, listLexicalQueryCandidateTerms } from "../lexical-search.js";
import {
  decodeBucketSearchSessionCursor,
  encodeBucketSearchSessionCursor,
  populateSearchSessionObjectCaches,
  readSearchSessionChunkBucketPage,
  readSearchSessionMetadataForCursor,
  readSearchSessionObjectBucketPage,
  type BucketSearchCursor,
  type SearchChapterTitleCursorKey,
  type SearchChunkCursorKey,
  type SearchObjectCursorKey,
  type SearchSessionDescriptor,
  type SearchTextCursorKey,
} from "../search-cache.js";
import {
  querySearchIndex,
  SEARCH_INDEX_FTS_HIT_LIMIT,
  SEARCH_OBJECT_PROPERTY_OWNER_KIND,
  type SearchIndexObjectHit,
  type SearchIndexTextHit,
} from "../../search-index/search-index.js";

import {
  BROAD_FIND_LENS_HINT,
  compareNumbers,
  createNodePosition,
  createSnippet,
  isDefined,
  parseFindLens,
  parseFindMatch,
  parseFindTypes,
} from "./helpers.js";
import {
  assertSearchCursorTypesMatch,
  compareMentions,
  createEntitySearchCacheInput,
  createFindEvidenceHydrationOptions,
  findEntities,
  findTriples,
  hydrateFindHitEvidence,
  hydrateFindResultBacklinks,
  parseEntityQid,
  selectEntityLabel,
} from "./index.js";
import {
  hydrateSearchObjectHit,
  hydrateSearchTextHit,
  parseSearchPropertyIntegerOwnerId,
  withSearchTerms,
} from "./search-hydration.js";
import type { ArchiveFindHit, ArchiveFindOptions, ArchiveFindResult } from "./types.js";

export async function readBucketedSearchResultPage(
  document: ReadonlyDocument,
  cursor: {
    readonly createdAt: number;
    readonly cursor: BucketSearchCursor;
    readonly sessionId: string;
  },
  options: ArchiveFindOptions & { readonly limit: number },
): Promise<ArchiveFindResult> {
  const session = await readSearchSessionMetadataForCursor(
    cursor.sessionId,
    options.archiveKey ?? "archive",
    cursor.createdAt,
  );

  assertSearchCursorTypesMatch(options.types, session.types);

  const items: ArchiveFindHit[] = [];
  let bucketCursor: BucketSearchCursor | undefined = cursor.cursor;

  while (bucketCursor !== undefined && items.length < options.limit) {
    const remaining = options.limit - items.length;
    const page = await readBucketPage(
      document,
      session,
      bucketCursor,
      remaining,
    );

    items.push(...page.items);
    bucketCursor = page.nextCursor;
  }

  return await hydrateFindResultBacklinks(
    document,
    {
      chapters: session.chapters,
      items: await hydrateFindHitEvidence(
        document,
        items,
        createFindEvidenceHydrationOptions(options, cursor.sessionId),
      ),
      lens: parseFindLens(session.lens),
      lensHint: session.lens === "broad" ? BROAD_FIND_LENS_HINT : null,
      limit: options.limit,
      match: parseFindMatch(session.match),
      nextCursor:
        bucketCursor === undefined
          ? null
          : encodeBucketSearchSessionCursor(
              cursor.sessionId,
              bucketCursor,
              session.createdAt,
            ),
      order: options.order ?? "doc-asc",
      query: session.query,
      terms: session.terms,
      types: parseFindTypes(session.types),
    },
    options,
  );
}

async function readBucketPage(
  document: ReadonlyDocument,
  session: SearchSessionDescriptor,
  cursor: BucketSearchCursor,
  limit: number,
): Promise<{
  readonly items: readonly ArchiveFindHit[];
  readonly nextCursor: BucketSearchCursor | undefined;
}> {
  switch (cursor.bucket) {
    case 0:
      return await readChapterTitleBucketPage(
        document,
        session,
        cursor.key,
        limit,
      );
    case 1:
      return await readObjectBucketPage(document, session, cursor.key, limit);
    case 2:
      return await readChunkBucketPage(document, session, cursor.key, limit);
    case 3:
      return await readTextBucketPage(document, session, cursor.key, limit);
  }
}

async function readChapterTitleBucketPage(
  document: ReadonlyDocument,
  session: SearchSessionDescriptor,
  after: SearchChapterTitleCursorKey | undefined,
  limit: number,
): Promise<{
  readonly items: readonly ArchiveFindHit[];
  readonly nextCursor: BucketSearchCursor | undefined;
}> {
  const result = await querySearchIndex(document, session.query, {
    ...(session.chapters === null ? {} : { chapters: session.chapters }),
    match: parseFindMatch(session.match),
    objectHitLimit: SEARCH_INDEX_FTS_HIT_LIMIT,
    textHitLimit: 0,
    types: ["chapter-title"],
  });
  const chapters = new Map(
    (await listChapters(document)).map((chapter) => [
      chapter.chapterId,
      chapter,
    ]),
  );
  const hits = (result?.objectHits ?? [])
    .filter(
      (hit) => hit.ownerKind === SEARCH_OBJECT_PROPERTY_OWNER_KIND.chapter,
    )
    .sort(compareChapterTitleIndexHits)
    .filter((hit) => isAfterChapterTitleKey(hit, after));
  const page = hits.slice(0, limit + 1);
  const hydrated = (
    await Promise.all(
      page.slice(0, limit).map(async (hit) => {
        const item = await hydrateSearchObjectHit(document, chapters, hit);

        return item === undefined
          ? undefined
          : withSearchTerms(item, session.terms);
      }),
    )
  ).filter(isDefined);
  const last = page.at(limit - 1);

  return {
    items: hydrated,
    nextCursor:
      page.length > limit && last !== undefined
        ? {
            bucket: 0,
            key: {
              chapterId: parseSearchPropertyIntegerOwnerId(last.ownerId),
              score: last.score,
            },
          }
        : { bucket: 1 },
  };
}

async function readObjectBucketPage(
  document: ReadonlyDocument,
  session: SearchSessionDescriptor,
  after: SearchObjectCursorKey | undefined,
  limit: number,
): Promise<{
  readonly items: readonly ArchiveFindHit[];
  readonly nextCursor: BucketSearchCursor | undefined;
}> {
  if (!session.objectCachesPopulated) {
    await populateObjectBucketCaches(document, session);
  }
  const page = await readSearchSessionObjectBucketPage(
    session.sessionId,
    1,
    after,
    limit,
  );
  const items = page.slice(0, limit);
  const hydrated = await Promise.all(
    items.map(async (hit) => await hydrateCachedObjectBucketHit(document, hit)),
  );
  const last = items.at(-1);

  return {
    items: hydrated,
    nextCursor:
      page.length > limit && last !== undefined
        ? {
            bucket: 1,
            key: {
              id: getObjectBucketCursorId(last),
              kind: last.type === "triple" ? "triple" : "entity",
              score: last.score ?? 0,
            },
          }
        : { bucket: 2 },
  };
}

async function populateObjectBucketCaches(
  document: ReadonlyDocument,
  session: SearchSessionDescriptor,
): Promise<void> {
  const search = createLexicalQuery(session.query);

  if (search === undefined) {
    return;
  }

  const [allMentions, indexed] = await Promise.all([
    document.mentions.listBySurfaceTerms(
      listLexicalQueryCandidateTerms(session.query),
    ),
    querySearchIndex(document, session.query, {
      ...(session.chapters === null ? {} : { chapters: session.chapters }),
      match: parseFindMatch(session.match),
      objectHitLimit: SEARCH_INDEX_FTS_HIT_LIMIT,
      textHitLimit: 0,
      types: null,
    }),
  ]);
  const structuredHits = [
    ...findEntities(search, { mentions: allMentions }),
    ...(await findTriples(document, search, { mentions: allMentions })),
  ];
  const entityCacheInput = createEntitySearchCacheInput(
    structuredHits,
    indexed,
  );

  await populateSearchSessionObjectCaches({
    entityHits: entityCacheInput.entityHits,
    evidenceEvents: entityCacheInput.evidenceEvents,
    sessionId: session.sessionId,
  });
}

async function readChunkBucketPage(
  document: ReadonlyDocument,
  session: SearchSessionDescriptor,
  after: SearchChunkCursorKey | undefined,
  limit: number,
): Promise<{
  readonly items: readonly ArchiveFindHit[];
  readonly nextCursor: BucketSearchCursor | undefined;
}> {
  const page = await readSearchSessionChunkBucketPage(
    session.sessionId,
    after,
    limit,
  );
  const items = page.slice(0, limit);
  const hydrated = (
    await Promise.all(
      items.map(
        async (hit) => await hydrateCachedChunkBucketHit(document, hit),
      ),
    )
  ).filter(isDefined);
  const last = items.at(-1);

  return {
    items: hydrated,
    nextCursor:
      page.length > limit && last !== undefined
        ? {
            bucket: 2,
            key: {
              chunkId: parseSearchPropertyIntegerOwnerId(
                last.id.slice("wikg://chunk/".length),
              ),
              score: last.score ?? 0,
            },
          }
        : { bucket: 3 },
  };
}

async function readTextBucketPage(
  document: ReadonlyDocument,
  session: SearchSessionDescriptor,
  after: SearchTextCursorKey | undefined,
  limit: number,
): Promise<{
  readonly items: readonly ArchiveFindHit[];
  readonly nextCursor: BucketSearchCursor | undefined;
}> {
  const result = await querySearchIndex(document, session.query, {
    ...(session.chapters === null ? {} : { chapters: session.chapters }),
    match: parseFindMatch(session.match),
    objectHitLimit: 0,
    ...(after === undefined
      ? {}
      : {
          textAfter: {
            chapterId: after.chapterId,
            kind: after.kind as SearchIndexTextHit["kind"],
            rank: after.rank,
            sentenceIndex: after.sentenceIndex,
          },
        }),
    textHitLimit: createBucketQueryWindow(limit),
    types: ["source", "summary"],
  });
  const chapters = new Map(
    (await listChapters(document)).map((chapter) => [
      chapter.chapterId,
      chapter,
    ]),
  );
  const hits = [...(result?.textHits ?? [])]
    .sort(compareTextIndexHits)
    .filter((hit) => isAfterTextKey(hit, after));
  const page = hits.slice(0, limit + 1);
  const hydrated = (
    await Promise.all(
      page.slice(0, limit).map(async (hit) => {
        const item = await hydrateSearchTextHit(document, chapters, hit);

        return item === undefined
          ? undefined
          : withSearchTerms(item, session.terms);
      }),
    )
  ).filter(isDefined);
  const last = page.at(limit - 1);

  return {
    items: hydrated,
    nextCursor:
      page.length > limit && last !== undefined
        ? {
            bucket: 3,
            key: {
              chapterId: last.chapterId,
              kind: last.kind,
              rank: last.rank,
              sentenceIndex: last.sentenceIndex,
            },
          }
        : undefined,
  };
}

function createBucketQueryWindow(limit: number): number {
  return Math.max(limit + 1, limit * 3 + 1, 100);
}

async function hydrateCachedObjectBucketHit(
  document: ReadonlyDocument,
  hit: ArchiveFindHit,
): Promise<ArchiveFindHit> {
  if (hit.type === "entity") {
    const qid = parseEntityQid(hit.id);

    if (qid === undefined) {
      return hit;
    }
    const mentions = await document.mentions.listByQid(qid);
    const [first] = [...mentions].sort(compareMentions);

    if (first === undefined) {
      return hit;
    }

    return {
      ...hit,
      chapter: first.chapterId,
      position: {
        chapter: first.chapterId,
        sentence: first.sentenceIndex ?? 0,
      },
      snippet: first.note ?? first.surface,
      title: selectEntityLabel(mentions),
    };
  }
  if (hit.type === "triple") {
    return hit;
  }

  return hit;
}

async function hydrateCachedChunkBucketHit(
  document: ReadonlyDocument,
  hit: ArchiveFindHit,
): Promise<ArchiveFindHit | undefined> {
  const chunkId = parseSearchPropertyIntegerOwnerId(
    hit.id.slice("wikg://chunk/".length),
  );
  const node = await document.chunks.getById(chunkId);

  if (node === undefined) {
    return undefined;
  }
  const { position: _position, ...baseHit } = hit;
  const position = createNodePosition(node.sentenceIds);

  return {
    ...baseHit,
    chapter: node.sentenceId[0],
    field: "title",
    ...(position === undefined ? {} : { position }),
    snippet: createSnippet(node.content),
    title: node.label,
  };
}

function compareChapterTitleIndexHits(
  left: SearchIndexObjectHit,
  right: SearchIndexObjectHit,
): number {
  return (
    compareNumbers(right.score, left.score) ||
    compareNumbers(
      parseSearchPropertyIntegerOwnerId(left.ownerId),
      parseSearchPropertyIntegerOwnerId(right.ownerId),
    )
  );
}

function compareTextIndexHits(
  left: SearchIndexTextHit,
  right: SearchIndexTextHit,
): number {
  return (
    compareNumbers(left.rank, right.rank) ||
    compareNumbers(left.chapterId, right.chapterId) ||
    compareNumbers(left.sentenceIndex, right.sentenceIndex) ||
    compareNumbers(left.kind, right.kind)
  );
}

function isAfterChapterTitleKey(
  hit: SearchIndexObjectHit,
  key: SearchChapterTitleCursorKey | undefined,
): boolean {
  if (key === undefined) {
    return true;
  }

  return (
    compareChapterTitleIndexHits(
      {
        ...hit,
        ownerId: String(key.chapterId),
        score: key.score,
      },
      hit,
    ) < 0
  );
}

function isAfterTextKey(
  hit: SearchIndexTextHit,
  key: SearchTextCursorKey | undefined,
): boolean {
  if (key === undefined) {
    return true;
  }

  return (
    compareTextIndexHits(
      {
        chapterId: key.chapterId,
        kind: key.kind as SearchIndexTextHit["kind"],
        rank: key.rank,
        score: 0,
        sentenceIndex: key.sentenceIndex,
        wordsCount: 0,
      },
      hit,
    ) < 0
  );
}

function getObjectBucketCursorId(hit: ArchiveFindHit): string {
  if (hit.type !== "triple") {
    return hit.id.replace(/^wikg:\/\/entity\//u, "");
  }

  const triple = parseTripleCursorId(hit.id);

  return triple ?? hit.id;
}

function parseTripleCursorId(id: string): string | undefined {
  const match = /^wikg:\/\/triple\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(id);

  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }

  return `${match[1]}\u001f${decodeURIComponent(match[2])}\u001f${match[3]}`;
}

export function tryDecodeBucketSearchSessionCursor(cursor: string):
  | {
      readonly createdAt: number;
      readonly cursor: BucketSearchCursor;
      readonly sessionId: string;
    }
  | undefined {
  try {
    return decodeBucketSearchSessionCursor(cursor);
  } catch {
    return undefined;
  }
}

