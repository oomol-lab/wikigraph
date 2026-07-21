import type { MentionLinkRecord, MentionRecord, ReadonlyDocument } from "../../../document/index.js";
import type { ChapterEntry } from "../../../facade/chapter.js";
import type { GraphNode } from "../../../facade/graph.js";

import { TEXT_SENTENCE_KIND } from "../../search-index/search-index.js";
import {
  DEFAULT_FIND_LIMIT,
  compareNumbers,
  decodeFindCursor,
  encodeFindCursor,
} from "./helpers.js";
import { formatTextStreamRangeUri } from "./references.js";
import { queryRequiredSearchIndex } from "./search-hydration.js";
import { getTextStreamIndex, readTextStreamRange } from "./text-streams.js";
import type {
  ArchiveEvidence,
  ArchiveEvidenceItem,
  ArchiveEvidenceOptions,
  ArchiveFindEvidencePreview,
  ArchiveFindOrder,
  EvidenceReadContext,
  SourceEvidenceRange,
} from "./types.js";
import { DEFAULT_SOURCE_CONTEXT, requireChapter } from "./core.js";

export function createNodeEvidenceRanges(node: Pick<GraphNode, "sentenceIds">): Array<{
  readonly chapterId: number;
  readonly endSentenceIndex: number;
  readonly startSentenceIndex: number;
}> {
  const ranges = new Map<string, [number, number]>();

  for (const [chapterId, sentenceIndex] of node.sentenceIds) {
    const key = `${chapterId}`;
    const current = ranges.get(key);

    if (current === undefined) {
      ranges.set(key, [sentenceIndex, sentenceIndex]);
    } else {
      ranges.set(key, [
        Math.min(current[0], sentenceIndex),
        Math.max(current[1], sentenceIndex),
      ]);
    }
  }

  return [...ranges.entries()].map(([key, [start, end]]) => {
    const chapterId = Number(key);
    return {
      chapterId,
      endSentenceIndex: end,
      startSentenceIndex: start,
    };
  });
}

export async function createMentionEvidencePreview(
  document: ReadonlyDocument,
  mentions: readonly MentionRecord[],
  limit = 3,
  context: EvidenceReadContext = createEvidenceReadContext(),
  sourceContext = DEFAULT_SOURCE_CONTEXT,
  order: ArchiveFindOrder = "doc-asc",
): Promise<ArchiveFindEvidencePreview> {
  return await createSourceEvidencePreview(
    document,
    await createMentionEvidenceRanges(document, mentions),
    limit,
    context,
    sourceContext,
    order,
  );
}

export async function createMentionEvidenceRanges(
  document: ReadonlyDocument,
  mentions: readonly MentionRecord[],
): Promise<
  Array<{
    readonly chapterId: number;
    readonly endSentenceIndex: number;
    readonly startSentenceIndex: number;
  }>
> {
  return await Promise.all(
    mentions.map(async (mention) => {
      const startSentenceIndex =
        mention.sentenceIndex ??
        (await findSentenceIndexAtOffset(
          document,
          mention.chapterId,
          mention.rangeStart,
        ));
      const endSentenceIndex =
        mention.sentenceIndex ??
        (await findSentenceIndexAtOffset(
          document,
          mention.chapterId,
          Math.max(0, mention.rangeEnd - 1),
        ));

      return {
        chapterId: mention.chapterId,
        endSentenceIndex,
        startSentenceIndex,
      };
    }),
  );
}

export async function createMentionLinkEvidencePreview(
  document: ReadonlyDocument,
  links: readonly MentionLinkRecord[],
  limit = 3,
  context: EvidenceReadContext = createEvidenceReadContext(),
  sourceContext = DEFAULT_SOURCE_CONTEXT,
  order: ArchiveFindOrder = "doc-asc",
): Promise<ArchiveFindEvidencePreview> {
  return await createSourceEvidencePreview(
    document,
    createMentionLinkEvidenceRanges(document, links),
    limit,
    context,
    sourceContext,
    order,
  );
}

export function createMentionLinkEvidenceRanges(
  _document: ReadonlyDocument,
  links: readonly MentionLinkRecord[],
): Array<{
  readonly chapterId: number;
  readonly endSentenceIndex: number;
  readonly startSentenceIndex: number;
}> {
  return links.flatMap((link) =>
    link.evidenceSentenceIds.map(([chapterId, sentenceIndex]) => ({
      chapterId,
      endSentenceIndex: sentenceIndex,
      startSentenceIndex: sentenceIndex,
    })),
  );
}


export async function createSourceEvidencePage(
  document: ReadonlyDocument,
  ranges: readonly SourceEvidenceRange[],
  options: ArchiveEvidenceOptions,
): Promise<ArchiveEvidence> {
  const context = createEvidenceReadContext();
  const limit = options.limit ?? DEFAULT_FIND_LIMIT;
  const start = decodeFindCursor(options.cursor);
  const evidenceRanges = await filterAndSortSourceEvidenceRangesByFtsQuery(
    document,
    ranges,
    options.query,
    options.order ?? "doc-asc",
  );
  const displayRanges = await createExpandedSourceEvidenceRanges(
    document,
    evidenceRanges,
    options.sourceContext ?? DEFAULT_SOURCE_CONTEXT,
    context,
  );
  const pageRanges = displayRanges.slice(start, start + limit);
  const nextOffset = start + pageRanges.length;
  const items = await Promise.all(
    pageRanges.map(
      async (range) =>
        await createSourceEvidenceItem(
          document,
          range.chapterId,
          range.startSentenceIndex,
          range.endSentenceIndex,
          context,
          range.score,
        ),
    ),
  );

  return {
    items,
    limit,
    nextCursor:
      nextOffset < displayRanges.length ? encodeFindCursor(nextOffset) : null,
  };
}

export async function filterAndSortSourceEvidenceRangesByFtsQuery(
  document: ReadonlyDocument,
  ranges: readonly SourceEvidenceRange[],
  queryText: string | undefined,
  order: ArchiveFindOrder,
): Promise<readonly SourceEvidenceRange[]> {
  const documentOrders = await document.serials.listDocumentOrders();

  if (queryText === undefined) {
    return mergeSourceEvidenceRanges(ranges).sort((left, right) =>
      compareSourceEvidenceRanges(left, right, documentOrders, order),
    );
  }

  const indexResult = await queryRequiredSearchIndex(document, queryText, {
    chapters: [...new Set(ranges.map((range) => range.chapterId))],
    types: ["source"],
  });

  if (indexResult === undefined) {
    return [];
  }

  const matchedRanges = new Map<string, SourceEvidenceRange>();
  const rangesByChapterId = new Map<number, SourceEvidenceRange[]>();

  for (const range of ranges) {
    const chapterRanges = rangesByChapterId.get(range.chapterId) ?? [];

    chapterRanges.push(range);
    rangesByChapterId.set(range.chapterId, chapterRanges);
  }

  for (const hit of indexResult.textHits) {
    if (hit.kind !== TEXT_SENTENCE_KIND.source) {
      continue;
    }

    for (const range of rangesByChapterId.get(hit.chapterId) ?? []) {
      if (
        hit.sentenceIndex < range.startSentenceIndex ||
        hit.sentenceIndex > range.endSentenceIndex
      ) {
        continue;
      }

      const key = formatSourceEvidenceRangeKey(range);
      const current = matchedRanges.get(key);

      matchedRanges.set(key, {
        ...range,
        score: Math.max(current?.score ?? 0, hit.score),
      });
    }
  }

  return [...matchedRanges.values()].sort((left, right) => {
    const scoreComparison = (right.score ?? 0) - (left.score ?? 0);

    if (scoreComparison !== 0) {
      return scoreComparison;
    }

    return compareSourceEvidenceRanges(left, right, documentOrders, "doc-asc");
  });
}

function formatSourceEvidenceRangeKey(range: SourceEvidenceRange): string {
  return `${range.chapterId}:${range.startSentenceIndex}:${range.endSentenceIndex}`;
}

function compareSourceEvidenceRanges(
  left: SourceEvidenceRange,
  right: SourceEvidenceRange,
  documentOrders: ReadonlyMap<number, number>,
  order: ArchiveFindOrder,
): number {
  const direction = order === "doc-asc" ? 1 : -1;

  return (
    (compareNumbers(
      documentOrders.get(left.chapterId) ?? left.chapterId,
      documentOrders.get(right.chapterId) ?? right.chapterId,
    ) ||
      compareNumbers(left.chapterId, right.chapterId) ||
      compareNumbers(left.startSentenceIndex, right.startSentenceIndex) ||
      compareNumbers(left.endSentenceIndex, right.endSentenceIndex)) * direction
  );
}

export async function createSourceEvidencePreview(
  document: ReadonlyDocument,
  ranges: readonly SourceEvidenceRange[],
  limit: number,
  context: EvidenceReadContext = createEvidenceReadContext(),
  sourceContext = DEFAULT_SOURCE_CONTEXT,
  order: ArchiveFindOrder = "doc-asc",
): Promise<ArchiveFindEvidencePreview> {
  const documentOrders = await document.serials.listDocumentOrders();
  const mergedRanges = mergeSourceEvidenceRanges(ranges).sort((left, right) =>
    compareSourceEvidenceRanges(left, right, documentOrders, order),
  );
  const displayRanges = await createExpandedSourceEvidenceRanges(
    document,
    mergedRanges.slice(0, limit),
    sourceContext,
    context,
  );
  const sources = await Promise.all(
    displayRanges.map(
      async (range) =>
        await createSourceEvidenceItem(
          document,
          range.chapterId,
          range.startSentenceIndex,
          range.endSentenceIndex,
          context,
        ),
    ),
  );

  return {
    nextCursor:
      Math.min(limit, mergedRanges.length) < mergedRanges.length
        ? encodeFindCursor(Math.min(limit, mergedRanges.length))
        : null,
    shown: sources.length,
    sources,
    total: mergedRanges.length,
  };
}

function mergeSourceEvidenceRanges(
  ranges: readonly SourceEvidenceRange[],
): SourceEvidenceRange[] {
  const rangesBySource = new Map<
    string,
    Array<{
      readonly end: number;
      readonly score?: number;
      readonly start: number;
    }>
  >();

  for (const range of ranges) {
    const key = `${range.chapterId}`;
    const sourceRanges = rangesBySource.get(key) ?? [];

    sourceRanges.push({
      end: range.endSentenceIndex,
      ...(range.score === undefined ? {} : { score: range.score }),
      start: range.startSentenceIndex,
    });
    rangesBySource.set(key, sourceRanges);
  }

  return [...rangesBySource.entries()].flatMap(([key, ranges]) => {
    const chapterId = Number(key);

    return mergeEvidenceRanges(ranges).map(
      ({ end, score, start }) =>
        ({
          chapterId,
          endSentenceIndex: end,
          ...(score === undefined ? {} : { score }),
          startSentenceIndex: start,
        }) as const,
    );
  });
}

function mergeSourceEvidenceRangesInInputOrder(
  ranges: readonly SourceEvidenceRange[],
): SourceEvidenceRange[] {
  const merged: SourceEvidenceRange[] = [];

  for (const range of ranges) {
    const overlappingIndexes = merged
      .map((existing, index) =>
        areMergeableSourceEvidenceRanges(existing, range) ? index : -1,
      )
      .filter((index) => index >= 0);

    if (overlappingIndexes.length === 0) {
      merged.push(range);
      continue;
    }

    const firstIndex = overlappingIndexes[0] ?? 0;
    const overlapping = overlappingIndexes.flatMap((index) => {
      const existing = merged[index];

      return existing === undefined ? [] : [existing];
    });
    const mergedRange = mergeSourceEvidenceRangeGroup([...overlapping, range]);

    merged[firstIndex] = mergedRange;
    for (const index of overlappingIndexes.slice(1).reverse()) {
      merged.splice(index, 1);
    }
  }

  return merged;
}

function areMergeableSourceEvidenceRanges(
  left: SourceEvidenceRange,
  right: SourceEvidenceRange,
): boolean {
  return (
    left.chapterId === right.chapterId &&
    right.startSentenceIndex <= left.endSentenceIndex + 1 &&
    left.startSentenceIndex <= right.endSentenceIndex + 1
  );
}

function mergeSourceEvidenceRangeGroup(
  ranges: readonly SourceEvidenceRange[],
): SourceEvidenceRange {
  const [first] = ranges;

  if (first === undefined) {
    throw new Error("Internal error: cannot merge empty evidence range group.");
  }

  const scores = ranges
    .map((range) => range.score)
    .filter((score): score is number => score !== undefined);

  return {
    chapterId: first.chapterId,
    endSentenceIndex: Math.max(
      ...ranges.map((range) => range.endSentenceIndex),
    ),
    ...(scores.length === 0 ? {} : { score: Math.max(...scores) }),
    startSentenceIndex: Math.min(
      ...ranges.map((range) => range.startSentenceIndex),
    ),
  };
}

export async function createExpandedSourceEvidenceRanges(
  document: ReadonlyDocument,
  ranges: readonly SourceEvidenceRange[],
  sourceContext: number,
  context: EvidenceReadContext,
): Promise<SourceEvidenceRange[]> {
  const expanded = await Promise.all(
    ranges.map(async (range) => {
      if (sourceContext <= 0) {
        return range;
      }

      const sourceIndex = await getTextStreamIndex(
        document,
        range.chapterId,
        "source",
        context,
      );
      const lastSentenceIndex = Math.max(0, sourceIndex.sentences.length - 1);

      return {
        ...range,
        endSentenceIndex: clampInteger(
          range.endSentenceIndex + sourceContext,
          range.startSentenceIndex,
          lastSentenceIndex,
        ),
        startSentenceIndex: clampInteger(
          range.startSentenceIndex - sourceContext,
          0,
          lastSentenceIndex,
        ),
      };
    }),
  );

  return mergeSourceEvidenceRangesInInputOrder(expanded);
}

export async function createSourceEvidenceItem(
  document: ReadonlyDocument,
  chapterId: number,
  startSentenceIndex: number,
  endSentenceIndex: number,
  context: EvidenceReadContext = createEvidenceReadContext(),
  score?: number,
): Promise<ArchiveEvidenceItem> {
  const chapter = await getEvidenceChapter(document, chapterId, context);
  const range = await readTextStreamRange(
    document,
    chapterId,
    "source",
    startSentenceIndex,
    endSentenceIndex,
    context,
  );

  return {
    chapterId,
    endSentenceIndex: range.endSentenceIndex,
    fragmentId: range.startSentenceIndex,
    id: formatTextStreamRangeUri(
      chapterId,
      "source",
      range.startSentenceIndex,
      range.endSentenceIndex,
    ),
    ...(score === undefined ? {} : { score }),
    source: range.text,
    startSentenceIndex: range.startSentenceIndex,
    title: chapter.title ?? `[chapter ${chapterId}]`,
    type: "source",
  };
}

export function createEvidenceReadContext(): EvidenceReadContext {
  return {
    chapters: new Map(),
    streamIndexes: new Map(),
  };
}

async function getEvidenceChapter(
  document: ReadonlyDocument,
  chapterId: number,
  context: EvidenceReadContext,
): Promise<ChapterEntry> {
  let chapter = context.chapters.get(chapterId);

  if (chapter === undefined) {
    chapter = requireChapter(document, chapterId);
    context.chapters.set(chapterId, chapter);
  }

  return await chapter;
}

async function findSentenceIndexAtOffset(
  document: ReadonlyDocument,
  chapterId: number,
  offset: number,
): Promise<number> {
  const serial = document.getSerialFragments(chapterId);
  const sentences =
    serial.listSentences === undefined ? [] : await serial.listSentences();

  if (sentences.length === 0) {
    return 0;
  }
  let cursor = 0;

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];

    if (sentence === undefined) {
      continue;
    }

    const nextCursor = cursor + sentence.text.length;

    if (offset <= nextCursor) {
      return index;
    }

    cursor = nextCursor + 1;
  }

  return Math.max(0, sentences.length - 1);
}

function mergeEvidenceRanges(
  ranges: readonly {
    readonly end: number;
    readonly score?: number;
    readonly start: number;
  }[],
): readonly {
  readonly end: number;
  readonly score?: number;
  readonly start: number;
}[] {
  const sortedRanges = [...ranges]
    .map((range) => ({
      ...(range.score === undefined ? {} : { score: range.score }),
      end: Math.max(range.start, range.end),
      start: Math.min(range.start, range.end),
    }))
    .sort((left, right) =>
      left.start === right.start
        ? left.end - right.end
        : left.start - right.start,
    );
  const mergedRanges: Array<{
    end: number;
    score?: number;
    start: number;
  }> = [];

  for (const { end, score, start } of sortedRanges) {
    const last = mergedRanges.at(-1);

    if (last === undefined || start > last.end + 1) {
      mergedRanges.push({
        end,
        ...(score === undefined ? {} : { score }),
        start,
      });
    } else {
      last.end = Math.max(last.end, end);
      if (score !== undefined) {
        last.score = Math.max(last.score ?? score, score);
      }
    }
  }

  return mergedRanges;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
