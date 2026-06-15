import { createReadStream } from "fs";
import { readFile } from "fs/promises";

import { resolveDataDirPath } from "../common/data-dir.js";
import type { SpineDigestScope } from "../common/llm-scope.js";
import type { DirectoryDocument } from "../document/index.js";
import {
  addChapter,
  generateChapterGraph,
  generateChapterSummary,
  getChapterDetails,
  listChapters,
  removeChapter,
  resetChapter,
  setChapterSource,
  setChapterSummary,
  type ChapterDetails,
  type ChapterEntry,
} from "../facade/index.js";
import { createDefaultSpineDigestSampling } from "../facade/llm-sampling.js";
import { SpineDigestFile } from "../facade/spine-digest-file.js";
import { LLM } from "../llm/index.js";

import type { CLISdpubChapterArguments } from "./args.js";
import { loadCLIConfig, type CLIConfig } from "./config.js";
import { CLI_HELP_ROUTES, withHelpRoute } from "./errors.js";
import { buildLLMOptions } from "./llm.js";
import { readTextStreamFromStdin, writeTextToStdout } from "./io.js";

const DEFAULT_EXTRACTION_PROMPT =
  "Focus on the main storyline and key character developments. Preserve important dialogues and critical plot points. Background descriptions and minor details can be compressed significantly.";

export async function runSdpubChapterCommand(
  args: CLISdpubChapterArguments,
): Promise<void> {
  switch (args.action) {
    case "add":
      await runEditableCommand(args.path, async (document) => {
        const details = await addChapter(document, {
          ...(args.parentChapterId === undefined
            ? {}
            : { parentChapterId: args.parentChapterId }),
          title: args.title!,
        });

        await writeChapterDetails(details);
      });
      return;
    case "generate-graph":
      await runEditableCommand(args.path, async (document) => {
        const config = await loadRequiredChapterConfig(args);
        const details = await generateChapterGraph(document, args.chapterId!, {
          extractionPrompt: resolveExtractionPrompt(
            args.prompt ?? config.prompt,
          ),
          llm: createChapterLLM(config),
        });

        await writeChapterDetails(details);
      });
      return;
    case "generate-summary":
      await runEditableCommand(args.path, async (document) => {
        const config = await loadRequiredChapterConfig(args);
        const details = await generateChapterSummary(
          document,
          args.chapterId!,
          {
            llm: createChapterLLM(config),
          },
        );

        await writeChapterDetails(details);
      });
      return;
    case "list":
      await new SpineDigestFile(args.path).openEditableSession(
        async (document) => {
          await writeChapterList(await listChapters(document));
        },
      );
      return;
    case "remove":
      await runEditableCommand(args.path, async (document) => {
        await removeChapter(document, args.chapterId!, {
          recursive: args.recursive ?? false,
        });
        await writeTextToStdout(`Removed chapter ${args.chapterId!}.\n`);
      });
      return;
    case "reset":
      await runEditableCommand(args.path, async (document) => {
        const details = await resetChapter(
          document,
          args.chapterId!,
          args.resetStage!,
        );

        await writeChapterDetails(details);
      });
      return;
    case "set-source":
      await runEditableCommand(args.path, async (document) => {
        const details = await setChapterSource(
          document,
          args.chapterId!,
          createContentStream(args),
        );

        await writeChapterDetails(details);
      });
      return;
    case "set-summary":
      await runEditableCommand(args.path, async (document) => {
        const details = await setChapterSummary(
          document,
          args.chapterId!,
          await readContentText(args),
        );

        await writeChapterDetails(details);
      });
      return;
    case "status":
      await new SpineDigestFile(args.path).openEditableSession(
        async (document) => {
          await writeChapterDetails(
            await getChapterDetails(document, args.chapterId!),
          );
        },
      );
      return;
  }
}

function resolveExtractionPrompt(prompt: string | undefined): string {
  const normalizedPrompt = prompt?.trim();

  return normalizedPrompt === undefined || normalizedPrompt === ""
    ? DEFAULT_EXTRACTION_PROMPT
    : normalizedPrompt;
}

function createChapterLLM(config: CLIConfig): LLM<SpineDigestScope> {
  const llmOptions = buildLLMOptions(config);

  return new LLM<SpineDigestScope>({
    dataDirPath: resolveDataDirPath(),
    sampling: createDefaultSpineDigestSampling({
      ...(llmOptions.temperature === undefined
        ? {}
        : { temperature: llmOptions.temperature }),
      ...(llmOptions.topP === undefined ? {} : { topP: llmOptions.topP }),
    }),
    ...llmOptions,
  });
}

async function loadRequiredChapterConfig(
  args: CLISdpubChapterArguments,
): Promise<CLIConfig> {
  const config = await loadCLIConfig({
    ...(args.llmJSON === undefined ? {} : { llmJSON: args.llmJSON }),
  });

  if (config.llm?.provider === undefined || config.llm.model === undefined) {
    throw new Error(
      withHelpRoute(
        "Missing LLM configuration. Set --llm, `llm.provider` and `llm.model` in ~/.spinedigest/config.json, or the matching SPINEDIGEST_LLM_* environment variables.",
        CLI_HELP_ROUTES.config,
      ),
    );
  }

  return config;
}

async function runEditableCommand(
  path: string,
  operation: (document: DirectoryDocument) => Promise<void> | void,
): Promise<void> {
  await new SpineDigestFile(path).openEditableSession(operation);
}

function createContentStream(
  args: Pick<CLISdpubChapterArguments, "inputPath">,
): AsyncIterable<string> {
  if (args.inputPath !== undefined) {
    return createReadStream(args.inputPath, { encoding: "utf8" });
  }
  if (process.stdin.isTTY) {
    throw new Error(
      "Missing --input. Pipe text into stdin or pass --input <path>.",
    );
  }

  return readTextStreamFromStdin();
}

async function readContentText(
  args: Pick<CLISdpubChapterArguments, "inputPath">,
): Promise<string> {
  if (args.inputPath !== undefined) {
    return await readFile(args.inputPath, "utf8");
  }
  let content = "";

  for await (const chunk of createContentStream(args)) {
    content += chunk;
  }

  return content;
}

async function writeChapterDetails(details: ChapterDetails): Promise<void> {
  const lines = [
    `Chapter: ${details.chapterId}`,
    `Title: ${details.title}`,
    `Stage: ${details.stage}`,
    `Fragments: ${details.fragmentCount}`,
    `Children: ${details.childCount}`,
    `Graph: ${details.graphReady ? "yes" : "no"}`,
    `Summary: ${details.hasSummary ? "yes" : "no"}`,
  ];

  await writeTextToStdout(`${lines.join("\n")}\n`);
}

async function writeChapterList(
  entries: readonly ChapterEntry[],
): Promise<void> {
  if (entries.length === 0) {
    await writeTextToStdout("No chapters.\n");
    return;
  }

  await writeTextToStdout(
    `${entries
      .map(
        (entry) =>
          `${"  ".repeat(entry.depth)}[${entry.chapterId}] ${entry.stage.padEnd(10)} ${entry.title}`,
      )
      .join("\n")}\n`,
  );
}
