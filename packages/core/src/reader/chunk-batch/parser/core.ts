import { ParsedJsonError, requestGuaranteedJson } from "../../../guaranteed/index.js";
import type { LLMessage } from "../../../llm/index.js";
import {
  expectChunkImportance,
  expectChunkRetention,
  type ChunkImportance,
  type SentenceId,
} from "../../../document/index.js";
import {
  resolveEvidenceSelectionList,
  EvidenceResolver,
  type EvidenceResolutionFailure,
  type RankedSentenceCandidate,
} from "../../../evidence-selection/index.js";
import type {
  ChunkBatch,
  ChunkExtractionSentence,
  ChunkImportanceAnnotation,
  ChunkLink,
  CognitiveChunk,
  SentenceTextSource,
} from "../types.js";
import type { FragmentProjection } from "../fragment-projection.js";
import {
  createEvidenceSelectionList,
  toEvidenceResolutionFailure,
} from "./evidence.js";
import {
  createMembershipRecord,
  createSentenceKey,
  createSentenceTextRecord,
  createWordsCountRecord,
  expectSingleSpan,
  formatChoiceCandidate,
  formatError,
  hasMembership,
  isParsedJsonValidationFailure,
  isRecord,
  normalizeChunkLinks,
  toChoiceFieldName,
} from "./helpers.js";
import {
  choiceResponseSchema,
  ChunkMetadataField,
  type BookCoherenceChunkData,
  type BookCoherenceResponseData,
  type ExtractChunksResult,
  type GuaranteedChoiceRequest,
  type SelectAmbiguousCandidateInput,
  type UserFocusedChunkData,
  type UserFocusedResponseData,
  type ResolveChunkEvidenceInput,
} from "./schema.js";

const MAX_CHOICE_RETRIES = 3;

export class ChunkBatchParser<
  TData extends UserFocusedResponseData | BookCoherenceResponseData,
> {
  readonly #choiceSystemPrompt: string;
  readonly #evidenceResolver = new EvidenceResolver();
  readonly #metadataField: ChunkMetadataField;
  readonly #projection: FragmentProjection;
  readonly #responseIntentClassifierPrompt: string;
  readonly #requestChoice: GuaranteedChoiceRequest;
  readonly #sentenceTextByKey: Readonly<Record<string, string>>;
  readonly #sentenceTextSource: SentenceTextSource;
  readonly #wordsCountByKey: Readonly<Record<string, number>>;
  readonly #validImportanceChunkIds: Readonly<Record<string, true>> | undefined;
  readonly #visibleChunkIds: readonly number[];

  public constructor(input: {
    choiceSystemPrompt: string;
    metadataField: ChunkMetadataField;
    projection: FragmentProjection;
    responseIntentClassifierPrompt: string;
    requestChoice: GuaranteedChoiceRequest;
    sentenceTextSource: SentenceTextSource;
    sentences: readonly ChunkExtractionSentence[];
    validImportanceChunkIds?: readonly number[];
    visibleChunkIds: readonly number[];
  }) {
    this.#choiceSystemPrompt = input.choiceSystemPrompt;
    this.#metadataField = input.metadataField;
    this.#projection = input.projection;
    this.#responseIntentClassifierPrompt = input.responseIntentClassifierPrompt;
    this.#requestChoice = input.requestChoice;
    this.#sentenceTextSource = input.sentenceTextSource;
    this.#visibleChunkIds = input.visibleChunkIds;

    this.#wordsCountByKey = createWordsCountRecord(
      input.projection.sentences.map((sentence) => ({
        sentenceId: sentence.sentenceId,
        wordsCount: sentence.wordsCount,
      })),
    );
    this.#sentenceTextByKey = createSentenceTextRecord(input.projection);
    this.#validImportanceChunkIds =
      input.validImportanceChunkIds === undefined
        ? undefined
        : createMembershipRecord(input.validImportanceChunkIds);
  }

  public async parse(
    parsedData: TData,
    input: {
      isLastGenerationAttempt: boolean;
    },
  ): Promise<ExtractChunksResult> {
    const issues: string[] = [];
    const chunks: ChunkBatch["chunks"] = [];
    const tempIds: string[] = [];
    const importanceAnnotations =
      "importance_annotations" in parsedData
        ? this.#validateImportanceAnnotations(
            parsedData.importance_annotations,
            issues,
          )
        : undefined;
    const fragmentSummary =
      "fragment_summary" in parsedData
        ? parsedData.fragment_summary
        : undefined;
    const links = normalizeChunkLinks(parsedData.links);

    for (const [index, data] of parsedData.chunks.entries()) {
      const chunkIndex = index + 1;
      const chunkIssues: string[] = [];
      const label = data.label.trim();
      const content = data.content.trim();

      if (label === "") {
        chunkIssues.push(
          `Chunk #${chunkIndex}: Missing or empty "label" field`,
        );
      }

      if (content === "") {
        chunkIssues.push(
          `Chunk #${chunkIndex}: Missing or empty "content" field`,
        );
      }

      const [matchedSentenceIds, evidenceFailure] =
        await this.#resolveChunkEvidence({
          chunkIndex,
          chunkLabel: label,
          data,
          isLastGenerationAttempt: input.isLastGenerationAttempt,
        });

      if (matchedSentenceIds.length === 0) {
        if (evidenceFailure !== undefined) {
          chunkIssues.push(
            `Chunk #${chunkIndex} ("${label}"): ${evidenceFailure.message}`,
          );
        } else {
          chunkIssues.push(
            `Chunk #${chunkIndex} ("${label}"): Missing evidence`,
          );
        }
      }

      if (chunkIssues.length > 0) {
        issues.push(...chunkIssues);
        continue;
      }

      const primarySentenceId = matchedSentenceIds[0];

      if (primarySentenceId === undefined) {
        issues.push(
          `Chunk #${chunkIndex} ("${label}"): Unable to resolve any sentence IDs`,
        );
        continue;
      }

      const totalWordsCount = matchedSentenceIds.reduce((sum, sentenceId) => {
        return (
          sum + (this.#wordsCountByKey[createSentenceKey(sentenceId)] ?? 0)
        );
      }, 0);

      if (this.#metadataField === ChunkMetadataField.Retention) {
        const chunkData = data as UserFocusedChunkData;

        chunks.push({
          content,
          generation: 0,
          id: 0,
          label,
          links: [],
          retention: expectChunkRetention(chunkData.retention),
          sentenceId: primarySentenceId,
          sentenceIds: [...matchedSentenceIds],
          wordsCount: totalWordsCount,
        });
      } else {
        const chunkData = data as BookCoherenceChunkData;

        chunks.push({
          content,
          generation: 0,
          id: 0,
          importance: expectChunkImportance(chunkData.importance),
          label,
          links: [],
          sentenceId: primarySentenceId,
          sentenceIds: [...matchedSentenceIds],
          wordsCount: totalWordsCount,
        });
      }

      tempIds.push(data.temp_id);
    }

    const validLinks = this.#filterAndValidateLinks({
      issues,
      links,
      tempIds,
      visibleChunkIds: this.#visibleChunkIds,
    });

    if (issues.length > 0) {
      throw new ParsedJsonError(issues);
    }

    return {
      chunkBatch: {
        chunks,
        links: validLinks,
        orderCorrect: true,
        tempIds,
        ...(importanceAnnotations === undefined
          ? {}
          : { importanceAnnotations }),
      },
      ...(fragmentSummary === undefined ? {} : { fragmentSummary }),
    };
  }

  public async getChunkSourceSentences(
    chunk: CognitiveChunk,
  ): Promise<string[]> {
    const sourceSentences: string[] = [];

    for (const sentenceId of chunk.sentenceIds) {
      const sentenceKey = createSentenceKey(sentenceId);
      const sentenceText = this.#sentenceTextByKey[sentenceKey];

      if (sentenceText !== undefined) {
        sourceSentences.push(sentenceText);
        continue;
      }

      sourceSentences.push(
        await this.#sentenceTextSource.getSentence(sentenceId),
      );
    }

    return sourceSentences;
  }

  async #resolveChunkEvidence(
    input: ResolveChunkEvidenceInput,
  ): Promise<
    readonly [
      sentenceIds: readonly SentenceId[],
      failure: EvidenceResolutionFailure | undefined,
    ]
  > {
    const evidence = input.data.evidence;

    if (evidence === undefined || evidence === null) {
      return [[], undefined];
    }

    if (!isRecord(evidence) && !Array.isArray(evidence)) {
      return [
        [],
        {
          candidates: [],
          code: "invalid_evidence",
          fieldName: "evidence",
          message: `Chunk #${input.chunkIndex} ("${input.chunkLabel}"): evidence must be an object or array`,
        },
      ];
    }

    const projectedSentences = this.#projection.sentences;
    const candidateSentenceIds = projectedSentences.map(
      (sentence) => sentence.sentenceId,
    );
    const selectionSentences = projectedSentences.map((sentence, index) => ({
      id: `S${index + 1}`,
      sentenceId: sentence.sentenceId,
      text: sentence.projectedText,
    }));
    const selectionEvidence = createEvidenceSelectionList(evidence);
    const [selectionResolution, selectionFailure] =
      selectionEvidence === undefined
        ? [undefined, undefined]
        : resolveEvidenceSelectionList({
            evidence: selectionEvidence,
            sentences: selectionSentences,
          });

    if (selectionResolution !== undefined) {
      return [selectionResolution.sentenceIds, undefined];
    }

    const exactMatchSentenceIds = Array.isArray(evidence)
      ? []
      : this.#resolveExactProjectionEvidence(evidence);

    if (exactMatchSentenceIds.length > 0) {
      return [exactMatchSentenceIds, undefined];
    }

    const candidateTexts = projectedSentences.map(
      (sentence) => sentence.projectedText,
    );
    const [resolution, failure] = Array.isArray(evidence)
      ? [undefined, undefined]
      : this.#evidenceResolver.resolve(
          evidence,
          candidateSentenceIds,
          candidateTexts,
        );

    if (resolution !== undefined) {
      return [resolution.sentenceIds, undefined];
    }

    const fallbackFailure =
      selectionFailure === undefined
        ? failure
        : toEvidenceResolutionFailure(selectionFailure, "evidence");

    if (fallbackFailure === undefined) {
      return [[], undefined];
    }

    const shouldUseChoice =
      fallbackFailure.code.startsWith("ambiguous") ||
      (fallbackFailure.code === "low_confidence" &&
        input.isLastGenerationAttempt &&
        fallbackFailure.candidates.length > 0);

    if (!shouldUseChoice) {
      return [[], fallbackFailure];
    }

    const choiceFieldName = toChoiceFieldName(fallbackFailure.fieldName);

    if (choiceFieldName === undefined) {
      return [[], fallbackFailure];
    }

    const [choiceCandidate, choiceFailure] =
      await this.#chooseAmbiguousCandidate({
        candidates: fallbackFailure.candidates,
        chunkData: input.data,
        chunkIndex: input.chunkIndex,
        chunkLabel: input.chunkLabel,
        fieldName: choiceFieldName,
      });

    if (choiceFailure !== undefined) {
      if (choiceFailure.code === "choice_parse_failed_full_fragment") {
        return [candidateSentenceIds, undefined];
      }

      return [[], choiceFailure];
    }

    if (choiceCandidate === undefined) {
      return [
        [],
        {
          candidates: fallbackFailure.candidates,
          code: "choice_failed",
          fieldName: fallbackFailure.fieldName,
          message: `Second-stage choice failed for ${fallbackFailure.fieldName}: no candidate returned.`,
        },
      ];
    }

    if (choiceFieldName === "evidence") {
      return [[choiceCandidate.sentenceId], undefined];
    }

    if (Array.isArray(evidence)) {
      return [[], fallbackFailure];
    }

    if (input.isLastGenerationAttempt) {
      const [resolved, resolveFailure] =
        this.#evidenceResolver.resolveWithOverrides({
          candidateSentenceIds,
          candidateTexts,
          evidence,
          overrides: {
            [choiceFieldName]: choiceCandidate,
          },
        });

      if (resolved !== undefined) {
        return [resolved.sentenceIds, undefined];
      }

      return [[], resolveFailure];
    }

    const repairedEvidence: Record<string, unknown> = {
      ...evidence,
      [choiceFieldName]: {
        mode: "full",
        text: choiceCandidate.text,
      },
    };
    const [resolved, resolveFailure] = this.#evidenceResolver.resolve(
      repairedEvidence,
      candidateSentenceIds,
      candidateTexts,
    );

    if (resolved !== undefined) {
      return [resolved.sentenceIds, undefined];
    }

    return [[], resolveFailure];
  }

  #resolveExactProjectionEvidence(
    evidence: Record<string, unknown>,
  ): SentenceId[] {
    const startValue = evidence.start_anchor ?? evidence.start;
    const [startAnchor, startFailure] = this.#evidenceResolver.parseAnchor(
      startValue,
      "start_anchor",
    );

    if (startFailure !== undefined || startAnchor?.text === undefined) {
      return [];
    }

    const startMatch = expectSingleSpan(
      this.#projection.findExactMatches(startAnchor.text),
    );

    if (startMatch === undefined) {
      return [];
    }

    const endValue = evidence.end_anchor ?? evidence.end;

    if (endValue === undefined) {
      return this.#projection.resolveSentenceIds(startMatch);
    }

    const [endAnchor, endFailure] = this.#evidenceResolver.parseAnchor(
      endValue,
      "end_anchor",
    );

    if (endFailure !== undefined || endAnchor?.text === undefined) {
      return [];
    }

    const endMatch = expectSingleSpan(
      this.#projection.findExactMatches(endAnchor.text),
    );

    if (endMatch === undefined || endMatch.offset < startMatch.offset) {
      return [];
    }

    return this.#projection.resolveSentenceIds({
      length: endMatch.offset + endMatch.length - startMatch.offset,
      offset: startMatch.offset,
    });
  }

  async #chooseAmbiguousCandidate(
    input: SelectAmbiguousCandidateInput,
  ): Promise<
    readonly [
      candidate: RankedSentenceCandidate | undefined,
      failure: EvidenceResolutionFailure | undefined,
    ]
  > {
    const messages = this.#buildChoiceMessages(input);
    const candidateIds = input.candidates.map(
      (candidate) => candidate.occurrenceId,
    );

    try {
      const choice = await requestGuaranteedJson({
        maxRetries: MAX_CHOICE_RETRIES,
        messages,
        parse: (data) => {
          const candidate = input.candidates.find(
            (item) => item.occurrenceId === data.choice,
          );

          if (candidate === undefined) {
            throw new ParsedJsonError([
              `Invalid choice "${data.choice}". Expected one of: ${candidateIds.join(", ")}`,
            ]);
          }

          return candidate;
        },
        responseIntentClassifierPrompt: this.#responseIntentClassifierPrompt,
        request: this.#requestChoice,
        schema: choiceResponseSchema,
      });

      return [choice, undefined];
    } catch (error) {
      if (isParsedJsonValidationFailure(error)) {
        return [
          undefined,
          {
            candidates: input.candidates,
            code: "choice_parse_failed_full_fragment",
            fieldName: input.fieldName,
            message:
              `Second-stage choice parse validation failed for ${input.fieldName}; ` +
              "falling back to the full fragment span.",
          },
        ];
      }

      return [
        undefined,
        {
          candidates: input.candidates,
          code: "choice_failed",
          fieldName: input.fieldName,
          message: `Second-stage choice failed for ${input.fieldName}: ${formatError(error)}`,
        },
      ];
    }
  }

  #buildChoiceMessages(input: SelectAmbiguousCandidateInput): LLMessage[] {
    return [
      {
        content: this.#choiceSystemPrompt,
        role: "system",
      },
      {
        content:
          `Previously generated chunk (do NOT rewrite it):\n` +
          `\`\`\`json\n${JSON.stringify(input.chunkData, null, 2)}\n\`\`\`\n\n` +
          `Resolve only this field: "${input.fieldName}" for chunk #${input.chunkIndex} [${input.chunkLabel}].\n` +
          "Choose exactly one candidate occurrence ID from the list below.\n\n" +
          input.candidates.map(formatChoiceCandidate).join("\n"),
        role: "user",
      },
    ];
  }

  #validateImportanceAnnotations(
    annotations: readonly {
      readonly chunk_id: number;
      readonly importance: ChunkImportance;
    }[],
    issues: string[],
  ): ChunkImportanceAnnotation[] | undefined {
    if (annotations.length === 0) {
      return [];
    }

    if (this.#validImportanceChunkIds === undefined) {
      return annotations.map((annotation) => ({
        chunkId: annotation.chunk_id,
        importance: expectChunkImportance(annotation.importance),
      }));
    }

    const result: ChunkImportanceAnnotation[] = [];

    for (const annotation of annotations) {
      if (!hasMembership(this.#validImportanceChunkIds, annotation.chunk_id)) {
        issues.push(
          `importance_annotations references unknown chunk_id ${annotation.chunk_id}`,
        );
        continue;
      }

      result.push({
        chunkId: annotation.chunk_id,
        importance: expectChunkImportance(annotation.importance),
      });
    }

    return result;
  }

  #filterAndValidateLinks(input: {
    issues: string[];
    links: readonly ChunkLink[];
    tempIds: readonly string[];
    visibleChunkIds: readonly number[];
  }): ChunkLink[] {
    const validTempIds = createMembershipRecord(input.tempIds);
    const validChunkIds = createMembershipRecord(input.visibleChunkIds);
    const retainedLinks: ChunkLink[] = [];

    for (const [index, link] of input.links.entries()) {
      const fromValid = this.#validateLinkReference({
        fieldName: "from",
        index: index + 1,
        issues: input.issues,
        reference: link.from,
        validChunkIds,
        validTempIds,
      });
      const toValid = this.#validateLinkReference({
        fieldName: "to",
        index: index + 1,
        issues: input.issues,
        reference: link.to,
        validChunkIds,
        validTempIds,
      });

      if (fromValid && toValid) {
        retainedLinks.push(link);
      }
    }

    return retainedLinks;
  }

  #validateLinkReference(input: {
    fieldName: "from" | "to";
    index: number;
    issues: string[];
    reference: number | string;
    validChunkIds: Readonly<Record<string, true>>;
    validTempIds: Readonly<Record<string, true>>;
  }): boolean {
    if (typeof input.reference === "string") {
      return hasMembership(input.validTempIds, input.reference);
    }

    if (!hasMembership(input.validChunkIds, input.reference)) {
      input.issues.push(
        `Link #${input.index}: "${input.fieldName}" chunk_id ${input.reference} does not exist in visible chunks`,
      );

      return false;
    }

    return true;
  }
}
