import { describe, expect, it } from "vitest";

import { parseCLIArguments } from "../../packages/cli/src/args/index.js";

describe("cli/library args", () => {
  it("parses library create, scope, remove, and metadata commands", () => {
    expect(
      parseCLIArguments([
        "wikg://lib",
        "create",
        "--path",
        "/tmp/research",
        "--json",
      ]),
    ).toStrictEqual({
      args: {
        action: "create",
        json: true,
        path: "/tmp/research",
        target: { isDefault: true, kind: "scope" },
      },
      help: false,
      kind: "library",
    });

    expect(parseCLIArguments(["wikg://lib/abc123abc123.lib"])).toStrictEqual({
      args: {
        action: "list",
        json: undefined,
        target: { isDefault: false, kind: "scope", publicId: "abc123abc123" },
      },
      help: false,
      kind: "library",
    });

    expect(
      parseCLIArguments(["wikg://lib/abc123abc123.lib", "remove", "--json"]),
    ).toMatchObject({
      args: {
        action: "remove",
        json: true,
        target: { publicId: "abc123abc123" },
      },
      kind: "library",
    });

    expect(
      parseCLIArguments(["wikg://lib/meta", "put", "title", "Default"]),
    ).toMatchObject({
      args: {
        action: "put",
        inputValue: "Default",
        key: "title",
        target: { isDefault: true, kind: "metadata" },
      },
      help: false,
      kind: "library",
    });
  });

  it("rejects unsupported specified library URI and inspect", () => {
    expect(() => parseCLIArguments(["wikg://lib/abc123abc123"])).toThrow(
      ".lib suffix",
    );
    expect(() =>
      parseCLIArguments(["wikg://lib/abc123abc123.lib", "inspect"]),
    ).toThrow("does not support `inspect`");
  });

  it("does not steal archive URIs below a lib path segment", () => {
    expect(parseCLIArguments(["wikg://lib/book.wikg"])).toMatchObject({
      args: {
        action: "list",
        archivePath: expect.stringContaining("lib/book.wikg") as string,
      },
      kind: "archive",
    });
  });
});
