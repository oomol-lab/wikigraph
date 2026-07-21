import type { Language } from "../../common/language.js";
import type { WikiGraphScope } from "../../common/llm-scope.js";
import type { LLM } from "../../llm/index.js";
import type {
  BuildSerialTopologyOptions,
  SerialProgressSink,
} from "../../serial.js";
import { resolveExtractionPrompt } from "../prompts.js";

export interface GenerateChapterGraphOptions {
  readonly extractionPrompt?: string;
  readonly llm: LLM<WikiGraphScope>;
  readonly logDirPath?: string;
  readonly progressTracker?: SerialProgressSink;
  readonly userLanguage?: Language;
}

export interface GenerateChapterSummaryOptions {
  readonly llm: LLM<WikiGraphScope>;
  readonly logDirPath?: string;
  readonly userLanguage?: Language;
}

export function createTopologyOptions(
  options: GenerateChapterGraphOptions,
): BuildSerialTopologyOptions {
  return {
    extractionPrompt: resolveExtractionPrompt(options.extractionPrompt),
    ...(options.userLanguage === undefined
      ? {}
      : { userLanguage: options.userLanguage }),
  };
}
