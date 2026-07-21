import type {
  MentionLinkRecord,
  MentionRecord,
  ReadonlyDocument,
  SentenceId,
} from "../../../document/index.js";
import type { GraphNeighbor, GraphNode } from "../../../facade/graph.js";
import { listGraphNeighbors } from "../../../facade/graph.js";

import {
  aggregateEvidenceScores,
  compareListHits,
  compareNumbers,
  compareSentenceIds,
  createSentencePosition,
  isWikiGraphObjectUri,
  normalizeWikiGraphObjectUri,
} from "./helpers.js";
import { requireChapter, requireNode } from "./core.js";
import {
  filterMentionsByChapter,
  formatEntityUri,
  formatTripleUri,
} from "./knowledge.js";
import { createSentenceHitKey } from "./search-cache-input.js";
import {
  hydrateRelatedItemsEvidence,
  paginateRelatedItems,
} from "./related-pagination.js";
export { resolveEntityWikipage } from "./related-wikipage.js";
import { formatChapterId, formatNodeId, parseArchiveReference, parseWikiGraphReference } from "./references.js";
import type { WikiGraphReference } from "./references.js";
import { queryRequiredSearchIndex } from "./search-hydration.js";
import {
  SEARCH_OBJECT_PROPERTY_OWNER_KIND,
  TEXT_SENTENCE_KIND,
} from "../../search-index/search-index.js";
import type {
  ArchiveFindHit,
  ArchiveFindObjectType,
  ArchiveFindOrder,
  ArchiveFindPosition,
  ArchiveListItem,
  ArchiveRelatedOptions,
  ArchiveRelatedResult,
  ArchiveRelatedRole,
} from "./types.js";

export async function listArchiveLinks(
  document: ReadonlyDocument,
  id: string,
  direction: "backlinks" | "links",
): Promise<readonly GraphNeighbor[]> {
  return (await listAllArchiveLinks(document, id)).filter((neighbor) =>
    direction === "links"
      ? neighbor.direction === "outgoing"
      : neighbor.direction === "incoming",
  );
}

export async function listAllArchiveLinks(
  document: ReadonlyDocument,
  id: string,
): Promise<readonly GraphNeighbor[]> {
  if (isWikiGraphObjectUri(id)) {
    id = normalizeWikiGraphObjectUri(id);
    const reference = parseWikiGraphReference(id);

    if (reference.type !== "chunk") {
      return [];
    }

    const { chapterId } = await requireNode(document, reference.id);

    if (
      reference.chapterId !== undefined &&
      reference.chapterId !== chapterId
    ) {
      throw new Error(`Chunk ${id} was not found in this archive.`);
    }

    return await listGraphNeighbors(document, chapterId, reference.id);
  }

  const reference = parseArchiveReference(id);

  if (reference.type !== "node") {
    return [];
  }

  const { chapterId } = await requireNode(document, reference.id);
  return await listGraphNeighbors(document, chapterId, reference.id);
}

export async function listRelatedArchiveObjects(
  document: ReadonlyDocument,
  id: string,
  options: ArchiveRelatedOptions = {},
): Promise<ArchiveRelatedResult> {
  if (isWikiGraphObjectUri(id)) {
    return await listRelatedWikiGraphObjects(
      document,
      normalizeWikiGraphObjectUri(id),
      options,
    );
  }

  const reference = parseArchiveReference(id);
  if (reference.type !== "node") {
    rejectRelatedRole(options.role, id);
    return paginateRelatedItems([], options);
  }
  rejectRelatedRole(options.role, id);

  const documentOrders = await document.serials.listDocumentOrders();
  const { chapterId } = await requireNode(document, reference.id);
  const items = sortGraphNeighborsByListMode(
    await listGraphNeighbors(document, chapterId, reference.id),
    documentOrders,
    options.order ?? "doc-asc",
  ).map((neighbor) => ({
    id: formatNodeId(neighbor.node.id),
    label: neighbor.node.label,
    summary: neighbor.node.content,
    type: "node" as const,
  }));

  return await hydrateRelatedItemsEvidence(
    document,
    await filterAndSortChunkRelatedItemsByQuery(document, items, options.query),
    options,
  );
}

async function listRelatedWikiGraphObjects(
  document: ReadonlyDocument,
  uri: string,
  options: ArchiveRelatedOptions,
): Promise<ArchiveRelatedResult> {
  const reference = parseWikiGraphReference(uri);

  switch (reference.type) {
    case "chapter": {
      throw new Error(`Related is not available for scope URI: ${uri}`);
    }
    case "chapter-title":
      rejectRelatedRole(options.role, uri);
      return paginateRelatedItems([], options);
    case "chunk": {
      rejectRelatedRole(options.role, uri);
      const { chapterId } = await requireNode(document, reference.id);

      if (
        reference.chapterId !== undefined &&
        reference.chapterId !== chapterId
      ) {
        throw new Error(`Chunk ${uri} was not found in this archive.`);
      }

      const items = sortGraphNeighborsByListMode(
        await listGraphNeighbors(document, chapterId, reference.id),
        await document.serials.listDocumentOrders(),
        options.order ?? "doc-asc",
      ).map((neighbor) => ({
        id: formatNodeId(neighbor.node.id),
        label: neighbor.node.label,
        summary: neighbor.node.content,
        type: "node" as const,
      }));

      return await hydrateRelatedItemsEvidence(
        document,
        await filterAndSortChunkRelatedItemsByQuery(
          document,
          items,
          options.query,
        ),
        options,
      );
    }
    case "text-stream": {
      rejectRelatedQuery(options.query, uri);
      rejectRelatedRole(options.role, uri);
      const chapter = await requireChapter(document, reference.chapterId);

      return await hydrateRelatedItemsEvidence(
        document,
        [
          {
            id: formatChapterId(reference.chapterId),
            label: chapter.title ?? `[chapter ${reference.chapterId}]`,
            summary: `${chapter.stage}; ${chapter.fragmentCount} fragments`,
            type: "chapter",
          },
        ],
        options,
      );
    }
    case "entity":
      return await listRelatedEntityObjects(document, reference, options);
    case "triple":
      throw new Error(
        `Related is only available for chunk and entity objects: ${uri}`,
      );
    case "chapter-tree":
    case "entity-wikipage":
    case "meta":
    case "chapter-state":
      rejectRelatedQuery(options.query, uri);
      rejectRelatedRole(options.role, uri);
      return paginateRelatedItems([], options);
  }
}


async function listRelatedEntityObjects(
  document: ReadonlyDocument,
  reference: Extract<WikiGraphReference, { readonly type: "entity" }>,
  options: ArchiveRelatedOptions,
): Promise<ArchiveRelatedResult> {
  const mentions = filterMentionsByChapter(
    await document.mentions.listByQid(reference.qid),
    reference.chapterId,
  );

  if (mentions.length === 0) {
    throw new Error(
      `Entity ${formatEntityUri(reference.qid)} was not found in this archive.`,
    );
  }

  const chapters = [
    ...new Set(mentions.map((mention) => mention.chapterId)),
  ].sort(compareNumbers);
  const role = options.role ?? "any";
  const triplesById = new Map<
    string,
    Extract<ArchiveListItem, { readonly type: "triple" }>
  >();

  for (const chapterId of chapters) {
    for (const link of await document.mentionLinks.listByChapter(chapterId)) {
      const [source, target] = await Promise.all([
        document.mentions.getById(link.sourceMentionId),
        document.mentions.getById(link.targetMentionId),
      ]);

      if (source === undefined || target === undefined) {
        continue;
      }
      if (
        !matchesRelatedEntityRole(source.qid, target.qid, reference.qid, role)
      ) {
        continue;
      }

      const id = formatTripleUri(source.qid, link.predicate, target.qid);

      const existing = triplesById.get(id);

      if (existing !== undefined) {
        triplesById.set(id, {
          ...existing,
          evidenceLinks: [...(existing.evidenceLinks ?? []), link],
        });
        continue;
      }

      triplesById.set(id, {
        evidenceLinks: [link],
        id,
        label: `${source.surface} ${link.predicate} ${target.surface}`,
        objectLabel: target.surface,
        objectQid: target.qid,
        predicate: link.predicate,
        subjectLabel: source.surface,
        subjectQid: source.qid,
        summary: `${source.qid} ${link.predicate} ${target.qid}`,
        type: "triple",
      });
    }
  }

  return await hydrateRelatedItemsEvidence(
    document,
    await filterAndSortEntityRelatedTriplesByQuery(
      document,
      sortRelatedItemsByListMode(
        [...triplesById.values()],
        options.order ?? "doc-asc",
        await document.serials.listDocumentOrders(),
      ),
      reference.qid,
      options.query,
    ),
    options,
  );
}

async function filterAndSortChunkRelatedItemsByQuery(
  document: ReadonlyDocument,
  items: readonly ArchiveListItem[],
  query: string | undefined,
): Promise<readonly ArchiveListItem[]> {
  if (query === undefined) {
    return items;
  }

  const indexResult = await queryRequiredSearchIndex(document, query, {
    types: ["node"],
  });

  if (indexResult === undefined) {
    return [];
  }

  const scoresByChunkId = new Map<number, number[]>();
  const allowedChunkIds = new Set(
    items.flatMap((item) => {
      if (item.type !== "node") {
        return [];
      }
      const reference = parseArchiveReference(item.id);

      return reference.type === "node" ? [reference.id] : [];
    }),
  );

  for (const hit of indexResult.objectHits) {
    if (
      hit.ownerKind !== SEARCH_OBJECT_PROPERTY_OWNER_KIND.chunk ||
      !allowedChunkIds.has(Number(hit.ownerId))
    ) {
      continue;
    }

    const chunkId = Number(hit.ownerId);
    const scores = scoresByChunkId.get(chunkId) ?? [];

    scores.push(hit.score);
    scoresByChunkId.set(chunkId, scores);
  }

  return items
    .flatMap((item) => {
      if (item.type !== "node") {
        return [];
      }
      const reference = parseArchiveReference(item.id);

      if (reference.type !== "node") {
        return [];
      }
      const scores = scoresByChunkId.get(reference.id);

      return scores === undefined
        ? []
        : [{ ...item, score: aggregateEvidenceScores(scores) }];
    })
    .sort(compareRelatedQueryItems);
}

async function filterAndSortEntityRelatedTriplesByQuery(
  document: ReadonlyDocument,
  items: readonly ArchiveListItem[],
  anchorQid: string,
  query: string | undefined,
): Promise<readonly ArchiveListItem[]> {
  if (query === undefined) {
    return items;
  }
  const scope = await createEntityRelatedQueryScope(document, items, anchorQid);

  const indexResult = await queryRequiredSearchIndex(document, query, {
    chapters: [...scope.chapterIds],
    types: ["entity", "source"],
  });

  if (indexResult === undefined) {
    return [];
  }

  const sentenceScores = new Map(
    indexResult.textHits
      .filter((hit) => hit.kind === TEXT_SENTENCE_KIND.source)
      .map(
        (hit) =>
          [
            createSentenceHitKey(hit.chapterId, hit.sentenceIndex),
            hit.score,
          ] as const,
      ),
  );
  const endpointScoresByKey = new Map<string, number[]>();

  for (const hit of indexResult.objectHits) {
    if (
      hit.ownerKind !== SEARCH_OBJECT_PROPERTY_OWNER_KIND.entity ||
      hit.ownerId === anchorQid ||
      hit.chapterId === undefined
    ) {
      continue;
    }

    const key = createEntityRelatedEndpointKey(hit.ownerId, hit.chapterId);
    const scores = endpointScoresByKey.get(key) ?? [];

    scores.push(hit.score);
    endpointScoresByKey.set(key, scores);
  }

  return items
    .flatMap((item) => {
      if (item.type !== "triple") {
        return [];
      }

      const scores = [
        ...[...(scope.endpointKeysByTripleId.get(item.id) ?? [])].flatMap(
          (key) => endpointScoresByKey.get(key) ?? [],
        ),
        ...(item.evidenceLinks ?? []).flatMap((link) =>
          link.evidenceSentenceIds.flatMap(([chapterId, sentenceIndex]) => {
            const score = sentenceScores.get(
              createSentenceHitKey(chapterId, sentenceIndex),
            );

            return score === undefined ? [] : [score];
          }),
        ),
      ];

      return scores.length === 0
        ? []
        : [{ ...item, score: aggregateEvidenceScores(scores) }];
    })
    .sort(compareRelatedQueryItems);
}

async function createEntityRelatedQueryScope(
  document: ReadonlyDocument,
  items: readonly ArchiveListItem[],
  anchorQid: string,
): Promise<{
  readonly chapterIds: ReadonlySet<number>;
  readonly endpointKeysByTripleId: ReadonlyMap<string, ReadonlySet<string>>;
}> {
  const chapterIds = new Set<number>();
  const endpointKeysByTripleId = new Map<string, Set<string>>();
  const mentionCache = new Map<string, MentionRecord | undefined>();

  for (const item of items) {
    if (item.type !== "triple") {
      continue;
    }

    const endpointKeys = new Set<string>();

    for (const link of item.evidenceLinks ?? []) {
      for (const [chapterId] of link.evidenceSentenceIds) {
        chapterIds.add(chapterId);
      }

      const [source, target] = await Promise.all([
        getCachedMention(document, mentionCache, link.sourceMentionId),
        getCachedMention(document, mentionCache, link.targetMentionId),
      ]);

      for (const mention of [source, target]) {
        if (mention === undefined || mention.qid === anchorQid) {
          continue;
        }

        chapterIds.add(mention.chapterId);
        endpointKeys.add(
          createEntityRelatedEndpointKey(mention.qid, mention.chapterId),
        );
      }
    }

    endpointKeysByTripleId.set(item.id, endpointKeys);
  }

  return { chapterIds, endpointKeysByTripleId };
}

async function getCachedMention(
  document: ReadonlyDocument,
  cache: Map<string, MentionRecord | undefined>,
  mentionId: string,
): Promise<MentionRecord | undefined> {
  if (!cache.has(mentionId)) {
    cache.set(mentionId, await document.mentions.getById(mentionId));
  }

  return cache.get(mentionId);
}

function createEntityRelatedEndpointKey(
  qid: string,
  chapterId: number,
): string {
  return `${qid}:${chapterId}`;
}

function compareRelatedQueryItems(
  left: ArchiveListItem,
  right: ArchiveListItem,
): number {
  const scoreComparison = (right.score ?? 0) - (left.score ?? 0);

  if (scoreComparison !== 0) {
    return scoreComparison;
  }

  return compareListHits(
    createFindHitFromListItem(left),
    createFindHitFromListItem(right),
    "doc-asc",
  );
}

function sortRelatedItemsByListMode(
  items: readonly ArchiveListItem[],
  order: ArchiveFindOrder = "doc-asc",
  documentOrders?: ReadonlyMap<number, number>,
): readonly ArchiveListItem[] {
  return [...items].sort((left, right) =>
    compareListHits(
      createFindHitFromListItem(left, documentOrders),
      createFindHitFromListItem(right, documentOrders),
      order,
    ),
  );
}

function sortGraphNeighborsByListMode(
  neighbors: readonly GraphNeighbor[],
  documentOrders: ReadonlyMap<number, number>,
  order: ArchiveFindOrder,
): readonly GraphNeighbor[] {
  const direction = order === "doc-asc" ? 1 : -1;

  return [...neighbors].sort(
    (left, right) =>
      compareSentenceIds(
        getFirstGraphNodeSentenceId(left.node),
        getFirstGraphNodeSentenceId(right.node),
        documentOrders,
      ) * direction,
  );
}

function createFindHitFromListItem(
  item: ArchiveListItem,
  documentOrders?: ReadonlyMap<number, number>,
): ArchiveFindHit {
  const position = createListItemPosition(item, documentOrders);
  const score =
    item.type === "triple" ? (item.evidenceLinks?.length ?? 0) : undefined;

  return {
    field: "title",
    id: item.id,
    ...(position === undefined ? {} : { position }),
    ...(score === undefined ? {} : { score }),
    snippet: item.summary,
    title: item.label,
    type: toFindObjectType(item.type),
  };
}

function toFindObjectType(
  type: ArchiveListItem["type"],
): ArchiveFindObjectType {
  switch (type) {
    case "edge":
    case "state":
      return "meta";
    default:
      return type;
  }
}

function createListItemPosition(
  item: ArchiveListItem,
  documentOrders?: ReadonlyMap<number, number>,
): ArchiveFindPosition | undefined {
  if (item.type === "triple") {
    return createFirstMentionLinkPosition(
      item.evidenceLinks ?? [],
      documentOrders,
    );
  }

  return undefined;
}

function createFirstMentionLinkPosition(
  links: readonly MentionLinkRecord[],
  documentOrders?: ReadonlyMap<number, number>,
): ArchiveFindPosition | undefined {
  const sentenceIds = links.flatMap((link) => link.evidenceSentenceIds);
  const [first] = sentenceIds.sort((left, right) =>
    compareSentenceIds(left, right, documentOrders),
  );

  return first === undefined
    ? undefined
    : createSentencePosition(first, documentOrders);
}

function getFirstGraphNodeSentenceId(node: GraphNode): SentenceId {
  return (
    [...node.sentenceIds].sort(compareSentenceIds)[0] ?? [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ]
  );
}

function matchesRelatedEntityRole(
  subjectQid: string,
  objectQid: string,
  qid: string,
  role: ArchiveRelatedRole,
): boolean {
  const isSubject = subjectQid === qid;
  const isObject = objectQid === qid;
  const isSelf = isSubject && isObject;

  switch (role) {
    case "any":
      return isSubject || isObject;
    case "subject":
      return isSubject && !isSelf;
    case "object":
      return isObject && !isSelf;
    case "self":
      return isSelf;
  }
}

function rejectRelatedRole(
  role: ArchiveRelatedRole | undefined,
  id: string,
): void {
  if (role !== undefined && role !== "any") {
    throw new Error(`--role is only available for entity related: ${id}`);
  }
}

function rejectRelatedQuery(query: string | undefined, id: string): void {
  if (query !== undefined) {
    throw new Error(
      `Related query is only available for chunk and entity: ${id}`,
    );
  }
}
