import { SpineDigestApp } from "../index.js";
import { SpineDigestFile } from "../facade/spine-digest-file.js";
import {
  listChapters,
  type ChapterEntry,
  type SpineDigest,
} from "../facade/index.js";
import type { BookMeta, TocFile, TocItem } from "../source/index.js";

import type { CLISdpubArguments, SdpubMetaPatch } from "./args.js";
import { writeBinaryToStdout, writeTextToStdout } from "./io.js";

export async function runSdpubCommand(args: CLISdpubArguments): Promise<void> {
  if (args.subcommand === "meta" && args.metaPatch !== undefined) {
    await updateSdpubMeta(args.inputPath, args.metaPatch);
    return;
  }
  if (args.subcommand === "list") {
    await writeSdpubChapterList(args.inputPath, {
      json: args.json ?? false,
    });
    return;
  }

  const app = new SpineDigestApp({});
  await app.openSession(args.inputPath, async (digest) => {
    switch (args.subcommand) {
      case "info":
        await writeSdpubInfo(digest);
        return;
      case "toc":
        await writeSdpubToc(digest);
        return;
      case "cat":
        await writeTextToStdout(
          await digest.readSerialSummary(args.chapterId!),
        );
        return;
      case "cover":
        await writeSdpubCover(digest);
        return;
      case "meta":
        await writeSdpubMeta(await digest.readMeta(), {
          json: args.json ?? false,
        });
        return;
    }
  });
}

async function writeSdpubInfo(digest: SpineDigest): Promise<void> {
  const [formatVersion, meta, cover, toc, serials] = await Promise.all([
    digest.readArchiveFormatVersion(),
    digest.readMeta(),
    digest.readCover(),
    digest.readToc(),
    digest.listSerials().catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "Document TOC is missing"
      ) {
        return [];
      }

      throw error;
    }),
  ]);
  const referencedChapterCount =
    toc === undefined ? 0 : countReferencedChapters(toc.items);
  const lines: string[] = [];

  lines.push(`Archive Format Version: ${formatVersion}`);
  appendMetaLines(lines, meta);
  lines.push(`Cover: ${cover === undefined ? "no" : "yes"}`);
  appendOptionalLine(lines, "Cover Media Type", cover?.mediaType);
  appendOptionalLine(lines, "Cover Path", cover?.path);

  if (toc !== undefined) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(`Top-level Sections: ${toc.items.length}`);
    lines.push(`Referenced Chapters: ${referencedChapterCount}`);
    lines.push(`Summarized Chapters: ${serials.length}`);
    lines.push(
      `Source Units: ${serials.reduce(
        (total, serial) => total + serial.fragmentCount,
        0,
      )}`,
    );
  }

  if (lines.length === 0) {
    lines.push("No document metadata is available.");
  }

  await writeTextToStdout(`${lines.join("\n")}\n`);
}

async function writeSdpubToc(digest: SpineDigest): Promise<void> {
  const [meta, toc] = await Promise.all([
    digest.readMeta(),
    requireToc(digest),
  ]);
  const lines: string[] = [];
  const title = normalizeDisplayValue(meta?.title);

  if (title !== undefined) {
    lines.push(title, "");
  }

  const tocLines = renderTocLines(toc.items);

  if (tocLines.length === 0) {
    lines.push("No TOC items.");
  } else {
    lines.push(...tocLines);
  }

  await writeTextToStdout(`${lines.join("\n")}\n`);
}

async function writeSdpubChapterList(
  path: string,
  options: { readonly json: boolean },
): Promise<void> {
  await new SpineDigestFile(path).openEditableSession(async (document) => {
    const entries = await listChapters(document);

    if (options.json) {
      await writeTextToStdout(
        `${JSON.stringify(formatChapterListJSON(entries), null, 2)}\n`,
      );
      return;
    }

    if (entries.length === 0) {
      await writeTextToStdout("No chapters.\n");
      return;
    }

    await writeTextToStdout(
      `${entries.map(formatChapterListLine).join("\n")}\n`,
    );
  });
}

async function writeSdpubCover(digest: SpineDigest): Promise<void> {
  if (process.stdout.isTTY === true) {
    throw new Error(
      "Refusing to write binary cover data to an interactive terminal. Redirect stdout or pipe it.",
    );
  }

  const cover = await digest.readCover();

  if (cover === undefined) {
    throw new Error("Document cover is missing.");
  }

  await writeBinaryToStdout(cover.data);
}

async function updateSdpubMeta(
  path: string,
  patch: SdpubMetaPatch,
): Promise<void> {
  await new SpineDigestFile(path).openEditableSession(async (document) => {
    const meta = await document.readBookMeta();

    if (meta === undefined) {
      throw new Error("Document book meta is missing.");
    }

    const updatedMeta = applySdpubMetaPatch(meta, patch);

    await document.replaceBookMeta(updatedMeta);
    await writeSdpubMeta(updatedMeta, { json: false });
  });
}

async function writeSdpubMeta(
  meta: BookMeta | undefined,
  options: { readonly json: boolean },
): Promise<void> {
  if (options.json) {
    await writeTextToStdout(
      `${JSON.stringify(formatMetaJSON(meta), null, 2)}\n`,
    );
    return;
  }

  if (meta === undefined) {
    await writeTextToStdout("No document metadata is available.\n");
    return;
  }

  const lines: string[] = [];

  appendMetaLines(lines, meta);

  await writeTextToStdout(`${lines.join("\n")}\n`);
}

function applySdpubMetaPatch(meta: BookMeta, patch: SdpubMetaPatch): BookMeta {
  return {
    ...meta,
    title: patch.clearTitle === true ? null : (patch.title ?? meta.title),
    authors:
      patch.clearAuthors === true
        ? []
        : patch.authors === undefined
          ? meta.authors
          : [...patch.authors],
    language:
      patch.clearLanguage === true ? null : (patch.language ?? meta.language),
    identifier:
      patch.clearIdentifier === true
        ? null
        : (patch.identifier ?? meta.identifier),
    publisher:
      patch.clearPublisher === true
        ? null
        : (patch.publisher ?? meta.publisher),
    publishedAt:
      patch.clearPublishedAt === true
        ? null
        : (patch.publishedAt ?? meta.publishedAt),
    description:
      patch.clearDescription === true
        ? null
        : (patch.description ?? meta.description),
  };
}

function formatChapterListLine(entry: ChapterEntry): string {
  const stageSuffix = entry.stage === "summarized" ? "" : ` (${entry.stage})`;
  return `${"  ".repeat(entry.depth)}[${entry.chapterId}] ${entry.title ?? "[untitled]"}${stageSuffix}`;
}

function formatChapterListJSON(entries: readonly ChapterEntry[]): object {
  return {
    chapters: entries.map((entry) => ({
      catReady: entry.stage === "summarized",
      chapterId: entry.chapterId,
      childCount: entry.childCount,
      depth: entry.depth,
      stage: entry.stage,
      title: entry.title,
      tocPath: entry.tocPath,
    })),
  };
}

function appendMetaLines(lines: string[], meta: BookMeta | undefined): void {
  lines.push(`Source Format: ${meta?.sourceFormat ?? "[none]"}`);
  lines.push(`Title: ${meta?.title ?? "[none]"}`);
  lines.push(
    `Authors: ${
      meta?.authors.length === undefined || meta.authors.length === 0
        ? "[none]"
        : meta.authors.join(", ")
    }`,
  );
  lines.push(`Language: ${meta?.language ?? "[none]"}`);
  lines.push(`Identifier: ${meta?.identifier ?? "[none]"}`);
  lines.push(`Publisher: ${meta?.publisher ?? "[none]"}`);
  lines.push(`Published At: ${meta?.publishedAt ?? "[none]"}`);
  lines.push(`Description: ${meta?.description ?? "[none]"}`);
}

function formatMetaJSON(meta: BookMeta | undefined): object {
  return {
    authors: meta?.authors ?? [],
    description: meta?.description ?? null,
    identifier: meta?.identifier ?? null,
    language: meta?.language ?? null,
    publishedAt: meta?.publishedAt ?? null,
    publisher: meta?.publisher ?? null,
    sourceFormat: meta?.sourceFormat ?? null,
    title: meta?.title ?? null,
  };
}

function appendOptionalLine(
  lines: string[],
  label: string,
  value: string | null | undefined,
): void {
  const normalized = normalizeDisplayValue(value);

  if (normalized !== undefined) {
    lines.push(`${label}: ${normalized}`);
  }
}

function normalizeDisplayValue(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();

  return normalized === undefined || normalized === "" ? undefined : normalized;
}

async function requireToc(digest: SpineDigest): Promise<TocFile> {
  const toc = await digest.readToc();

  if (toc === undefined) {
    throw new Error("Document TOC is missing");
  }

  return toc;
}

function countReferencedChapters(items: readonly TocItem[]): number {
  return items.reduce(
    (total, item) =>
      total +
      (item.serialId === undefined ? 0 : 1) +
      countReferencedChapters(item.children),
    0,
  );
}

function renderTocLines(
  items: readonly TocItem[],
  depth = 0,
): readonly string[] {
  const lines: string[] = [];

  for (const item of items) {
    lines.push(
      `${"  ".repeat(depth)}${item.title?.trim() || "[untitled]"}${
        item.serialId === undefined ? "" : ` [chapter ${item.serialId}]`
      }`,
    );
    lines.push(...renderTocLines(item.children, depth + 1));
  }

  return lines;
}
