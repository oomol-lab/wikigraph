import { createHash } from "crypto";

import {
  getNumber,
  type Database,
  type SqlBindValue,
} from "../document/database.js";
import type { ReadonlyDocument } from "../document/index.js";

import {
  createSearchTokenPlan,
  hasSearchTokens,
  listSearchPlanTerms,
  normalizeSearchText,
  type SearchTokenPlan,
} from "./search-tokenizer.js";
import type {
  ArchiveFindMatch,
  ArchiveFindObjectType,
} from "./archive-view.js";

export const TEXT_SENTENCE_KIND = {
  source: 1,
  summary: 2,
} as const;

export type TextSentenceKind =
  (typeof TEXT_SENTENCE_KIND)[keyof typeof TEXT_SENTENCE_KIND];

export const SEARCH_OBJECT_KIND = {
  chapterTitle: 1,
  nodeLabel: 2,
  nodeContent: 3,
} as const;

export type SearchObjectKind =
  (typeof SEARCH_OBJECT_KIND)[keyof typeof SEARCH_OBJECT_KIND];

export interface TextSentenceRecordInput {
  readonly chapterId: number;
  readonly kind: TextSentenceKind;
  readonly sentenceIndex: number;
  readonly text: string;
  readonly wordsCount: number;
}

export interface SearchObjectRecordInput {
  readonly chapterId?: number;
  readonly kind: SearchObjectKind;
  readonly refId: number;
  readonly sentenceIndex?: number;
  readonly text: string;
}

export interface SearchIndexInput {
  readonly objects: readonly SearchObjectRecordInput[];
  readonly textSentences: readonly TextSentenceRecordInput[];
}

export interface SearchIndexTextHit {
  readonly chapterId: number;
  readonly kind: TextSentenceKind;
  readonly score: number;
  readonly sentenceIndex: number;
  readonly wordsCount: number;
}

export interface SearchIndexObjectHit {
  readonly chapterId?: number;
  readonly kind: SearchObjectKind;
  readonly refId: number;
  readonly score: number;
  readonly sentenceIndex?: number;
}

export interface SearchIndexQueryResult {
  readonly objectHits: readonly SearchIndexObjectHit[];
  readonly terms: readonly string[];
  readonly textHits: readonly SearchIndexTextHit[];
}

const SEARCH_INDEX_VERSION = "2";
const SEARCH_INDEX_OBJECT_TARGET = 1;
const TIER_WEIGHTS = [1, 0.45, 0.08] as const;

export async function ensureSearchIndex(
  document: ReadonlyDocument,
  input: SearchIndexInput,
): Promise<void> {
  await document.readDatabase(async (database) => {
    const fingerprint = createSearchIndexFingerprint(input);
    const current = await database.queryAll(
      `
        SELECT key, value
        FROM search_index_state
        WHERE key IN ('version', 'fingerprint')
      `,
      undefined,
      (row) => [String(row.key), String(row.value)] as const,
    );
    const state = new Map(current);

    if (
      state.get("version") === SEARCH_INDEX_VERSION &&
      state.get("fingerprint") === fingerprint
    ) {
      return;
    }

    await database.transaction(async () => {
      await database.run("DELETE FROM text_sentence_fts");
      await database.run("DELETE FROM text_sentence_records");
      await database.run("DELETE FROM search_object_fts");
      await database.run("DELETE FROM search_object_records");
      await database.run("DELETE FROM search_index_state");

      for (const record of input.textSentences) {
        const plan = createSearchTokenPlan(record.text);
        const rowId = await insertTextSentenceRecord(database, record);

        await insertFtsRecord(database, "text_sentence_fts", rowId, plan);
      }

      for (const record of input.objects) {
        const plan = createSearchTokenPlan(record.text);
        const rowId = await insertSearchObjectRecord(database, record);

        await insertFtsRecord(database, "search_object_fts", rowId, plan);
      }

      await database.run(
        `
          INSERT INTO search_index_state(key, value)
          VALUES ('version', ?)
        `,
        [SEARCH_INDEX_VERSION],
      );
      await database.run(
        `
          INSERT INTO search_index_state(key, value)
          VALUES ('fingerprint', ?)
        `,
        [fingerprint],
      );
    });
  });
}

export async function querySearchIndex(
  document: ReadonlyDocument,
  query: string,
  options: {
    readonly chapters?: readonly number[];
    readonly match?: ArchiveFindMatch;
    readonly types?: readonly ArchiveFindObjectType[] | null;
  } = {},
): Promise<SearchIndexQueryResult | undefined> {
  const plan = createSearchTokenPlan(query);

  if (!hasSearchTokens(plan)) {
    return undefined;
  }

  const terms = listSearchPlanTerms(plan);

  return await document.readDatabase(async (database) => {
    const tierQueries = createTierQueries(query, plan, options.match ?? "any");
    const objectHitsByKey = new Map<string, SearchIndexObjectHit>();
    const textHitsByKey = new Map<string, SearchIndexTextHit>();

    for (const tierQuery of tierQueries) {
      if (tierQuery.matchExpression === "") {
        continue;
      }

      const [objectRows, textRows] = await Promise.all([
        queryObjectRows(database, tierQuery.matchExpression, options),
        queryTextRows(database, tierQuery.matchExpression, options),
      ]);

      for (const hit of objectRows) {
        objectHitsByKey.set(createObjectHitKey(hit), hit);
      }
      for (const hit of textRows) {
        textHitsByKey.set(createTextHitKey(hit), hit);
      }

      if (
        objectHitsByKey.size + textHitsByKey.size >=
          SEARCH_INDEX_OBJECT_TARGET &&
        options.match !== "all"
      ) {
        break;
      }
    }

    return {
      objectHits: [...objectHitsByKey.values()],
      terms,
      textHits: [...textHitsByKey.values()],
    };
  });
}

async function queryObjectRows(
  database: Database,
  matchExpression: string,
  options: {
    readonly chapters?: readonly number[];
    readonly types?: readonly ArchiveFindObjectType[] | null;
  },
): Promise<readonly SearchIndexObjectHit[]> {
  if (!shouldQueryObjects(options.types)) {
    return [];
  }

  return await database.queryAll(
    `
      SELECT
        r.kind AS kind,
        r.ref_id AS ref_id,
        r.chapter_id AS chapter_id,
        r.sentence_index AS sentence_index,
        bm25(search_object_fts, ?, ?, ?) AS rank
      FROM search_object_fts
      JOIN search_object_records AS r
        ON r.id = search_object_fts.rowid
      WHERE search_object_fts MATCH ?
        ${createChapterSql(options.chapters)}
      ORDER BY rank ASC, r.chapter_id, r.sentence_index, r.kind, r.ref_id
    `,
    [
      ...TIER_WEIGHTS,
      matchExpression,
      ...createChapterParams(options.chapters),
    ],
    (row) => ({
      kind: getNumber(row, "kind") as SearchObjectKind,
      refId: getNumber(row, "ref_id"),
      score: rankToScore(getNumber(row, "rank")),
      ...(row.chapter_id === null
        ? {}
        : { chapterId: getNumber(row, "chapter_id") }),
      ...(row.sentence_index === null
        ? {}
        : { sentenceIndex: getNumber(row, "sentence_index") }),
    }),
  );
}

async function queryTextRows(
  database: Database,
  matchExpression: string,
  options: {
    readonly chapters?: readonly number[];
    readonly types?: readonly ArchiveFindObjectType[] | null;
  },
): Promise<readonly SearchIndexTextHit[]> {
  const kinds = createTextKindFilter(options.types);

  if (kinds.length === 0) {
    return [];
  }

  return await database.queryAll(
    `
      SELECT
        r.kind AS kind,
        r.chapter_id AS chapter_id,
        r.sentence_index AS sentence_index,
        r.words_count AS words_count,
        bm25(text_sentence_fts, ?, ?, ?) AS rank
      FROM text_sentence_fts
      JOIN text_sentence_records AS r
        ON r.id = text_sentence_fts.rowid
      WHERE text_sentence_fts MATCH ?
        AND r.kind IN (${kinds.map(() => "?").join(", ")})
        ${createChapterSql(options.chapters)}
      ORDER BY rank ASC, r.chapter_id, r.sentence_index, r.kind
    `,
    [
      ...TIER_WEIGHTS,
      matchExpression,
      ...kinds,
      ...createChapterParams(options.chapters),
    ],
    (row) => ({
      chapterId: getNumber(row, "chapter_id"),
      kind: getNumber(row, "kind") as TextSentenceKind,
      score: rankToScore(getNumber(row, "rank")),
      sentenceIndex: getNumber(row, "sentence_index"),
      wordsCount: getNumber(row, "words_count"),
    }),
  );
}

function createTierQueries(
  query: string,
  plan: SearchTokenPlan,
  match: ArchiveFindMatch,
): readonly {
  readonly matchExpression: string;
}[] {
  if (match === "all") {
    return createAllMatchTierQueries(query);
  }

  return [
    {
      matchExpression: createMatchExpression([
        { column: "tier1", tokens: plan.tier1.map((token) => token.encoded) },
      ]),
    },
    {
      matchExpression: createMatchExpression([
        { column: "tier1", tokens: plan.tier1.map((token) => token.encoded) },
        { column: "tier2", tokens: plan.tier2.map((token) => token.encoded) },
      ]),
    },
    {
      matchExpression: createMatchExpression([
        { column: "tier1", tokens: plan.tier1.map((token) => token.encoded) },
        { column: "tier2", tokens: plan.tier2.map((token) => token.encoded) },
        { column: "tier3", tokens: plan.tier3.map((token) => token.encoded) },
      ]),
    },
  ];
}

function createAllMatchTierQueries(query: string): readonly {
  readonly matchExpression: string;
}[] {
  const termPlans = normalizeSearchText(query)
    .split(/\s+/u)
    .map((term) => createSearchTokenPlan(term))
    .filter(hasSearchTokens);

  const createExpression = (
    selectTokens: (plan: SearchTokenPlan) => readonly string[],
  ): string =>
    termPlans
      .map((termPlan) => {
        const tokens = [...new Set(selectTokens(termPlan))];

        return tokens.length === 0 ? "" : `(${tokens.join(" OR ")})`;
      })
      .filter((term) => term !== "")
      .join(" AND ");

  return [
    {
      matchExpression: createExpression((termPlan) =>
        termPlan.tier1.map((token) => `tier1:${escapeFtsToken(token.encoded)}`),
      ),
    },
    {
      matchExpression: createExpression((termPlan) => [
        ...termPlan.tier1.map(
          (token) => `tier1:${escapeFtsToken(token.encoded)}`,
        ),
        ...termPlan.tier2.map(
          (token) => `tier2:${escapeFtsToken(token.encoded)}`,
        ),
      ]),
    },
    {
      matchExpression: createExpression((termPlan) => [
        ...termPlan.tier1.map(
          (token) => `tier1:${escapeFtsToken(token.encoded)}`,
        ),
        ...termPlan.tier2.map(
          (token) => `tier2:${escapeFtsToken(token.encoded)}`,
        ),
        ...termPlan.tier3.map(
          (token) => `tier3:${escapeFtsToken(token.encoded)}`,
        ),
      ]),
    },
  ];
}

function createMatchExpression(
  groups: readonly {
    readonly column: string;
    readonly tokens: readonly string[];
  }[],
): string {
  return groups
    .map((group) => ({
      ...group,
      tokens: [...new Set(group.tokens)],
    }))
    .filter((group) => group.tokens.length > 0)
    .map(
      (group) =>
        `${group.column}:(${group.tokens.map(escapeFtsToken).join(" OR ")})`,
    )
    .join(" OR ");
}

function escapeFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

async function insertTextSentenceRecord(
  database: Database,
  record: TextSentenceRecordInput,
): Promise<number> {
  await database.run(
    `
      INSERT INTO text_sentence_records (
        kind, chapter_id, sentence_index, words_count
      )
      VALUES (?, ?, ?, ?)
    `,
    [record.kind, record.chapterId, record.sentenceIndex, record.wordsCount],
  );

  return await database.getLastInsertRowId();
}

async function insertSearchObjectRecord(
  database: Database,
  record: SearchObjectRecordInput,
): Promise<number> {
  await database.run(
    `
      INSERT INTO search_object_records (
        kind, ref_id, chapter_id, sentence_index
      )
      VALUES (?, ?, ?, ?)
    `,
    [
      record.kind,
      record.refId,
      record.chapterId ?? null,
      record.sentenceIndex ?? null,
    ],
  );

  return await database.getLastInsertRowId();
}

async function insertFtsRecord(
  database: Database,
  table: "search_object_fts" | "text_sentence_fts",
  rowId: number,
  plan: SearchTokenPlan,
): Promise<void> {
  await database.run(
    `
      INSERT INTO ${table}(rowid, tier1, tier2, tier3)
      VALUES (?, ?, ?, ?)
    `,
    [
      rowId,
      serializeTokens(plan.tier1),
      serializeTokens(plan.tier2),
      serializeTokens(plan.tier3),
    ],
  );
}

function createSearchIndexFingerprint(input: SearchIndexInput): string {
  const hash = createHash("sha256");

  for (const record of input.textSentences) {
    hash.update("text");
    hash.update("\0");
    hash.update(String(record.kind));
    hash.update("\0");
    hash.update(String(record.chapterId));
    hash.update("\0");
    hash.update(String(record.sentenceIndex));
    hash.update("\0");
    hash.update(record.text);
    hash.update("\0");
  }

  for (const record of input.objects) {
    hash.update("object");
    hash.update("\0");
    hash.update(String(record.kind));
    hash.update("\0");
    hash.update(String(record.refId));
    hash.update("\0");
    hash.update(record.text);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function serializeTokens(
  tokens: readonly {
    readonly encoded: string;
  }[],
): string {
  return tokens.map((token) => token.encoded).join(" ");
}

function createChapterSql(chapters: readonly number[] | undefined): string {
  return chapters === undefined || chapters.length === 0
    ? ""
    : `AND r.chapter_id IN (${chapters.map(() => "?").join(", ")})`;
}

function createChapterParams(
  chapters: readonly number[] | undefined,
): readonly SqlBindValue[] {
  return chapters === undefined ? [] : [...chapters];
}

function shouldQueryObjects(
  types: readonly ArchiveFindObjectType[] | null | undefined,
): boolean {
  return (
    types === undefined ||
    types === null ||
    types.includes("chapter") ||
    types.includes("node")
  );
}

function createTextKindFilter(
  types: readonly ArchiveFindObjectType[] | null | undefined,
): readonly TextSentenceKind[] {
  if (types === undefined || types === null) {
    return [TEXT_SENTENCE_KIND.summary, TEXT_SENTENCE_KIND.source];
  }

  const kinds: TextSentenceKind[] = [];

  if (types.includes("summary")) {
    kinds.push(TEXT_SENTENCE_KIND.summary);
  }
  if (types.includes("source")) {
    kinds.push(TEXT_SENTENCE_KIND.source);
  }

  return kinds;
}

function rankToScore(rank: number): number {
  return 1 / (1 + Math.max(0, Math.abs(rank)));
}

function createObjectHitKey(hit: SearchIndexObjectHit): string {
  return [
    hit.kind,
    hit.refId,
    hit.chapterId ?? "",
    hit.sentenceIndex ?? "",
  ].join(":");
}

function createTextHitKey(hit: SearchIndexTextHit): string {
  return [hit.kind, hit.chapterId, hit.sentenceIndex].join(":");
}
