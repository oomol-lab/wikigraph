import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as WikiGraphIndex from "../../src/wikg/index.js";

const objectMetadataMockState = vi.hoisted(() => ({
  maps: new Map<string, Record<string, unknown>>(),
  readCalls: [] as string[],
  targets: [] as unknown[],
  textWrites: [] as string[],
  writeCalls: [] as string[],
}));

vi.mock("../../src/wikg/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WikiGraphIndex>();

  return {
    ...actual,
    SpineDigestFile: class {
      readonly #path: string;

      public constructor(path: string) {
        this.#path = path;
      }

      public async readDocument(
        operation: (document: MockDocument) => Promise<unknown>,
      ): Promise<unknown> {
        objectMetadataMockState.readCalls.push(this.#path);
        return await operation(createMockDocument());
      }

      public async write(
        operation: (document: MockDocument) => Promise<unknown>,
      ): Promise<unknown> {
        objectMetadataMockState.writeCalls.push(this.#path);
        return await operation(createMockDocument());
      }
    },
  };
});

vi.mock("../../src/cli/io.js", () => ({
  readTextStreamFromStdin: vi.fn(async function* () {}),
  writeTextToStdout: vi.fn((text: string) => {
    objectMetadataMockState.textWrites.push(text);
    return Promise.resolve();
  }),
}));

import { parseCLIArguments } from "../../src/cli/args.js";
import { runObjectMetadataCommand } from "../../src/cli/object-metadata.js";

interface MockDocument {
  readonly metadata: {
    readonly clear: (objectPath: string) => Promise<void>;
    readonly deleteKey: (objectPath: string, key: string) => Promise<void>;
    readonly getMap: (
      objectPath: string,
    ) => Promise<Readonly<Record<string, unknown>>>;
    readonly put: (
      target: unknown,
      key: string,
      value: unknown,
    ) => Promise<void>;
    readonly replaceMap: (
      target: unknown,
      map: Readonly<Record<string, unknown>>,
    ) => Promise<void>;
  };
}

describe("cli/object metadata", () => {
  beforeEach(() => {
    objectMetadataMockState.maps.clear();
    objectMetadataMockState.readCalls.length = 0;
    objectMetadataMockState.targets.length = 0;
    objectMetadataMockState.textWrites.length = 0;
    objectMetadataMockState.writeCalls.length = 0;
  });

  it("renders metadata as key-value text by default", async () => {
    objectMetadataMockState.maps.set("entity/Q42", {
      aliases: ["Douglas", 42, true],
      missing: null,
      rank: 7,
      title: "Douglas Adams",
    });

    await runObjectMetadataCommand({
      action: "get",
      archivePath: "/tmp/book.wikg",
      objectPath: "entity/Q42",
    });

    expect(objectMetadataMockState.readCalls).toStrictEqual(["/tmp/book.wikg"]);
    expect(objectMetadataMockState.textWrites).toStrictEqual([
      [
        "aliases: Douglas 42 true",
        "missing: null",
        "rank: 7",
        "title: Douglas Adams",
        "",
      ].join("\n"),
    ]);
  });

  it("renders metadata as JSON when requested", async () => {
    objectMetadataMockState.maps.set("", {
      authors: ["Ari Lantern", "Bea North"],
      title: "Fixture Book",
    });

    await runObjectMetadataCommand({
      action: "get",
      archivePath: "/tmp/book.wikg",
      json: true,
      objectPath: "",
    });

    expect(JSON.parse(objectMetadataMockState.textWrites[0]!)).toStrictEqual({
      authors: ["Ari Lantern", "Bea North"],
      title: "Fixture Book",
    });
  });

  it("prints the updated map with the selected output format", async () => {
    objectMetadataMockState.maps.set("entity/Q42", {
      note: "old",
    });

    await runObjectMetadataCommand({
      action: "put",
      archivePath: "/tmp/book.wikg",
      inputValue: "updated",
      key: "note",
      objectPath: "entity/Q42",
    });

    expect(objectMetadataMockState.writeCalls).toStrictEqual([
      "/tmp/book.wikg",
    ]);
    expect(objectMetadataMockState.targets).toStrictEqual([
      {
        entityQid: "Q42",
        kind: 4,
        objectPath: "entity/Q42",
      },
    ]);
    expect(objectMetadataMockState.textWrites).toStrictEqual([
      "note: updated\n",
    ]);

    await runObjectMetadataCommand({
      action: "put",
      archivePath: "/tmp/book.wikg",
      json: true,
      jsonInputValue: '["x",2]',
      key: "tags",
      objectPath: "entity/Q42",
    });

    expect(
      JSON.parse(objectMetadataMockState.textWrites.at(-1)!),
    ).toStrictEqual({
      note: "updated",
      tags: ["x", 2],
    });
  });

  it("parses json output for metadata delete and clear, and rejects jsonl", () => {
    expect(
      parseCLIArguments([
        "wikg://book.wikg/entity/Q42/meta",
        "delete",
        "note",
        "--json",
      ]),
    ).toMatchObject({
      args: {
        action: "delete",
        json: true,
        key: "note",
        objectPath: "entity/Q42",
      },
      help: false,
      kind: "object-metadata",
    });
    expect(
      parseCLIArguments([
        "wikg://book.wikg/entity/Q42/meta",
        "clear",
        "--json",
      ]),
    ).toMatchObject({
      args: {
        action: "clear",
        json: true,
        objectPath: "entity/Q42",
      },
      help: false,
      kind: "object-metadata",
    });
    expect(() =>
      parseCLIArguments(["wikg://book.wikg/entity/Q42/meta", "get", "--jsonl"]),
    ).toThrow("The `meta` command does not support --jsonl.");
  });
});

function createMockDocument(): MockDocument {
  return {
    metadata: {
      clear: (objectPath) => {
        objectMetadataMockState.maps.set(objectPath, {});
        return Promise.resolve();
      },
      deleteKey: (objectPath, key) => {
        const next = {
          ...(objectMetadataMockState.maps.get(objectPath) ?? {}),
        };
        delete next[key];
        objectMetadataMockState.maps.set(objectPath, next);
        return Promise.resolve();
      },
      getMap: (objectPath) =>
        Promise.resolve(objectMetadataMockState.maps.get(objectPath) ?? {}),
      put: (target, key, value) => {
        objectMetadataMockState.targets.push(target);
        objectMetadataMockState.maps.set(targetObjectPath(target), {
          ...(objectMetadataMockState.maps.get(targetObjectPath(target)) ?? {}),
          [key]: value,
        });
        return Promise.resolve();
      },
      replaceMap: (target, map) => {
        objectMetadataMockState.targets.push(target);
        objectMetadataMockState.maps.set(targetObjectPath(target), { ...map });
        return Promise.resolve();
      },
    },
  };
}

function targetObjectPath(target: unknown): string {
  if (
    target !== null &&
    typeof target === "object" &&
    "objectPath" in target &&
    typeof target.objectPath === "string"
  ) {
    return target.objectPath;
  }

  throw new Error("Missing mock metadata target objectPath.");
}
