import { mkdir, rm } from "fs/promises";
import { join } from "path";

import type {
  GuaranteedRequest,
  GuaranteedRequestController,
} from "../guaranteed/index.js";
import type {
  Document,
  FragmentRecord,
  MentionLinkRecord,
  MentionRecord,
  ReadonlyDocument,
} from "../document/index.js";
import { LanguageCode, normalizeLanguageCode } from "../common/language.js";
import type { WikipageResolveProgress } from "../wikipage/index.js";
import {
  buildWikimatchSurfaceProtectionInput,
  buildWikimatchWindows,
  enrichWikimatchCandidates,
  judgeWikimatchPolicy,
  judgeWikimatchSurfaceProtection,
  matchWikispineSentenceCandidates,
  type WikimatchAcceptedMention,
  type WikimatchCandidate,
  type WikimatchSentence,
  type MatchWikispineSentenceCandidatesOptions,
} from "../wikimatch/index.js";
import type { WikipageResolverOptions } from "../wikipage/index.js";
import {
  buildWikilinkEvidenceWindows,
  discoverWikilinkRelations,
  type WikilinkEvidenceWindow,
  type WikilinkMention,
  type WikilinkSentence,
} from "../wikilink/index.js";

import { getChapterDetails, type ChapterDetails } from "./chapter.js";
import type { BuildJobProgressReporter } from "./build-queue/index.js";
import { resolveKnowledgeGraphRecallPrompt } from "./prompts.js";
import {
  createGroundingCandidatePages,
  formatGroundingEfficiency,
} from "./knowledge-graph-build/grounding.js";
import {
  parseMentionLinkRecord,
  parseMentionRecord,
  readJsonl,
  validateChapterKnowledgeGraphArtifact,
  writeJsonl,
} from "./knowledge-graph-build/artifact-io.js";

export interface ChapterKnowledgeGraphBuildArtifact {
  readonly chapterId: number;
  readonly mentionLinksPath: string;
  readonly mentionsPath: string;
  readonly parameter: GraphBuildParameterInput;
  readonly workspacePath: string;
}

export interface ChapterKnowledgeGraphInputSnapshot {
  readonly details: ChapterDetails;
  readonly fragments: readonly FragmentRecord[];
}

export interface GraphBuildParameterInput {
  readonly language?: string;
  readonly prompt: string;
}

export interface BuildChapterKnowledgeGraphArtifactOptions {
  readonly mentionLinks:
    | AsyncIterable<MentionLinkRecord>
    | Iterable<MentionLinkRecord>;
  readonly mentions: AsyncIterable<MentionRecord> | Iterable<MentionRecord>;
  readonly parameter?: GraphBuildParameterInput;
  readonly workspacePath: string;
}

export interface GenerateChapterKnowledgeGraphArtifactOptions {
  readonly policyPrompt?: string;
  readonly progressTracker?: Pick<
    BuildJobProgressReporter,
    "throwIfStopped" | "updatePhase"
  >;
  readonly request: GuaranteedRequestController;
  readonly resolverOptions?: Omit<WikipageResolverOptions, "progress">;
  readonly wikispine?: Pick<
    MatchWikispineSentenceCandidatesOptions,
    "command" | "dataDir" | "endpoint" | "provider"
  >;
  readonly workspacePath: string;
}

const WIKIMATCH_GROUNDING_MAX_OPTION_BUDGET = 50;
const WIKIMATCH_SURFACE_PROTECTION_PERCENTILE = 0.1;
const WIKILINK_EVIDENCE_DISTANCE = 700;
const WIKILINK_WINDOW_LENGTH = 1800;

export async function generateChapterKnowledgeGraphArtifact(
  document: ReadonlyDocument,
  chapterId: number,
  options: GenerateChapterKnowledgeGraphArtifactOptions,
): Promise<ChapterKnowledgeGraphBuildArtifact> {
  return await generateChapterKnowledgeGraphArtifactFromSnapshot(
    chapterId,
    await snapshotChapterKnowledgeGraphInput(document, chapterId),
    options,
  );
}

export async function snapshotChapterKnowledgeGraphInput(
  document: ReadonlyDocument,
  chapterId: number,
): Promise<ChapterKnowledgeGraphInputSnapshot> {
  const details = await getChapterDetails(document, chapterId);

  if (details.stage === "planned") {
    throw new Error(
      `Chapter ${chapterId} is planned. Set source before generating Knowledge Graph.`,
    );
  }

  return {
    details,
    fragments: await readChapterFragments(document, chapterId),
  };
}

export async function generateChapterKnowledgeGraphArtifactFromSnapshot(
  chapterId: number,
  snapshot: ChapterKnowledgeGraphInputSnapshot,
  options: GenerateChapterKnowledgeGraphArtifactOptions,
): Promise<ChapterKnowledgeGraphBuildArtifact> {
  if (snapshot.details.chapterId !== chapterId) {
    throw new Error(
      `Knowledge Graph snapshot belongs to chapter ${snapshot.details.chapterId}, not chapter ${chapterId}.`,
    );
  }
  if (snapshot.details.stage === "planned") {
    throw new Error(
      `Chapter ${chapterId} is planned. Set source before generating Knowledge Graph.`,
    );
  }

  const fragments = snapshot.fragments;
  const text = joinFragmentText(fragments);
  const sentences = createWikimatchSentences(fragments);
  const policyPrompt = resolveKnowledgeGraphRecallPrompt(options.policyPrompt);
  await options.progressTracker?.updatePhase({
    done: 0,
    phase: "matching",
    phaseDetail: "text",
    total: text.length,
    unit: "char",
  });
  const rawCandidates = await matchWikispineSentenceCandidates({
    includeDisambiguation: true,
    onProgress: async (progress) => {
      await options.progressTracker?.updatePhase({
        done: progress.coveredRangeEnd,
        force: false,
        phase: "matching",
        phaseDetail: "text",
        total: text.length,
        unit: "char",
      });
    },
    ...(options.wikispine ?? {}),
    sentences,
  });
  await options.progressTracker?.throwIfStopped();
  await options.progressTracker?.updatePhase({
    done: text.length,
    phase: "matching",
    phaseDetail: "text",
    total: text.length,
    unit: "char",
  });
  const screenedCandidates = await screenCandidates({
    candidates: rawCandidates,
    policyPrompt,
    ...(options.progressTracker === undefined
      ? {}
      : { progressTracker: options.progressTracker }),
    request: options.request,
    text,
  });
  await options.progressTracker?.throwIfStopped();
  const qidCount = countUniqueQids(screenedCandidates);
  await options.progressTracker?.updatePhase({
    done: 0,
    phase: "enrichment",
    total: qidCount,
    unit: "qid",
  });
  const enrichedCandidates = await enrichWikimatchCandidates(
    screenedCandidates,
    {
      ...(options.progressTracker === undefined
        ? {}
        : {
            progress: createEnrichmentProgressReporter(options.progressTracker),
          }),
      ...(options.resolverOptions === undefined
        ? {}
        : { resolverOptions: options.resolverOptions }),
    },
  );
  await options.progressTracker?.throwIfStopped();
  await options.progressTracker?.updatePhase({
    done: qidCount,
    phase: "enrichment",
    total: qidCount,
    unit: "qid",
  });
  const mentions = await judgeCandidates({
    candidates: enrichedCandidates,
    chapterId,
    fragments,
    policyPrompt,
    ...(options.progressTracker === undefined
      ? {}
      : { progressTracker: options.progressTracker }),
    request: options.request,
    text,
  });
  await options.progressTracker?.throwIfStopped();
  const mentionLinks = await discoverMentionLinks({
    fragments,
    mentions,
    ...(options.progressTracker === undefined
      ? {}
      : { progressTracker: options.progressTracker }),
    request: options.request,
  });
  await options.progressTracker?.throwIfStopped();
  const artifact = await buildChapterKnowledgeGraphArtifact(chapterId, {
    mentionLinks,
    mentions,
    parameter: createKnowledgeGraphParameterInput({
      policyPrompt,
      ...(options.resolverOptions === undefined
        ? {}
        : { resolverOptions: options.resolverOptions }),
    }),
    workspacePath: options.workspacePath,
  });

  return artifact;
}

export async function buildChapterKnowledgeGraphArtifact(
  chapterId: number,
  options: BuildChapterKnowledgeGraphArtifactOptions,
): Promise<ChapterKnowledgeGraphBuildArtifact> {
  const workspacePath = join(
    options.workspacePath,
    "knowledge-graph",
    `chapter-${chapterId}`,
  );
  const mentionsPath = join(workspacePath, "mentions.jsonl");
  const mentionLinksPath = join(workspacePath, "mention-links.jsonl");

  await rm(workspacePath, { force: true, recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeJsonl(mentionsPath, options.mentions, parseMentionRecord);
  await writeJsonl(
    mentionLinksPath,
    options.mentionLinks,
    parseMentionLinkRecord,
  );

  return {
    chapterId,
    mentionLinksPath,
    mentionsPath,
    parameter: options.parameter ?? {
      language: LanguageCode.Chinese,
      prompt: "",
    },
    workspacePath,
  };
}

function createKnowledgeGraphParameterInput(
  options: Pick<
    GenerateChapterKnowledgeGraphArtifactOptions,
    "policyPrompt" | "resolverOptions"
  > & { readonly policyPrompt: string },
): GraphBuildParameterInput {
  return {
    language:
      normalizeLanguageCode(options.resolverOptions?.language) ??
      LanguageCode.Chinese,
    prompt: options.policyPrompt,
  };
}

async function screenCandidates(input: {
  readonly candidates: readonly WikimatchCandidate[];
  readonly policyPrompt: string;
  readonly progressTracker?: Pick<
    BuildJobProgressReporter,
    "throwIfStopped" | "updatePhase"
  >;
  readonly request: GuaranteedRequestController;
  readonly text: string;
}): Promise<readonly WikimatchCandidate[]> {
  if (input.candidates.length === 0) {
    return [];
  }

  const protectionInput = buildWikimatchSurfaceProtectionInput({
    candidates: input.candidates,
    percentile: WIKIMATCH_SURFACE_PROTECTION_PERCENTILE,
    text: input.text,
  });

  await input.progressTracker?.updatePhase({
    done: 0,
    phase: "screening",
    phaseDetail: `${protectionInput.suspiciousSurfaces.length} high-frequency surfaces`,
    total: 1,
    unit: "window",
  });
  await input.progressTracker?.throwIfStopped();
  const protection = await judgeWikimatchSurfaceProtection({
    policyPrompt: input.policyPrompt,
    request: input.request,
    suspiciousSurfaces: protectionInput.suspiciousSurfaces,
  });
  await input.progressTracker?.throwIfStopped();
  const protectedSurfaces = new Set(
    protection.protectedSurfaces.map((surface) => surface.text),
  );
  const allowedCandidateKeys = new Set(
    protectionInput.candidates.map(createCandidateRangeKey),
  );

  await input.progressTracker?.updatePhase({
    done: 1,
    phase: "screening",
    phaseDetail: `${protectedSurfaces.size} protected surfaces`,
    total: 1,
    unit: "window",
  });

  return protectionInput.suppressedCandidates.filter(
    (candidate) =>
      allowedCandidateKeys.has(createCandidateRangeKey(candidate)) ||
      protectedSurfaces.has(candidate.surface),
  );
}

function createCandidateRangeKey(candidate: WikimatchCandidate): string {
  return `${candidate.range.start}\0${candidate.range.end}\0${candidate.surface}`;
}

async function judgeCandidates(input: {
  readonly candidates: readonly WikimatchCandidate[];
  readonly chapterId: number;
  readonly fragments: readonly FragmentRecord[];
  readonly policyPrompt: string;
  readonly progressTracker?: Pick<
    BuildJobProgressReporter,
    "throwIfStopped" | "updatePhase"
  >;
  readonly request: GuaranteedRequestController;
  readonly text: string;
}): Promise<readonly MentionRecord[]> {
  const mentions: MentionRecord[] = [];
  const sentenceLocations = buildSentenceLocations(input.fragments);
  const acceptedMentions = await groundWikimatchCandidates({
    candidates: input.candidates,
    policyPrompt: input.policyPrompt,
    ...(input.progressTracker === undefined
      ? {}
      : { progressTracker: input.progressTracker }),
    request: input.request,
    text: input.text,
  });
  let mentionIndex = 1;

  for (const mention of acceptedMentions) {
    const location = locateMention(sentenceLocations, mention.range.start);

    mentions.push(
      toMentionRecord(input.chapterId, mention, location, mentionIndex),
    );
    mentionIndex += 1;
  }

  return mentions;
}

export async function groundWikimatchCandidates(input: {
  readonly candidates: readonly WikimatchCandidate[];
  readonly policyPrompt: string;
  readonly progressTracker?: Pick<
    BuildJobProgressReporter,
    "throwIfStopped" | "updatePhase"
  >;
  readonly request: GuaranteedRequestController;
  readonly text: string;
}): Promise<readonly WikimatchAcceptedMention[]> {
  const mentions: WikimatchAcceptedMention[] = [];
  const candidatePages = createGroundingCandidatePages(input.candidates);
  let completedWindows = 0;
  let totalWindows = 0;

  let activeCandidates = candidatePages.nextPage();

  while (activeCandidates.length > 0) {
    const windows = buildWikimatchWindows({
      candidates: activeCandidates,
      contextWords: 220,
      optionBudget: WIKIMATCH_GROUNDING_MAX_OPTION_BUDGET,
      text: input.text,
    });

    totalWindows += windows.length;
    if (windows.length === 0) {
      break;
    }
    await input.progressTracker?.updatePhase({
      done: completedWindows,
      phase: "grounding",
      total: totalWindows,
      unit: "window",
    });

    const results = await mapLazyGuaranteedRequests(
      input.request,
      windows,
      async (window, request) => {
        try {
          await input.progressTracker?.throwIfStopped();
          return await judgeWikimatchPolicy({
            candidates: window.candidates,
            policyPrompt: input.policyPrompt,
            request,
            window,
          });
        } finally {
          completedWindows += 1;
          await input.progressTracker?.updatePhase({
            done: completedWindows,
            phase: "grounding",
            total: totalWindows,
            unit: "window",
          });
        }
      },
    );

    const continuedCandidateIds = new Set<string>();

    for (const result of results) {
      for (const mention of result.mentions) {
        mentions.push(mention);
        candidatePages.accept(mention);
      }
      for (const update of result.policyUpdates) {
        candidatePages.close(update.candidateId, update.decision);
      }
      for (const continuation of result.continuations) {
        for (const candidateId of continuation.candidateIds) {
          continuedCandidateIds.add(candidateId);
          candidatePages.continue(candidateId);
        }
      }
    }

    activeCandidates = candidatePages.nextPage(continuedCandidateIds);
  }

  await input.progressTracker?.updatePhase({
    done: completedWindows,
    phase: "grounding",
    phaseDetail: formatGroundingEfficiency(
      candidatePages.getStats(),
      mentions.length,
    ),
    total: totalWindows,
    unit: "window",
  });

  return mentions;
}

export function createEnrichmentProgressReporter(
  progressTracker: Pick<
    BuildJobProgressReporter,
    "throwIfStopped" | "updatePhase"
  >,
): (event: WikipageResolveProgress) => Promise<void> {
  return async (event) => {
    await progressTracker.throwIfStopped();
    const phase = formatEnrichmentProgressPhase(event);

    await progressTracker.updatePhase({
      done: event.done,
      ...(phase.detail === undefined ? {} : { phaseDetail: phase.detail }),
      phase: "enrichment",
      total: event.total,
      unit: phase.unit,
    });
  };
}

function formatEnrichmentProgressPhase(event: WikipageResolveProgress): {
  readonly detail?: string;
  readonly unit: "page" | "qid" | "record";
} {
  switch (event.detail) {
    case "disambiguation-page":
      return {
        detail: "disambiguation",
        unit: "page",
      };
    case "entity":
      return {
        detail: "entity",
        unit: "record",
      };
    case "linked-page":
      return {
        detail: "linked",
        unit: "page",
      };
    case "page":
      return {
        detail: "page",
        unit: "page",
      };
    case "qid":
      return {
        unit: "qid",
      };
  }
}

async function mapLazyGuaranteedRequests<TItem, TResult>(
  request: GuaranteedRequestController,
  items: readonly TItem[],
  operation: (item: TItem, request: GuaranteedRequest) => Promise<TResult>,
): Promise<readonly TResult[]> {
  const lazy = request.lazy;

  if (lazy !== undefined) {
    return await Promise.all(
      items.map(
        async (item) =>
          await lazy(async (request) => await operation(item, request)),
      ),
    );
  }

  const results: TResult[] = [];

  for (const item of items) {
    results.push(await operation(item, request));
  }

  return results;
}

async function discoverMentionLinks(input: {
  readonly fragments: readonly FragmentRecord[];
  readonly mentions: readonly MentionRecord[];
  readonly progressTracker?: Pick<
    BuildJobProgressReporter,
    "throwIfStopped" | "updatePhase"
  >;
  readonly request: GuaranteedRequestController;
}): Promise<readonly MentionLinkRecord[]> {
  const fragmentWindows = buildMentionLinkWindows(
    input.fragments,
    input.mentions,
  );
  let completedWindows = 0;

  await input.progressTracker?.updatePhase({
    done: 0,
    phase: "relation-discovery",
    total: fragmentWindows.length,
    unit: "window",
  });

  const discoveredLinks = (
    await mapLazyGuaranteedRequests(
      input.request,
      fragmentWindows,
      async (item, request) => {
        try {
          await input.progressTracker?.throwIfStopped();
          return await discoverWikilinkRelations({
            chapterId: item.fragment.serialId,
            fragmentId: item.fragment.fragmentId,
            request,
            sentences: item.fragment.sentences,
            window: item.window,
          });
        } finally {
          completedWindows += 1;
          await input.progressTracker?.updatePhase({
            done: completedWindows,
            phase: "relation-discovery",
            total: fragmentWindows.length,
            unit: "window",
          });
        }
      },
    )
  ).flat();

  return discoveredLinks.map((link, index) => ({
    ...(link.confidence === undefined ? {} : { confidence: link.confidence }),
    evidenceSentenceIds: link.evidenceSentenceIds,
    id: `l${input.fragments[0]?.serialId ?? 0}-${index + 1}`,
    predicate: link.predicate,
    sourceMentionId: link.sourceMentionId,
    targetMentionId: link.targetMentionId,
  }));
}

function buildMentionLinkWindows(
  fragments: readonly FragmentRecord[],
  mentions: readonly MentionRecord[],
): ReadonlyArray<{
  readonly fragment: FragmentRecord;
  readonly window: WikilinkEvidenceWindow;
}> {
  return fragments.flatMap((fragment) => {
    const startSentenceIndex = fragment.fragmentId;
    const endSentenceIndex = startSentenceIndex + fragment.sentences.length - 1;
    const fragmentMentions = toWikilinkMentions(
      fragment.sentences,
      mentions.filter(
        (mention) =>
          mention.sentenceIndex !== undefined &&
          mention.sentenceIndex >= startSentenceIndex &&
          mention.sentenceIndex <= endSentenceIndex,
      ),
      startSentenceIndex,
    );
    const windows = buildWikilinkEvidenceWindows({
      maxEvidenceDistance: WIKILINK_EVIDENCE_DISTANCE,
      mentions: fragmentMentions,
      text: joinSentences(fragment.sentences),
      windowLength: WIKILINK_WINDOW_LENGTH,
    });

    return windows.map((window) => ({
      fragment,
      window,
    }));
  });
}

function toWikilinkMentions(
  sentences: readonly WikilinkSentence[],
  mentions: readonly MentionRecord[],
  startSentenceIndex: number,
): readonly WikilinkMention[] {
  const sentenceOffsets = buildFragmentSentenceOffsets(sentences);

  return mentions.flatMap((mention) => {
    if (mention.sentenceIndex === undefined) {
      return [];
    }

    const sentenceOffset =
      sentenceOffsets[mention.sentenceIndex - startSentenceIndex];

    if (sentenceOffset === undefined) {
      return [];
    }

    return [
      {
        id: mention.id,
        qid: mention.qid,
        range: {
          end: sentenceOffset.start + mention.rangeEnd,
          start: sentenceOffset.start + mention.rangeStart,
        },
        surface: mention.surface,
      },
    ];
  });
}

function buildFragmentSentenceOffsets(
  sentences: readonly WikilinkSentence[],
): ReadonlyArray<{ readonly end: number; readonly start: number }> {
  const offsets: Array<{ readonly end: number; readonly start: number }> = [];
  let cursor = 0;

  for (const sentence of sentences) {
    const start = cursor;
    const end = start + sentence.text.length;

    offsets.push({ end, start });
    cursor = end + 1;
  }

  return offsets;
}

function joinSentences(sentences: readonly WikilinkSentence[]): string {
  return sentences.map((sentence) => sentence.text).join(" ");
}

function countUniqueQids(candidates: readonly WikimatchCandidate[]): number {
  return new Set(
    candidates.flatMap((candidate) =>
      candidate.qidOptions.map((option) => option.qid),
    ),
  ).size;
}

function toMentionRecord(
  chapterId: number,
  mention: WikimatchAcceptedMention,
  location: {
    readonly rangeStart: number;
    readonly sentenceIndex: number;
  },
  index: number,
): MentionRecord {
  return {
    chapterId,
    ...(mention.confidence === undefined
      ? {}
      : { confidence: mention.confidence }),
    id: `m${chapterId}-${index}`,
    ...(mention.note === undefined ? {} : { note: mention.note }),
    qid: mention.qid,
    rangeEnd: location.rangeStart + mention.surface.length,
    rangeStart: location.rangeStart,
    sentenceIndex: location.sentenceIndex,
    surface: mention.surface,
  };
}

interface SentenceLocation {
  readonly absoluteStart: number;
  readonly length: number;
  readonly sentenceIndex: number;
}

function buildSentenceLocations(
  fragments: readonly FragmentRecord[],
): readonly SentenceLocation[] {
  const locations: SentenceLocation[] = [];
  let offset = 0;

  for (const fragment of fragments) {
    for (
      let sentenceIndex = 0;
      sentenceIndex < fragment.sentences.length;
      sentenceIndex += 1
    ) {
      const length = fragment.sentences[sentenceIndex]!.text.length;

      locations.push({
        absoluteStart: offset,
        length,
        sentenceIndex: fragment.fragmentId + sentenceIndex,
      });
      offset += length + 1;
    }
  }

  return locations;
}

function locateMention(
  locations: readonly SentenceLocation[],
  absoluteOffset: number,
): {
  readonly rangeStart: number;
  readonly sentenceIndex: number;
} {
  for (const location of locations) {
    const rangeEnd = location.absoluteStart + location.length;

    if (absoluteOffset >= location.absoluteStart && absoluteOffset < rangeEnd) {
      return {
        rangeStart: absoluteOffset - location.absoluteStart,
        sentenceIndex: location.sentenceIndex,
      };
    }
  }

  throw new Error(`Mention offset ${absoluteOffset} is outside chapter text.`);
}

async function readChapterFragments(
  document: ReadonlyDocument,
  chapterId: number,
): Promise<readonly FragmentRecord[]> {
  const serialFragments = document.getSerialFragments(chapterId);

  return await Promise.all(
    (await serialFragments.listFragmentIds()).map(
      async (fragmentId) => await serialFragments.getFragment(fragmentId),
    ),
  );
}

function joinFragmentText(fragments: readonly FragmentRecord[]): string {
  return fragments
    .flatMap((fragment) => fragment.sentences.map((sentence) => sentence.text))
    .join(" ");
}

function createWikimatchSentences(
  fragments: readonly FragmentRecord[],
): readonly WikimatchSentence[] {
  const sentences: WikimatchSentence[] = [];
  let offset = 0;

  for (const fragment of fragments) {
    for (let index = 0; index < fragment.sentences.length; index += 1) {
      const sentence = fragment.sentences[index]!;

      sentences.push({
        id: `${fragment.serialId}:${fragment.fragmentId + index}`,
        range: {
          end: offset + sentence.text.length,
          start: offset,
        },
        text: sentence.text,
      });
      offset += sentence.text.length + 1;
    }
  }

  return sentences;
}

export async function commitChapterKnowledgeGraphArtifact(
  document: Document,
  artifact: ChapterKnowledgeGraphBuildArtifact,
): Promise<void> {
  const mentions = await readJsonl(artifact.mentionsPath, parseMentionRecord);
  const mentionLinks = await readJsonl(
    artifact.mentionLinksPath,
    parseMentionLinkRecord,
  );

  validateChapterKnowledgeGraphArtifact(artifact.chapterId, {
    mentionLinks,
    mentions,
  });

  await document.openSession(async (openedDocument) => {
    await openedDocument.serials.ensure(artifact.chapterId);
    const existingLinks = await openedDocument.mentionLinks.listByChapter(
      artifact.chapterId,
    );

    if (existingLinks.length > 0 && mentionLinks.length === 0) {
      throw new Error(
        `Refusing to replace chapter ${artifact.chapterId} knowledge graph with an artifact that contains no mention links.`,
      );
    }

    await openedDocument.mentionLinks.deleteByChapter(artifact.chapterId);
    await openedDocument.mentions.deleteByChapter(artifact.chapterId);
    await openedDocument.mentions.saveMany(mentions);
    await openedDocument.mentionLinks.saveMany(mentionLinks);
    const parameter = await openedDocument.graphBuildParameters.save(
      artifact.parameter,
    );
    await openedDocument.serials.setKnowledgeGraphReady(
      artifact.chapterId,
      true,
      parameter.hash,
    );
  });
}

export async function clearChapterKnowledgeGraph(
  document: Document,
  chapterId: number,
): Promise<void> {
  await document.openSession(async (openedDocument) => {
    await openedDocument.mentionLinks.deleteByChapter(chapterId);
    await openedDocument.mentions.deleteByChapter(chapterId);
    await openedDocument.serials.setKnowledgeGraphReady(chapterId, false);
    await openedDocument.graphBuildParameters.deleteUnreferenced();
  });
}
