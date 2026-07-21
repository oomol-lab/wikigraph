import type {
  ChunkRecord,
  FragmentRecord,
  MentionLinkRecord,
  MentionRecord,
  ReadonlyChunkStore,
  ReadonlyDocument,
  ReadonlyFragmentGroupStore,
  ReadonlyGraphBuildParameterStore,
  ReadonlyMentionLinkStore,
  ReadonlyMentionStore,
  ReadonlyObjectMetadataStore,
  ReadonlyReadingEdgeStore,
  ReadonlySerialFragments,
  ReadonlySerialStore,
  ReadonlySnakeChunkStore,
  ReadonlySnakeEdgeStore,
  ReadonlySnakeStore,
  ReadingEdgeRecord,
  SentenceGroupRecord,
  SentenceId,
  SerialRecord,
  SnakeChunkRecord,
  SnakeEdgeRecord,
  SnakeRecord,
} from "../../document/index.js";
import type { SummaryInputSnapshotData } from "../chapter-build.js";

export class SummaryInputSnapshotDocument implements ReadonlyDocument {
  public readonly chunks: ReadonlyChunkStore;
  public readonly fragmentGroups: ReadonlyFragmentGroupStore;
  public readonly graphBuildParameters: ReadonlyGraphBuildParameterStore;
  public readonly readingEdges: ReadonlyReadingEdgeStore;
  public readonly mentionLinks: ReadonlyMentionLinkStore;
  public readonly mentions: ReadonlyMentionStore;
  public readonly metadata: ReadonlyObjectMetadataStore;
  public readonly serials: ReadonlySerialStore;
  public readonly snakeChunks: ReadonlySnakeChunkStore;
  public readonly snakeEdges: ReadonlySnakeEdgeStore;
  public readonly snakes: ReadonlySnakeStore;
  readonly #fragments: ReadonlySerialFragments;

  public constructor(snapshot: SummaryInputSnapshotData) {
    const serialId = snapshot.serial.id;

    this.chunks = new SnapshotChunkStore(snapshot.chunks, snapshot.fragments);
    this.fragmentGroups = new SnapshotFragmentGroupStore(
      snapshot.fragmentGroups,
    );
    this.graphBuildParameters = new EmptySnapshotGraphBuildParameterStore();
    this.readingEdges = new SnapshotReadingEdgeStore(
      snapshot.readingEdges,
      snapshot.chunks,
    );
    this.mentionLinks = new EmptySnapshotMentionLinkStore();
    this.mentions = new EmptySnapshotMentionStore();
    this.metadata = new EmptySnapshotObjectMetadataStore();
    this.serials = new SnapshotSerialStore(snapshot.serial);
    this.snakeChunks = new SnapshotSnakeChunkStore(snapshot.snakeChunks);
    this.snakeEdges = new SnapshotSnakeEdgeStore(
      snapshot.snakeEdges,
      snapshot.snakes,
    );
    this.snakes = new SnapshotSnakeStore(snapshot.snakes);
    this.#fragments = new SnapshotSerialFragments(serialId, snapshot.fragments);
  }

  public async getSentence(sentenceId: SentenceId): Promise<string> {
    const [serialId, sentenceIndex] = sentenceId;
    const sentence = (await this.getSerialFragments(serialId).listSentences!())[
      sentenceIndex
    ];

    if (sentence === undefined) {
      throw new RangeError(`Sentence ${sentenceIndex} does not exist`);
    }

    return sentence.text;
  }

  public getSerialFragments(serialId: number): ReadonlySerialFragments {
    if (serialId !== this.#fragments.serialId) {
      return new SnapshotSerialFragments(serialId, []);
    }
    return this.#fragments;
  }

  public getSummaryFragments(serialId: number): ReadonlySerialFragments {
    return new SnapshotSerialFragments(serialId, []);
  }

  public async openSession<T>(
    operation: (document: ReadonlyDocument) => Promise<T> | T,
  ): Promise<T> {
    return await operation(this);
  }

  public readDatabase<T>(): Promise<T> {
    return Promise.reject(
      new Error("Summary input snapshots do not expose a SQLite database."),
    );
  }

  public readSearchIndexDatabase<T>(): Promise<T> {
    return Promise.reject(
      new Error(
        "Summary input snapshots do not expose a search index database.",
      ),
    );
  }

  public readBookMeta(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public readCover(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public readSummary(_serialId: number): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public readToc(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public release(): Promise<void> {
    return Promise.resolve();
  }
}

class EmptySnapshotMentionStore implements ReadonlyMentionStore {
  public getById(_mentionId: string): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public listAll(): Promise<MentionRecord[]> {
    return Promise.resolve([]);
  }

  public listByQid(_qid: string): Promise<MentionRecord[]> {
    return Promise.resolve([]);
  }

  public listBySurfaceTerms(
    _terms: readonly string[],
  ): Promise<MentionRecord[]> {
    return Promise.resolve([]);
  }

  public listBySurfaces(
    _surfaces: readonly string[],
  ): Promise<MentionRecord[]> {
    return Promise.resolve([]);
  }

  public listByChapter(_chapterId: number): Promise<MentionRecord[]> {
    return Promise.resolve([]);
  }
}

class EmptySnapshotMentionLinkStore implements ReadonlyMentionLinkStore {
  public getById(_linkId: string): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public listByTriple(_input: {
    readonly objectQid: string;
    readonly predicate: string;
    readonly subjectQid: string;
  }): Promise<MentionLinkRecord[]> {
    return Promise.resolve([]);
  }

  public listByChapter(_chapterId: number): Promise<MentionLinkRecord[]> {
    return Promise.resolve([]);
  }
}

class EmptySnapshotObjectMetadataStore implements ReadonlyObjectMetadataStore {
  public getMap(
    _objectPath: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return Promise.resolve({});
  }
}

class EmptySnapshotGraphBuildParameterStore implements ReadonlyGraphBuildParameterStore {
  public getByHash(_hash: string): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

class SnapshotSerialStore implements ReadonlySerialStore {
  readonly #serial: SerialRecord;

  public constructor(serial: SerialRecord) {
    this.#serial = serial;
  }

  public getById(serialId: number): Promise<SerialRecord | undefined> {
    return Promise.resolve(
      serialId === this.#serial.id ? this.#serial : undefined,
    );
  }

  public getRevision(serialId: number): Promise<number> {
    return Promise.resolve(
      serialId === this.#serial.id ? this.#serial.revision : 0,
    );
  }

  public getRevisions(
    serialIds: readonly number[],
  ): Promise<ReadonlyMap<number, number>> {
    return Promise.resolve(
      new Map(
        serialIds
          .filter((serialId) => serialId === this.#serial.id)
          .map((serialId) => [serialId, this.#serial.revision] as const),
      ),
    );
  }

  public getChaptersRevision(): Promise<number> {
    return Promise.resolve(this.#serial.revision);
  }

  public getMaxId(): Promise<number> {
    return Promise.resolve(this.#serial.id);
  }

  public listIds(): Promise<number[]> {
    return Promise.resolve([this.#serial.id]);
  }

  public listDocumentOrders(): Promise<ReadonlyMap<number, number>> {
    return Promise.resolve(
      new Map([[this.#serial.id, this.#serial.documentOrder]]),
    );
  }
}

class SnapshotSerialFragments implements ReadonlySerialFragments {
  public readonly path = "";
  public readonly serialId: number;
  readonly #fragmentsById: Map<number, FragmentRecord>;

  public constructor(serialId: number, fragments: readonly FragmentRecord[]) {
    this.serialId = serialId;
    this.#fragmentsById = new Map(
      fragments
        .filter((fragment) => fragment.serialId === serialId)
        .map((fragment) => [fragment.fragmentId, fragment]),
    );
  }

  public getFragment(fragmentId: number): Promise<FragmentRecord> {
    const fragment = this.#fragmentsById.get(fragmentId);

    if (fragment === undefined) {
      throw new Error(`Fragment ${fragmentId} does not exist`);
    }

    return Promise.resolve(fragment);
  }

  public listFragmentIds(): Promise<readonly number[]> {
    return Promise.resolve([...this.#fragmentsById.keys()].sort(compareNumber));
  }

  public async getSentence(sentenceIndex: number) {
    const sentence = (await this.listSentences())[sentenceIndex];

    if (sentence === undefined) {
      throw new RangeError(`Sentence ${sentenceIndex} does not exist`);
    }

    return sentence;
  }

  public async listSentencesInRange(
    startSentenceIndex: number,
    endSentenceIndex: number,
  ) {
    return (await this.listSentences()).slice(
      startSentenceIndex,
      endSentenceIndex + 1,
    );
  }

  public async listSentences() {
    const fragments = await Promise.all(
      (await this.listFragmentIds()).map(
        async (fragmentId) => await this.getFragment(fragmentId),
      ),
    );

    return fragments.flatMap((fragment) => fragment.sentences);
  }

  public async readText(): Promise<string | undefined> {
    const sentences = await this.listSentences();

    if (sentences.length === 0) {
      return undefined;
    }

    return sentences.map((sentence) => sentence.text).join("");
  }
}

class SnapshotChunkStore implements ReadonlyChunkStore {
  readonly #chunks: readonly ChunkRecord[];
  readonly #chunksById: Map<number, ChunkRecord>;
  readonly #fragmentStartIndexesBySerialId: ReadonlyMap<
    number,
    readonly number[]
  >;

  public constructor(
    chunks: readonly ChunkRecord[],
    fragments: readonly FragmentRecord[],
  ) {
    this.#chunks = [...chunks].sort(compareChunkById);
    this.#chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    this.#fragmentStartIndexesBySerialId =
      createFragmentStartIndexesBySerialId(fragments);
  }

  public getById(chunkId: number): Promise<ChunkRecord | undefined> {
    return Promise.resolve(this.#chunksById.get(chunkId));
  }

  public countAll(): Promise<number> {
    return Promise.resolve(this.#chunks.length);
  }

  public listAll(): Promise<ChunkRecord[]> {
    return Promise.resolve([...this.#chunks]);
  }

  public listBySentenceStartIndexes(
    serialId: number,
    sentenceStartIndexes: readonly number[],
  ): Promise<ChunkRecord[]> {
    const segmentRanges = createSegmentRanges(
      this.#fragmentStartIndexesBySerialId.get(serialId) ?? [],
      sentenceStartIndexes,
    );

    return Promise.resolve(
      this.#chunks.filter(
        (chunk) =>
          chunk.sentenceId[0] === serialId &&
          segmentRanges.some(
            (range) =>
              chunk.sentenceId[1] >= range.startSentenceIndex &&
              chunk.sentenceId[1] <= range.endSentenceIndex,
          ),
      ),
    );
  }

  public listBySentenceRange(
    serialId: number,
    startSentenceIndex: number,
    endSentenceIndex: number,
  ): Promise<ChunkRecord[]> {
    return Promise.resolve(
      this.#chunks.filter(
        (chunk) =>
          chunk.sentenceId[0] === serialId &&
          chunk.sentenceId[1] >= startSentenceIndex &&
          chunk.sentenceId[1] <= endSentenceIndex,
      ),
    );
  }

  public listBySerial(serialId: number): Promise<ChunkRecord[]> {
    return Promise.resolve(
      this.#chunks.filter((chunk) => chunk.sentenceId[0] === serialId),
    );
  }

  public getMaxId(): Promise<number> {
    return Promise.resolve(
      this.#chunks.reduce((maxId, chunk) => Math.max(maxId, chunk.id), 0),
    );
  }

  public listFragmentPairs(): Promise<
    ReadonlyArray<readonly [number, number]>
  > {
    const pairs = new Set<string>();

    for (const chunk of this.#chunks) {
      pairs.add(`${chunk.sentenceId[0]}:${chunk.sentenceId[1]}`);
    }

    return Promise.resolve(
      [...pairs]
        .map((pair) => pair.split(":").map(Number) as [number, number])
        .sort(comparePair)
        .map(([serialId, fragmentId]) => [serialId, fragmentId] as const),
    );
  }
}

class SnapshotReadingEdgeStore implements ReadonlyReadingEdgeStore {
  readonly #edges: readonly ReadingEdgeRecord[];
  readonly #serialIdByChunkId: Map<number, number>;

  public constructor(
    edges: readonly ReadingEdgeRecord[],
    chunks: readonly ChunkRecord[],
  ) {
    this.#edges = [...edges].sort(compareReadingEdge);
    this.#serialIdByChunkId = new Map(
      chunks.map((chunk) => [chunk.id, chunk.sentenceId[0]]),
    );
  }

  public listAll(): Promise<ReadingEdgeRecord[]> {
    return Promise.resolve([...this.#edges]);
  }

  public countAll(): Promise<number> {
    return Promise.resolve(this.#edges.length);
  }

  public listBySerial(serialId: number): Promise<ReadingEdgeRecord[]> {
    return Promise.resolve(
      this.#edges.filter(
        (edge) =>
          this.#serialIdByChunkId.get(edge.fromId) === serialId &&
          this.#serialIdByChunkId.get(edge.toId) === serialId,
      ),
    );
  }

  public listIncoming(chunkId: number): Promise<ReadingEdgeRecord[]> {
    return Promise.resolve(this.#edges.filter((edge) => edge.toId === chunkId));
  }

  public listOutgoing(chunkId: number): Promise<ReadingEdgeRecord[]> {
    return Promise.resolve(
      this.#edges.filter((edge) => edge.fromId === chunkId),
    );
  }
}

class SnapshotSnakeStore implements ReadonlySnakeStore {
  readonly #snakes: readonly SnakeRecord[];
  readonly #snakesById: Map<number, SnakeRecord>;

  public constructor(snakes: readonly SnakeRecord[]) {
    this.#snakes = [...snakes].sort(compareSnake);
    this.#snakesById = new Map(snakes.map((snake) => [snake.id, snake]));
  }

  public getById(snakeId: number): Promise<SnakeRecord | undefined> {
    return Promise.resolve(this.#snakesById.get(snakeId));
  }

  public listIdsByGroup(serialId: number, groupId: number): Promise<number[]> {
    return Promise.resolve(
      this.#snakes
        .filter(
          (snake) => snake.serialId === serialId && snake.groupId === groupId,
        )
        .map((snake) => snake.id)
        .sort(compareNumber),
    );
  }

  public listBySerial(serialId: number): Promise<SnakeRecord[]> {
    return Promise.resolve(
      this.#snakes.filter((snake) => snake.serialId === serialId),
    );
  }
}

class SnapshotSnakeChunkStore implements ReadonlySnakeChunkStore {
  readonly #snakeChunks: readonly SnakeChunkRecord[];

  public constructor(snakeChunks: readonly SnakeChunkRecord[]) {
    this.#snakeChunks = [...snakeChunks].sort(compareSnakeChunk);
  }

  public listChunkIds(snakeId: number): Promise<number[]> {
    return Promise.resolve(
      this.#snakeChunks
        .filter((snakeChunk) => snakeChunk.snakeId === snakeId)
        .map((snakeChunk) => snakeChunk.chunkId),
    );
  }

  public listBySnake(snakeId: number): Promise<SnakeChunkRecord[]> {
    return Promise.resolve(
      this.#snakeChunks.filter((snakeChunk) => snakeChunk.snakeId === snakeId),
    );
  }
}

class SnapshotSnakeEdgeStore implements ReadonlySnakeEdgeStore {
  readonly #edges: readonly SnakeEdgeRecord[];
  readonly #serialIdBySnakeId: Map<number, number>;

  public constructor(
    edges: readonly SnakeEdgeRecord[],
    snakes: readonly SnakeRecord[],
  ) {
    this.#edges = [...edges].sort(compareSnakeEdge);
    this.#serialIdBySnakeId = new Map(
      snakes.map((snake) => [snake.id, snake.serialId]),
    );
  }

  public listIncoming(snakeId: number): Promise<SnakeEdgeRecord[]> {
    return Promise.resolve(
      this.#edges.filter((edge) => edge.toSnakeId === snakeId),
    );
  }

  public listOutgoing(snakeId: number): Promise<SnakeEdgeRecord[]> {
    return Promise.resolve(
      this.#edges.filter((edge) => edge.fromSnakeId === snakeId),
    );
  }

  public listWithin(snakeIds: readonly number[]): Promise<SnakeEdgeRecord[]> {
    const snakeIdSet = new Set(snakeIds);

    return Promise.resolve(
      this.#edges.filter(
        (edge) =>
          snakeIdSet.has(edge.fromSnakeId) && snakeIdSet.has(edge.toSnakeId),
      ),
    );
  }

  public listBySerial(serialId: number): Promise<SnakeEdgeRecord[]> {
    return Promise.resolve(
      this.#edges.filter(
        (edge) =>
          this.#serialIdBySnakeId.get(edge.fromSnakeId) === serialId &&
          this.#serialIdBySnakeId.get(edge.toSnakeId) === serialId,
      ),
    );
  }
}

class SnapshotFragmentGroupStore implements ReadonlyFragmentGroupStore {
  readonly #groups: readonly SentenceGroupRecord[];

  public constructor(groups: readonly SentenceGroupRecord[]) {
    this.#groups = [...groups].sort(compareFragmentGroup);
  }

  public listBySerial(serialId: number): Promise<SentenceGroupRecord[]> {
    return Promise.resolve(
      this.#groups.filter((group) => group.serialId === serialId),
    );
  }

  public listSerialIds(): Promise<number[]> {
    return Promise.resolve(
      [...new Set(this.#groups.map((group) => group.serialId))].sort(
        compareNumber,
      ),
    );
  }

  public listGroupIdsForSerial(serialId: number): Promise<number[]> {
    return Promise.resolve(
      [
        ...new Set(
          this.#groups
            .filter((group) => group.serialId === serialId)
            .map((group) => group.groupId),
        ),
      ].sort(compareNumber),
    );
  }
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function createFragmentStartIndexesBySerialId(
  fragments: readonly FragmentRecord[],
): ReadonlyMap<number, readonly number[]> {
  const indexesBySerialId = new Map<number, number[]>();

  for (const fragment of fragments) {
    const indexes = indexesBySerialId.get(fragment.serialId) ?? [];

    indexes.push(fragment.fragmentId);
    indexesBySerialId.set(fragment.serialId, indexes);
  }

  return new Map(
    [...indexesBySerialId.entries()].map(
      ([serialId, indexes]) => [serialId, indexes.sort(compareNumber)] as const,
    ),
  );
}

function createSegmentRanges(
  allStartIndexes: readonly number[],
  selectedStartIndexes: readonly number[],
): Array<{
  readonly endSentenceIndex: number;
  readonly startSentenceIndex: number;
}> {
  const selected = new Set(selectedStartIndexes);

  return allStartIndexes.flatMap((startSentenceIndex, index) => {
    if (!selected.has(startSentenceIndex)) {
      return [];
    }

    const nextStartSentenceIndex = allStartIndexes[index + 1];

    return [
      {
        endSentenceIndex:
          nextStartSentenceIndex === undefined
            ? Infinity
            : nextStartSentenceIndex - 1,
        startSentenceIndex,
      },
    ];
  });
}

function compareChunkById(left: ChunkRecord, right: ChunkRecord): number {
  return left.id - right.id;
}

function compareFragmentGroup(
  left: SentenceGroupRecord,
  right: SentenceGroupRecord,
): number {
  return (
    left.serialId - right.serialId ||
    left.groupId - right.groupId ||
    left.startSentenceIndex - right.startSentenceIndex ||
    left.endSentenceIndex - right.endSentenceIndex
  );
}

function compareReadingEdge(
  left: ReadingEdgeRecord,
  right: ReadingEdgeRecord,
): number {
  return left.fromId - right.fromId || left.toId - right.toId;
}

function comparePair(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

function compareSnake(left: SnakeRecord, right: SnakeRecord): number {
  return left.groupId - right.groupId || left.id - right.id;
}

function compareSnakeChunk(
  left: SnakeChunkRecord,
  right: SnakeChunkRecord,
): number {
  return left.snakeId - right.snakeId || left.position - right.position;
}

function compareSnakeEdge(
  left: SnakeEdgeRecord,
  right: SnakeEdgeRecord,
): number {
  return (
    left.fromSnakeId - right.fromSnakeId || left.toSnakeId - right.toSnakeId
  );
}
