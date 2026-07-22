import { describe, expect, it } from "vitest";

import {
  createCursorPayload,
  parseContinuationCursorRecord,
} from "./payload.js";
import type { ContinuationCursor } from "./types.js";

const archiveCursor: ContinuationCursor = {
  archiveKey: "archive-key",
  archivePath: "/tmp/book.wikg",
  chapters: [1],
  cursor: "raw-cursor",
  format: "json",
  ids: null,
  indexScope: {
    archiveKey: "archive-key",
    archivePath: "/tmp/book.wikg",
    kind: "archive-index",
  },
  kind: "collection",
  order: "doc-asc",
  types: ["entity"],
};

describe("continuation cursor payload", () => {
  it("round-trips archive index scope", () => {
    const payloadJSON = JSON.stringify(createCursorPayload(archiveCursor));

    expect(
      parseContinuationCursorRecord({
        archiveKey: "archive-key",
        archivePath: "/tmp/book.wikg",
        format: "json",
        kind: "collection",
        payloadJSON,
      }),
    ).toStrictEqual(archiveCursor);
  });

  it("falls back to record archive scope for legacy payloads", () => {
    const payload = createCursorPayload(archiveCursor) as Record<
      string,
      unknown
    >;
    delete payload.indexScope;

    expect(
      parseContinuationCursorRecord({
        archiveKey: "archive-key",
        archivePath: "/tmp/book.wikg",
        format: "json",
        kind: "collection",
        payloadJSON: JSON.stringify(payload),
      }),
    ).toMatchObject({
      indexScope: {
        archiveKey: "archive-key",
        archivePath: "/tmp/book.wikg",
        kind: "archive-index",
      },
    });
  });

  it("parses library index scope", () => {
    const payloadJSON = JSON.stringify({
      cursor: "raw-cursor",
      indexScope: { kind: "library-index", libraryId: 42 },
      order: "doc-asc",
      targetUri: "wikg://entity/Q1",
    });

    expect(
      parseContinuationCursorRecord({
        archiveKey: "archive-key",
        archivePath: "/tmp/book.wikg",
        format: "json",
        kind: "evidence",
        payloadJSON,
      }),
    ).toMatchObject({
      indexScope: { kind: "library-index", libraryId: 42 },
    });
  });

  it("rejects malformed and mismatched archive index scopes", () => {
    expect(() =>
      parseContinuationCursorRecord({
        archiveKey: "archive-key",
        archivePath: "/tmp/book.wikg",
        format: "json",
        kind: "evidence",
        payloadJSON: JSON.stringify({
          cursor: "raw-cursor",
          indexScope: {
            archiveKey: "other-key",
            archivePath: "/tmp/book.wikg",
            kind: "archive-index",
          },
          order: "doc-asc",
          targetUri: "wikg://entity/Q1",
        }),
      }),
    ).toThrow("Invalid continuation cursor payload");

    expect(() =>
      parseContinuationCursorRecord({
        archiveKey: "archive-key",
        archivePath: "/tmp/book.wikg",
        format: "json",
        kind: "evidence",
        payloadJSON: JSON.stringify({
          cursor: "raw-cursor",
          indexScope: { kind: "library-index", libraryId: "42" },
          order: "doc-asc",
          targetUri: "wikg://entity/Q1",
        }),
      }),
    ).toThrow("Invalid continuation cursor payload");
  });
});
