import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWikiGraphLibraryArchive,
  ensureDefaultWikiGraphLibrary,
  moveWikiGraphLibraryArchive,
  parseLocatedWikiGraphUri,
  parseWikiGraphLibraryUri,
  removeWikiGraphLibraryArchive,
  scanWikiGraphLibrary,
} from "../index.js";

let previousStateDir: string | undefined;
let tempDir: string;

beforeEach(async () => {
  previousStateDir = process.env.WIKIGRAPH_STATE_DIR;
  tempDir = await mkdtemp(join(tmpdir(), "wikigraph-library-test-"));
  process.env.WIKIGRAPH_STATE_DIR = join(tempDir, "state");
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.WIKIGRAPH_STATE_DIR;
  } else {
    process.env.WIKIGRAPH_STATE_DIR = previousStateDir;
  }
  await rm(tempDir, { force: true, recursive: true });
});

describe("library archive membership", () => {
  it("scans nested .wikg files and reports missing registered files", async () => {
    const library = await ensureDefaultWikiGraphLibrary();
    await mkdir(join(library.folderPath, "nested"), { recursive: true });
    await writeFile(join(library.folderPath, "a.wikg"), "a");
    await writeFile(join(library.folderPath, "nested", "b.wikg"), "b");

    const target = parseWikiGraphLibraryUri("wikg://lib");
    expect(target).toBeDefined();
    const first = await scanWikiGraphLibrary(target!);
    expect(first.archives.map((archive) => archive.relativePath)).toStrictEqual(
      ["a.wikg", "nested/b.wikg"],
    );

    await rm(join(library.folderPath, "a.wikg"));
    const second = await scanWikiGraphLibrary(target!);
    expect(
      second.archives.map((archive) => ({
        exists: archive.exists,
        relativePath: archive.relativePath,
      })),
    ).toContainEqual({ exists: false, relativePath: "a.wikg" });
  });

  it("adds, moves, and removes managed archives inside the library folder", async () => {
    const target = parseWikiGraphLibraryUri("wikg://lib");
    expect(target).toBeDefined();
    const source = join(tempDir, "source.wikg");
    await writeFile(source, "content");

    const added = await addWikiGraphLibraryArchive({
      inputPath: source,
      target: target!,
      to: "nested/book.wikg",
    });
    expect(added.relativePath).toBe("nested/book.wikg");
    expect(await readFile(added.path, "utf8")).toBe("content");

    await expect(
      addWikiGraphLibraryArchive({
        inputPath: "wikg://elsewhere/book.wikg",
        target: target!,
      }),
    ).rejects.toThrow("not a Wiki Graph URI");
    await expect(
      addWikiGraphLibraryArchive({
        inputPath: source,
        target: target!,
        to: "../x.wikg",
      }),
    ).rejects.toThrow("relative path inside the library folder");

    const archiveTarget = parseWikiGraphLibraryUri(added.uri);
    expect(archiveTarget?.kind).toBe("archive");
    const moved = await moveWikiGraphLibraryArchive({
      target: archiveTarget!,
      to: "renamed.wikg",
    });
    expect(moved.publicId).toBe(added.publicId);
    expect(moved.relativePath).toBe("renamed.wikg");

    const removed = await removeWikiGraphLibraryArchive({
      target: archiveTarget!,
    });
    expect(removed.publicId).toBe(added.publicId);
    await expect(readFile(moved.path, "utf8")).rejects.toThrow();
  });
});

describe("library URI locators", () => {
  it("separates library archives from library scopes", () => {
    expect(
      parseLocatedWikiGraphUri("wikg://lib/archive123/chapter"),
    ).toStrictEqual({
      archivePath: "wikg://lib/archive123",
      objectUri: "wikg://chapter",
    });
    expect(parseWikiGraphLibraryUri("wikg://lib/entity/Q23")).toMatchObject({
      isDefault: true,
      kind: "scope",
      objectUri: "wikg://entity/Q23",
    });
    expect(
      parseWikiGraphLibraryUri("wikg://lib/team.lib/archive123/entity"),
    ).toMatchObject({
      archivePublicId: "archive123",
      kind: "archive",
      objectUri: "wikg://entity",
      publicId: "team",
    });
  });
});
