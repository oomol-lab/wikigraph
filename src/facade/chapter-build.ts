import { mkdir, rm } from "fs/promises";
import { join } from "path";

import type { Document, ReadonlyDocument } from "../document/index.js";
import { DirectoryDocument } from "../document/index.js";
import type { ReaderTextStream } from "../reader/index.js";
import {
  SerialGeneration,
  type BuildSerialTopologyOptions,
} from "../serial.js";

import {
  getChapterDetails,
  type ChapterDetails,
  type GenerateChapterGraphOptions,
  type GenerateChapterSummaryOptions,
} from "./chapter.js";

export interface ChapterGraphBuildArtifact {
  readonly documentPath: string;
  readonly chapterId: number;
}

export interface BuildChapterGraphArtifactOptions extends GenerateChapterGraphOptions {
  readonly sourceText: readonly string[];
  readonly nextChunkId: number;
  readonly workspacePath: string;
}

export interface BuildChapterSummaryArtifactOptions extends GenerateChapterSummaryOptions {
  readonly sourceDocumentPath?: string;
  readonly workspacePath: string;
}

export async function readChapterBuildInput(
  document: ReadonlyDocument,
  chapterId: number,
): Promise<{
  readonly details: ChapterDetails;
  readonly nextChunkId: number;
  readonly sourceText: readonly string[];
}> {
  const details = await getChapterDetails(document, chapterId);

  return {
    details,
    nextChunkId: (await document.chunks.getMaxId()) + 1,
    sourceText: await collectReaderText(readChapterSource(document, chapterId)),
  };
}

export async function buildChapterGraphArtifact(
  chapterId: number,
  options: BuildChapterGraphArtifactOptions,
): Promise<ChapterGraphBuildArtifact> {
  const documentPath = join(options.workspacePath, "graph-document");

  await rm(documentPath, { force: true, recursive: true });
  await mkdir(options.workspacePath, { recursive: true });

  const document = await DirectoryDocument.open(documentPath);

  try {
    await document.openSession(async (openedDocument) => {
      await openedDocument.serials.createWithId(chapterId);
      await new SerialGeneration({
        document: openedDocument,
        llm: options.llm,
        ...(options.logDirPath === undefined
          ? {}
          : { logDirPath: options.logDirPath }),
        nextChunkId: options.nextChunkId,
      }).buildTopologyInto(
        chapterId,
        options.sourceText,
        createTopologyOptions(options),
        options.progressTracker,
      );
    });
  } finally {
    await document.release();
  }

  return {
    chapterId,
    documentPath,
  };
}

export async function commitChapterGraphArtifact(
  document: Document,
  artifact: ChapterGraphBuildArtifact,
): Promise<ChapterDetails> {
  const sourceDocument = await DirectoryDocument.open(artifact.documentPath);

  try {
    await document.openSession(async (openedDocument) => {
      await requireStage(openedDocument, artifact.chapterId, "sourced");
      await openedDocument.clearSerialSource(artifact.chapterId);
      await openedDocument.serials.ensure(artifact.chapterId);
      await copySerialFragments(
        sourceDocument,
        openedDocument,
        artifact.chapterId,
      );

      for (const chunk of await sourceDocument.chunks.listBySerial(
        artifact.chapterId,
      )) {
        await openedDocument.chunks.save(chunk);
      }

      for (const edge of await sourceDocument.knowledgeEdges.listBySerial(
        artifact.chapterId,
      )) {
        await openedDocument.knowledgeEdges.save(edge);
      }

      await openedDocument.fragmentGroups.saveMany(
        await sourceDocument.fragmentGroups.listBySerial(artifact.chapterId),
      );
      await copySnakes(sourceDocument, openedDocument, artifact.chapterId);
      await openedDocument.serials.setTopologyReady(artifact.chapterId);
    });

    return await getChapterDetails(document, artifact.chapterId);
  } finally {
    await sourceDocument.release();
  }
}

export async function buildChapterSummaryArtifact(
  document: ReadonlyDocument,
  chapterId: number,
  options: BuildChapterSummaryArtifactOptions,
): Promise<string> {
  const sourceDocumentPath = options.sourceDocumentPath;

  if (sourceDocumentPath !== undefined) {
    return await buildChapterSummaryArtifactFromSnapshot(chapterId, {
      ...options,
      sourceDocumentPath,
    });
  }

  return await buildChapterSummaryArtifactFromDocument(
    document,
    chapterId,
    options,
  );
}

export async function buildChapterSummaryArtifactFromSnapshot(
  chapterId: number,
  options: BuildChapterSummaryArtifactOptions & {
    readonly sourceDocumentPath: string;
  },
): Promise<string> {
  const document = await DirectoryDocument.open(options.sourceDocumentPath);

  try {
    return await buildChapterSummaryArtifactFromDocument(
      document,
      chapterId,
      options,
    );
  } finally {
    await document.release();
  }
}

async function buildChapterSummaryArtifactFromDocument(
  document: ReadonlyDocument,
  chapterId: number,
  options: BuildChapterSummaryArtifactOptions,
): Promise<string> {
  const details = await getChapterDetails(document, chapterId);

  if (details.stage !== "graphed") {
    throw new Error(
      `Chapter ${chapterId} is ${details.stage}. Generate a summary only for graphed chapters.`,
    );
  }

  const summary = await document.readSummary(chapterId);

  if (summary !== undefined) {
    return summary;
  }

  return await buildSummaryInTemporaryDocument(document, chapterId, options);
}

export async function snapshotChapterSummaryInput(
  document: ReadonlyDocument,
  chapterId: number,
  workspacePath: string,
): Promise<{ readonly documentPath: string }> {
  const documentPath = join(workspacePath, "summary-input-document");

  await rm(documentPath, { force: true, recursive: true });
  await mkdir(workspacePath, { recursive: true });

  const targetDocument = await DirectoryDocument.open(documentPath);

  try {
    await targetDocument.openSession(async (openedDocument) => {
      await requireStage(document, chapterId, "graphed");
      await openedDocument.serials.createWithId(chapterId);
      await copySerialFragments(document, openedDocument, chapterId);

      for (const chunk of await document.chunks.listBySerial(chapterId)) {
        await openedDocument.chunks.save(chunk);
      }

      for (const edge of await document.knowledgeEdges.listBySerial(
        chapterId,
      )) {
        await openedDocument.knowledgeEdges.save(edge);
      }

      await openedDocument.fragmentGroups.saveMany(
        await document.fragmentGroups.listBySerial(chapterId),
      );
      await copySnakes(document, openedDocument, chapterId);
      await openedDocument.serials.setTopologyReady(chapterId);
    });
  } finally {
    await targetDocument.release();
  }

  return { documentPath };
}

export async function commitChapterSummaryArtifact(
  document: Document,
  chapterId: number,
  summary: string,
): Promise<ChapterDetails> {
  await document.openSession(async (openedDocument) => {
    await requireStage(openedDocument, chapterId, "graphed");
    await openedDocument.writeSummary(chapterId, summary);
  });

  return await getChapterDetails(document, chapterId);
}

async function buildSummaryInTemporaryDocument(
  sourceDocument: ReadonlyDocument,
  chapterId: number,
  options: BuildChapterSummaryArtifactOptions,
): Promise<string> {
  const documentPath = join(options.workspacePath, "summary-document");

  await rm(documentPath, { force: true, recursive: true });
  await mkdir(options.workspacePath, { recursive: true });

  const document = await DirectoryDocument.open(documentPath);

  try {
    await document.openSession(async (openedDocument) => {
      await openedDocument.serials.createWithId(chapterId);
      await copySerialFragments(sourceDocument, openedDocument, chapterId);

      for (const chunk of await sourceDocument.chunks.listBySerial(chapterId)) {
        await openedDocument.chunks.save(chunk);
      }

      for (const edge of await sourceDocument.knowledgeEdges.listBySerial(
        chapterId,
      )) {
        await openedDocument.knowledgeEdges.save(edge);
      }

      await openedDocument.fragmentGroups.saveMany(
        await sourceDocument.fragmentGroups.listBySerial(chapterId),
      );
      await copySnakes(sourceDocument, openedDocument, chapterId);
      await openedDocument.serials.setTopologyReady(chapterId);
    });

    await new SerialGeneration({
      document,
      llm: options.llm,
      ...(options.logDirPath === undefined
        ? {}
        : { logDirPath: options.logDirPath }),
    }).buildSummary(chapterId, {
      ...(options.userLanguage === undefined
        ? {}
        : { userLanguage: options.userLanguage }),
    });

    return (await document.readSummary(chapterId)) ?? "";
  } finally {
    await document.release();
    await rm(documentPath, { force: true, recursive: true });
  }
}

async function copySerialFragments(
  sourceDocument: ReadonlyDocument,
  targetDocument: Document,
  serialId: number,
): Promise<void> {
  const sourceFragments = sourceDocument.getSerialFragments(serialId);
  const targetFragments = targetDocument.getSerialFragments(serialId);

  for (const fragmentId of await sourceFragments.listFragmentIds()) {
    const fragment = await sourceFragments.getFragment(fragmentId);
    const draft = await targetFragments.createDraft();

    for (const sentence of fragment.sentences) {
      draft.addSentence(sentence.text, sentence.wordsCount);
    }
    draft.setSummary(fragment.summary);
    await draft.commit();
  }
}

async function copySnakes(
  sourceDocument: ReadonlyDocument,
  targetDocument: Document,
  serialId: number,
): Promise<void> {
  const sourceSnakes = await sourceDocument.snakes.listBySerial(serialId);
  const snakeIdMap = new Map<number, number>();

  for (const sourceSnake of sourceSnakes) {
    const targetSnakeId = await targetDocument.snakes.create({
      firstLabel: sourceSnake.firstLabel,
      groupId: sourceSnake.groupId,
      lastLabel: sourceSnake.lastLabel,
      localSnakeId: sourceSnake.localSnakeId,
      serialId,
      size: sourceSnake.size,
      weight: sourceSnake.weight,
      wordsCount: sourceSnake.wordsCount,
    });

    snakeIdMap.set(sourceSnake.id, targetSnakeId);

    for (const snakeChunk of await sourceDocument.snakeChunks.listBySnake(
      sourceSnake.id,
    )) {
      await targetDocument.snakeChunks.save({
        chunkId: snakeChunk.chunkId,
        position: snakeChunk.position,
        snakeId: targetSnakeId,
      });
    }
  }

  for (const edge of await sourceDocument.snakeEdges.listBySerial(serialId)) {
    const fromSnakeId = snakeIdMap.get(edge.fromSnakeId);
    const toSnakeId = snakeIdMap.get(edge.toSnakeId);

    if (fromSnakeId === undefined || toSnakeId === undefined) {
      continue;
    }

    await targetDocument.snakeEdges.save({
      fromSnakeId,
      toSnakeId,
      weight: edge.weight,
    });
  }
}

async function requireStage(
  document: ReadonlyDocument,
  chapterId: number,
  stage: ChapterDetails["stage"],
): Promise<void> {
  const details = await getChapterDetails(document, chapterId);

  if (details.stage !== stage) {
    throw new Error(
      `Chapter ${chapterId} is ${details.stage}. Expected ${stage} before committing build output.`,
    );
  }
}

function createTopologyOptions(
  options: Pick<
    BuildSerialTopologyOptions,
    "extractionPrompt" | "userLanguage"
  >,
): BuildSerialTopologyOptions {
  return {
    extractionPrompt: options.extractionPrompt,
    ...(options.userLanguage === undefined
      ? {}
      : { userLanguage: options.userLanguage }),
  };
}

async function* readChapterSource(
  document: ReadonlyDocument,
  chapterId: number,
): ReaderTextStream {
  const fragments = document.getSerialFragments(chapterId);

  for (const fragmentId of await fragments.listFragmentIds()) {
    const fragment = await fragments.getFragment(fragmentId);

    for (const sentence of fragment.sentences) {
      yield sentence.text;
    }
  }
}

async function collectReaderText(
  stream: ReaderTextStream,
): Promise<readonly string[]> {
  const text: string[] = [];

  for await (const chunk of stream) {
    text.push(chunk);
  }

  return text;
}
