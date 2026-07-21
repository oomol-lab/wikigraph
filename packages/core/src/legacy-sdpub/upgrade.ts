import { rm } from "fs/promises";
import { join, resolve } from "path";

import { createWikiGraphTempDirectory } from "../common/wiki-graph/temp.js";
import { writeWikgArchive } from "../wikg/index.js";
import { extractLegacySdpubArchive } from "./upgrade/extract.js";
import { migrateLegacyDatabase } from "./upgrade/schema.js";
import { migrateLegacyTextStorage } from "./upgrade/text-storage.js";

export interface LegacySdpubMigrationResult {
  readonly inputPath: string;
  readonly outputPath: string;
}

export async function migrateLegacySdpubToWikg(
  inputPath: string,
  outputPath = defaultWikgOutputPath(inputPath),
): Promise<LegacySdpubMigrationResult> {
  if (resolve(inputPath) === resolve(outputPath)) {
    throw new Error(
      "Legacy migration output path must differ from input path.",
    );
  }

  const workspacePath = await createWikiGraphTempDirectory("sdpub-upgrade");

  try {
    await extractLegacySdpubArchive(inputPath, workspacePath);
    await migrateLegacyDatabase(join(workspacePath, "database.db"));
    await migrateLegacyTextStorage(workspacePath);
    await writeWikgArchive(workspacePath, outputPath);

    return { inputPath, outputPath };
  } finally {
    await rm(workspacePath, { force: true, recursive: true });
  }
}

function defaultWikgOutputPath(inputPath: string): string {
  if (inputPath.toLowerCase().endsWith(".sdpub")) {
    return `${inputPath.slice(0, -".sdpub".length)}.wikg`;
  }

  return `${inputPath}.wikg`;
}
