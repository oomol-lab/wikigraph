import type { CLIConfig } from "../packages/cli/src/runtime/config.js";
import {
  createStageLLM,
  loadRequiredStageConfig,
} from "../packages/cli/src/runtime/stage.js";
import type { LLMessage } from "../packages/core/src/external/llm/index.js";
import { WikiGraphScope } from "../packages/core/src/runtime/common/llm-scope.js";
import { TEXT_COMPRESSOR_PROMPT_TEMPLATE } from "../packages/core/src/text/editor/prompt-templates.js";

interface EvalCase {
  readonly name: string;
  readonly markedText: string;
  readonly targetLength: number;
}

const CASES: readonly EvalCase[] = [
  {
    name: "self-talk-regression",
    markedText: [
      '<chunk retention="detailed">老师要求我把一次课堂实验压缩成可直接放进章节摘要的正文：实验先记录气温，再记录风向，最后比较两组植物的叶片变化。</chunk>',
      "我先说说思路：这个材料很容易让我写成分析过程，因为实验步骤看起来像一个解题流程。",
      '<chunk retention="detailed">真正需要保留的是：东窗组叶片边缘先卷曲，西窗组两小时后才出现轻微萎蔫；记录员提醒不要把自己的处理策略、取舍理由或分隔线写进最终摘要。</chunk>',
      "下面这段 filler 只是为了制造压缩压力：如果输出里出现 approach、reasoning、analysis、trade-off notes、标题或 ---，就说明问题仍然存在。",
    ].join("\n"),
    targetLength: 120,
  },
];

async function main(): Promise<void> {
  const llmJSON = readArgValue("--llm");
  if (llmJSON === undefined) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = await loadRequiredStageConfig({ llmJSON });

  const llm = createStageLLM(config);
  const outputs: unknown[] = [];

  for (const evalCase of CASES) {
    outputs.push(await runEvalCase(llm, config, evalCase));
  }

  process.stdout.write(`${JSON.stringify({ outputs }, null, 2)}\n`);
}

async function runEvalCase(
  llm: ReturnType<typeof createStageLLM>,
  config: CLIConfig,
  evalCase: EvalCase,
): Promise<Record<string, unknown>> {
  const acceptableMin = Math.floor(evalCase.targetLength * 0.85);
  const acceptableMax = Math.floor(evalCase.targetLength * 1.15);
  const currentPrompt = llm.loadSystemPrompt(TEXT_COMPRESSOR_PROMPT_TEMPLATE, {
    acceptable_max: acceptableMax,
    acceptable_min: acceptableMin,
    compression_ratio: 20,
    original_length: evalCase.markedText.length,
    target_length: evalCase.targetLength,
    user_language: undefined,
  });
  const legacyPrompt = buildLegacyPlainTextPrompt({
    acceptableMax,
    acceptableMin,
    markedTextLength: evalCase.markedText.length,
    targetLength: evalCase.targetLength,
  });
  const legacyRawOutput = await requestCompression(
    llm,
    legacyPrompt,
    evalCase.markedText,
  );
  const currentRawOutput = await requestCompression(
    llm,
    currentPrompt,
    evalCase.markedText,
  );
  const finalOutput = extractFinalCompressedText(currentRawOutput);

  return {
    case: evalCase.name,
    current: {
      finalOutput,
      heuristics: buildHeuristics(currentRawOutput, finalOutput),
      rawOutput: currentRawOutput,
    },
    legacyBeforeIssue117: {
      heuristics: buildHeuristics(legacyRawOutput, legacyRawOutput),
      rawOutput: legacyRawOutput,
    },
    model: publicModelInfo(config),
  };
}

async function requestCompression(
  llm: ReturnType<typeof createStageLLM>,
  systemPrompt: string,
  markedText: string,
): Promise<string> {
  const messages: LLMessage[] = [
    { content: systemPrompt, role: "system" },
    { content: markedText, role: "user" },
  ];

  return await llm.request(messages, {
    scope: WikiGraphScope.EditorCompress,
  });
}

function buildHeuristics(
  rawOutput: string,
  finalOutput: string,
): Record<string, boolean> {
  return {
    finalContainsDisallowedTags: /<[A-Za-z][^>]*>|<\/[A-Za-z][^>]*>/.test(
      finalOutput,
    ),
    finalContainsSelfTalkTokens: containsSelfTalkTokens(finalOutput),
    rawContainsSelfTalkTokens: containsSelfTalkTokens(rawOutput),
    rawHasExactlyOneFinalBlock: /^\s*<final>[\s\S]*<\/final>\s*$/.test(
      rawOutput,
    ),
  };
}

function containsSelfTalkTokens(value: string): boolean {
  return /\b(approach|analysis|reasoning|trade-off|self-talk)\b|思路|分析|推理|理由|取舍|策略|分隔线|^-{3,}$/im.test(
    value,
  );
}

function publicModelInfo(
  config: CLIConfig,
): Record<string, string | undefined> {
  return {
    baseURL: config.llm?.baseURL,
    model: config.llm?.model,
    name: config.llm?.name,
    provider: config.llm?.provider,
  };
}

function buildLegacyPlainTextPrompt(input: {
  readonly acceptableMax: number;
  readonly acceptableMin: number;
  readonly markedTextLength: number;
  readonly targetLength: number;
}): string {
  return [
    "You are a student working on a text compression assignment.",
    "Compress the marked text while preserving important information.",
    `Original text: ${input.markedTextLength} characters`,
    `Target length: ${input.targetLength} characters`,
    `Acceptable range: ${input.acceptableMin} - ${input.acceptableMax} characters`,
    "Remove all <chunk> tags from your output.",
    "Write plain text only, no headers and no XML/HTML markup.",
    "If you face difficult trade-offs, write 1-2 sentences about your approach. Keep this brief.",
    "---",
    "[Your compressed text - plain text only, no headers, no tags, written as continuous prose]",
  ].join("\n\n");
}

function extractFinalCompressedText(response: string): string {
  const match = /^\s*<final>([\s\S]*)<\/final>\s*$/.exec(response);
  if (match === null) {
    throw new Error("Eval output did not contain exactly one <final> block.");
  }

  const compressedText = match[1]?.trim();
  if (compressedText === undefined || compressedText === "") {
    throw new Error("Eval output contained an empty <final> block.");
  }

  return compressedText;
}

function readArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage: pnpm eval:llm -- --llm \'{"provider":"openai","model":"..."}\'',
      "This command calls a real LLM and is not part of CI or default tests.",
    ].join("\n") + "\n",
  );
}

await main();
