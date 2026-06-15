import { parseArgs } from "util";

import { type CLIFormat, parseCLIFormat } from "./formats.js";
import {
  CLI_HELP_ROUTES,
  sdpubSubcommandHelpRoute,
  withHelpRoute,
} from "./errors.js";
import { CHAPTER_STAGES, type ChapterStage } from "../facade/index.js";
import {
  parseHelpTopic,
  renderHelpTopicText,
  renderMainHelpText,
  renderStatusHelpText,
  renderSdpubHelpText,
  renderSdpubSubcommandHelpText,
  SDPUB_SUBCOMMANDS,
  type SDPubSubcommand,
} from "./help.js";

export interface CLIArguments {
  readonly digestDirPath?: string;
  readonly help: boolean;
  readonly inputPath?: string;
  readonly inputFormat?: CLIFormat;
  readonly llmJSON?: string;
  readonly outputPath?: string;
  readonly outputFormat?: CLIFormat;
  readonly prompt?: string;
  readonly verbose: boolean;
}

export interface CLISdpubArguments {
  readonly inputPath: string;
  readonly llmJSON?: string;
  readonly serialId?: number;
  readonly subcommand: Exclude<SDPubSubcommand, "chapter">;
}

export type CLISdpubChapterAction =
  | "add"
  | "generate-graph"
  | "generate-summary"
  | "list"
  | "remove"
  | "reset"
  | "set-source"
  | "set-summary"
  | "status";

export interface CLISdpubChapterArguments {
  readonly action: CLISdpubChapterAction;
  readonly chapterId?: number;
  readonly inputFormat?: Extract<CLIFormat, "markdown" | "txt">;
  readonly inputPath?: string;
  readonly llmJSON?: string;
  readonly parentChapterId?: number;
  readonly path: string;
  readonly prompt?: string;
  readonly recursive?: boolean;
  readonly resetStage?: Exclude<ChapterStage, "summarized">;
  readonly title?: string;
}

export interface CLIStatusArguments {
  readonly llmJSON?: string;
}

export type ParsedCLIArguments =
  | {
      readonly args: CLIArguments;
      readonly help: false;
      readonly kind: "convert";
    }
  | {
      readonly args: CLIArguments;
      readonly help: true;
      readonly helpText: string;
      readonly kind: "convert";
    }
  | {
      readonly args: CLISdpubArguments;
      readonly help: false;
      readonly kind: "sdpub";
    }
  | {
      readonly args?: CLISdpubArguments;
      readonly help: true;
      readonly helpText: string;
      readonly kind: "sdpub";
    }
  | {
      readonly args: CLISdpubChapterArguments;
      readonly help: false;
      readonly kind: "sdpub-chapter";
    }
  | {
      readonly help: true;
      readonly helpText: string;
      readonly kind: "sdpub-chapter";
    }
  | {
      readonly help: true;
      readonly helpText: string;
      readonly kind: "help";
    }
  | {
      readonly args: CLIStatusArguments;
      readonly help: false;
      readonly kind: "status";
    }
  | {
      readonly args: CLIStatusArguments;
      readonly help: true;
      readonly helpText: string;
      readonly kind: "status";
    };

export function parseCLIArguments(
  argv = process.argv.slice(2),
): ParsedCLIArguments {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      "digest-dir": {
        type: "string",
      },
      input: {
        type: "string",
      },
      "input-format": {
        type: "string",
      },
      llm: {
        type: "string",
      },
      output: {
        type: "string",
      },
      "output-format": {
        type: "string",
      },
      prompt: {
        type: "string",
      },
      serial: {
        type: "string",
      },
      chapter: {
        type: "string",
      },
      parent: {
        type: "string",
      },
      recursive: {
        type: "boolean",
      },
      title: {
        type: "string",
      },
      to: {
        type: "string",
      },
      verbose: {
        short: "v",
        type: "boolean",
      },
    },
    strict: true,
  });

  if (positionals[0] === "help") {
    return parseHelpArguments(positionals.slice(1), values);
  }

  if (positionals[0] === "sdpub") {
    return parseSdpubArguments(positionals.slice(1), values);
  }

  if (positionals[0] === "status") {
    return parseStatusArguments(positionals.slice(1), values);
  }

  if (positionals.length > 0) {
    throw new Error(
      withHelpRoute(
        `Unexpected positional arguments: ${positionals.join(" ")}. Use --input and --output instead.`,
        CLI_HELP_ROUTES.command,
      ),
    );
  }

  const args = {
    ...(values["digest-dir"] === undefined
      ? {}
      : { digestDirPath: values["digest-dir"] }),
    help: values.help ?? false,
    ...(values.input === undefined ? {} : { inputPath: values.input }),
    ...(values["input-format"] === undefined
      ? {}
      : {
          inputFormat: parseCLIFormat(values["input-format"], "--input-format"),
        }),
    ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
    ...(values.output === undefined ? {} : { outputPath: values.output }),
    ...(values["output-format"] === undefined
      ? {}
      : {
          outputFormat: parseCLIFormat(
            values["output-format"],
            "--output-format",
          ),
        }),
    ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
    verbose: values.verbose ?? false,
  } satisfies CLIArguments;

  if (values.help ?? false) {
    return {
      args,
      help: true,
      helpText: renderMainHelpText(),
      kind: "convert",
    };
  }

  return {
    args,
    help: false,
    kind: "convert",
  };
}

function parseSdpubArguments(
  positionals: readonly string[],
  values: {
    readonly chapter?: string;
    readonly "digest-dir"?: string;
    readonly help?: boolean;
    readonly input?: string;
    readonly "input-format"?: string;
    readonly llm?: string;
    readonly output?: string;
    readonly "output-format"?: string;
    readonly parent?: string;
    readonly prompt?: string;
    readonly recursive?: boolean;
    readonly serial?: string;
    readonly title?: string;
    readonly to?: string;
    readonly verbose?: boolean;
  },
): ParsedCLIArguments {
  const help = values.help ?? false;
  const subcommand = positionals[0];
  const isKnownSubcommand =
    subcommand !== undefined &&
    SDPUB_SUBCOMMANDS.includes(subcommand as SDPubSubcommand);

  if (subcommand === "chapter") {
    return parseSdpubChapterArguments(positionals.slice(1), values);
  }

  if (positionals.length > 1) {
    throw new Error(
      withHelpRoute(
        `Unexpected positional arguments: ${positionals.slice(1).join(" ")}.`,
        isKnownSubcommand
          ? sdpubSubcommandHelpRoute(subcommand)
          : CLI_HELP_ROUTES.sdpub,
      ),
    );
  }

  if (subcommand === undefined) {
    if (help) {
      return {
        help: true,
        helpText: renderSdpubHelpText(),
        kind: "sdpub",
      };
    }

    throw new Error(
      withHelpRoute(
        `Missing sdpub subcommand. Expected one of ${SDPUB_SUBCOMMANDS.join(", ")}.`,
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }

  if (!SDPUB_SUBCOMMANDS.includes(subcommand as SDPubSubcommand)) {
    throw new Error(
      withHelpRoute(
        `Invalid sdpub subcommand: ${subcommand}. Expected one of ${SDPUB_SUBCOMMANDS.join(", ")}.`,
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }

  const parsedSubcommand = subcommand as Exclude<SDPubSubcommand, "chapter">;

  if (values["digest-dir"] !== undefined) {
    throw new Error(
      withHelpRoute(
        "The `sdpub` subcommands do not support --digest-dir. Use the main command for digest generation.",
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }
  if (values["input-format"] !== undefined) {
    throw new Error(
      withHelpRoute(
        "The `sdpub` subcommands do not support --input-format. They always read .sdpub archives.",
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }
  if (values.output !== undefined) {
    throw new Error(
      withHelpRoute(
        "The `sdpub` subcommands do not support --output. Use stdout redirection or pipes instead.",
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }
  if (values["output-format"] !== undefined) {
    throw new Error(
      withHelpRoute(
        "The `sdpub` subcommands do not support --output-format. Their output format is fixed by the subcommand.",
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }
  if (values.prompt !== undefined) {
    throw new Error(
      withHelpRoute(
        "The `sdpub` subcommands do not support --prompt. It only applies to digest generation from source inputs.",
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }
  if (values.verbose) {
    throw new Error(
      withHelpRoute(
        "The `sdpub` subcommands do not support --verbose.",
        CLI_HELP_ROUTES.sdpub,
      ),
    );
  }

  const serialId =
    values.serial === undefined
      ? undefined
      : parseSerialId(
          values.serial,
          "--serial",
          sdpubSubcommandHelpRoute(parsedSubcommand),
        );

  if (parsedSubcommand === "cat" && serialId === undefined && !help) {
    throw new Error(
      withHelpRoute(
        "Missing --serial. `spinedigest sdpub cat` requires it.",
        sdpubSubcommandHelpRoute("cat"),
      ),
    );
  }
  if (parsedSubcommand !== "cat" && serialId !== undefined) {
    throw new Error(
      withHelpRoute(
        `The \`sdpub ${parsedSubcommand}\` subcommand does not support --serial.`,
        sdpubSubcommandHelpRoute(parsedSubcommand),
      ),
    );
  }

  const inputPath = values.input;

  if (!help) {
    if (inputPath === undefined || inputPath === "-") {
      throw new Error(
        withHelpRoute(
          "The `sdpub` subcommands require --input <path>. stdin is not supported.",
          sdpubSubcommandHelpRoute(parsedSubcommand),
        ),
      );
    }
    if (parseCLIFormat("sdpub", "--input-format") !== "sdpub") {
      throw new Error("Internal error: failed to resolve sdpub input format.");
    }
  }

  if (help) {
    return {
      help: true,
      helpText: renderSdpubSubcommandHelpText(parsedSubcommand),
      kind: "sdpub",
    };
  }

  return {
    args: {
      inputPath: inputPath!,
      ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      ...(serialId === undefined ? {} : { serialId }),
      subcommand: parsedSubcommand,
    },
    help: false,
    kind: "sdpub",
  };
}

function parseSdpubChapterArguments(
  positionals: readonly string[],
  values: {
    readonly chapter?: string;
    readonly "digest-dir"?: string;
    readonly help?: boolean;
    readonly input?: string;
    readonly "input-format"?: string;
    readonly llm?: string;
    readonly output?: string;
    readonly "output-format"?: string;
    readonly parent?: string;
    readonly prompt?: string;
    readonly recursive?: boolean;
    readonly serial?: string;
    readonly title?: string;
    readonly to?: string;
    readonly verbose?: boolean;
  },
): ParsedCLIArguments {
  const help = values.help ?? false;
  const action = positionals[0];
  const path = positionals[1];
  const helpRoute = "spinedigest sdpub chapter --help";

  rejectSdpubChapterFlag("digest-dir", values["digest-dir"]);
  rejectSdpubChapterFlag("output", values.output);
  rejectSdpubChapterFlag("output-format", values["output-format"]);
  rejectSdpubChapterFlag("serial", values.serial);
  if (values.verbose) {
    throw new Error(
      withHelpRoute(
        "The `sdpub chapter` command does not support --verbose.",
        helpRoute,
      ),
    );
  }

  if (help) {
    return {
      help: true,
      helpText: renderSdpubSubcommandHelpText("chapter"),
      kind: "sdpub-chapter",
    };
  }

  if (!isSdpubChapterAction(action)) {
    throw new Error(
      withHelpRoute(
        action === undefined
          ? "Missing sdpub chapter action."
          : `Invalid sdpub chapter action: ${action}.`,
        helpRoute,
      ),
    );
  }
  if (path === undefined || path === "-") {
    throw new Error(
      withHelpRoute(
        "`spinedigest sdpub chapter` requires a .sdpub path positional argument.",
        helpRoute,
      ),
    );
  }
  if (positionals.length > 2) {
    throw new Error(
      withHelpRoute(
        `Unexpected positional arguments: ${positionals.slice(2).join(" ")}.`,
        helpRoute,
      ),
    );
  }

  return {
    args: normalizeSdpubChapterArguments(action, path, values, helpRoute),
    help: false,
    kind: "sdpub-chapter",
  };
}

function normalizeSdpubChapterArguments(
  action: CLISdpubChapterAction,
  path: string,
  values: {
    readonly chapter?: string;
    readonly input?: string;
    readonly "input-format"?: string;
    readonly llm?: string;
    readonly parent?: string;
    readonly prompt?: string;
    readonly recursive?: boolean;
    readonly title?: string;
    readonly to?: string;
  },
  helpRoute: string,
): CLISdpubChapterArguments {
  const chapterId =
    values.chapter === undefined
      ? undefined
      : parseSerialId(values.chapter, "--chapter", helpRoute);
  const parentChapterId =
    values.parent === undefined
      ? undefined
      : parseSerialId(values.parent, "--parent", helpRoute);
  const inputFormat =
    values["input-format"] === undefined
      ? undefined
      : parseChapterInputFormat(values["input-format"], helpRoute);
  const resetStage =
    values.to === undefined ? undefined : parseResetStage(values.to, helpRoute);

  switch (action) {
    case "add":
      requireFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.chapter, "--chapter", action, helpRoute);
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        path,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
        ...(parentChapterId === undefined ? {} : { parentChapterId }),
        title: values.title,
      };
    case "generate-graph":
      requireChapterId(chapterId, action, helpRoute);
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        chapterId,
        path,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
        ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
      };
    case "generate-summary":
      requireChapterId(chapterId, action, helpRoute);
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        chapterId,
        path,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      };
    case "list":
      rejectActionFlag(values.chapter, "--chapter", action, helpRoute);
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        path,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      };
    case "remove":
      requireChapterId(chapterId, action, helpRoute);
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      return {
        action,
        chapterId,
        path,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
        ...(values.recursive === undefined
          ? {}
          : { recursive: values.recursive }),
      };
    case "reset":
      requireChapterId(chapterId, action, helpRoute);
      if (resetStage === undefined) {
        throw new Error(
          withHelpRoute(
            "Missing --to. `sdpub chapter reset` requires planned, sourced, or graphed.",
            helpRoute,
          ),
        );
      }
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        chapterId,
        path,
        resetStage,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      };
    case "set-source":
      requireChapterId(chapterId, action, helpRoute);
      if (inputFormat === undefined) {
        throw new Error(
          withHelpRoute(
            "Missing --input-format. `sdpub chapter set-source` requires txt or markdown.",
            helpRoute,
          ),
        );
      }
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        chapterId,
        inputFormat,
        path,
        ...(values.input === undefined ? {} : { inputPath: values.input }),
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      };
    case "set-summary":
      requireChapterId(chapterId, action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        chapterId,
        path,
        ...(values.input === undefined ? {} : { inputPath: values.input }),
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      };
    case "status":
      requireChapterId(chapterId, action, helpRoute);
      rejectActionFlag(values.input, "--input", action, helpRoute);
      rejectActionFlag(
        values["input-format"],
        "--input-format",
        action,
        helpRoute,
      );
      rejectActionFlag(values.parent, "--parent", action, helpRoute);
      rejectActionFlag(values.prompt, "--prompt", action, helpRoute);
      rejectActionFlag(values.title, "--title", action, helpRoute);
      rejectActionFlag(values.to, "--to", action, helpRoute);
      rejectActionBooleanFlag(
        values.recursive,
        "--recursive",
        action,
        helpRoute,
      );
      return {
        action,
        chapterId,
        path,
        ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
      };
  }
}

function parseHelpArguments(
  positionals: readonly string[],
  values: {
    readonly "digest-dir"?: string;
    readonly help?: boolean;
    readonly input?: string;
    readonly "input-format"?: string;
    readonly llm?: string;
    readonly output?: string;
    readonly "output-format"?: string;
    readonly prompt?: string;
    readonly serial?: string;
    readonly verbose?: boolean;
  },
): ParsedCLIArguments {
  rejectHelpFlag("digest-dir", values["digest-dir"]);
  rejectHelpFlag("input", values.input);
  rejectHelpFlag("input-format", values["input-format"]);
  rejectHelpFlag("llm", values.llm);
  rejectHelpFlag("output", values.output);
  rejectHelpFlag("output-format", values["output-format"]);
  rejectHelpFlag("prompt", values.prompt);
  rejectHelpFlag("serial", values.serial);

  if (values.verbose) {
    throw new Error(
      withHelpRoute(
        "The `help` command does not support --verbose.",
        CLI_HELP_ROUTES.root,
      ),
    );
  }

  if (positionals.length > 1) {
    throw new Error(
      withHelpRoute(
        `Unexpected positional arguments: ${positionals.slice(1).join(" ")}.`,
        CLI_HELP_ROUTES.root,
      ),
    );
  }

  if (positionals[0] === undefined) {
    return {
      help: true,
      helpText: renderMainHelpText(),
      kind: "help",
    };
  }

  return {
    help: true,
    helpText: renderHelpTopicText(parseHelpTopic(positionals[0])),
    kind: "help",
  };
}

function parseStatusArguments(
  positionals: readonly string[],
  values: {
    readonly "digest-dir"?: string;
    readonly help?: boolean;
    readonly input?: string;
    readonly "input-format"?: string;
    readonly llm?: string;
    readonly output?: string;
    readonly "output-format"?: string;
    readonly prompt?: string;
    readonly serial?: string;
    readonly verbose?: boolean;
  },
): ParsedCLIArguments {
  rejectStatusFlag("digest-dir", values["digest-dir"]);
  rejectStatusFlag("input", values.input);
  rejectStatusFlag("input-format", values["input-format"]);
  rejectStatusFlag("output", values.output);
  rejectStatusFlag("output-format", values["output-format"]);
  rejectStatusFlag("prompt", values.prompt);
  rejectStatusFlag("serial", values.serial);

  if (values.verbose) {
    throw new Error(
      withHelpRoute(
        "The `status` command does not support --verbose.",
        "spinedigest status --help",
      ),
    );
  }

  if (positionals.length > 0) {
    throw new Error(
      withHelpRoute(
        `Unexpected positional arguments: ${positionals.join(" ")}.`,
        "spinedigest status --help",
      ),
    );
  }

  const args = {
    ...(values.llm === undefined ? {} : { llmJSON: values.llm }),
  } satisfies CLIStatusArguments;

  if (values.help ?? false) {
    return {
      args,
      help: true,
      helpText: renderStatusHelpText(),
      kind: "status",
    };
  }

  return {
    args,
    help: false,
    kind: "status",
  };
}

function parseSerialId(value: string, flag: string, helpRoute: string): number {
  const normalized = value.trim();

  if (!/^\d+$/u.test(normalized)) {
    throw new Error(
      withHelpRoute(
        `Invalid ${flag}: ${value}. Expected a non-negative integer.`,
        helpRoute,
      ),
    );
  }

  return Number(normalized);
}

function isSdpubChapterAction(
  value: string | undefined,
): value is CLISdpubChapterAction {
  return (
    value === "add" ||
    value === "generate-graph" ||
    value === "generate-summary" ||
    value === "list" ||
    value === "remove" ||
    value === "reset" ||
    value === "set-source" ||
    value === "set-summary" ||
    value === "status"
  );
}

function parseChapterInputFormat(
  value: string,
  helpRoute: string,
): Extract<CLIFormat, "markdown" | "txt"> {
  const format = parseCLIFormat(value, "--input-format");

  if (format === "markdown" || format === "txt") {
    return format;
  }

  throw new Error(
    withHelpRoute(
      `Invalid --input-format for sdpub chapter source: ${value}. Expected txt or markdown.`,
      helpRoute,
    ),
  );
}

function parseResetStage(
  value: string,
  helpRoute: string,
): Exclude<ChapterStage, "summarized"> {
  const normalized = value.trim().toLowerCase();

  if (
    normalized === "planned" ||
    normalized === "sourced" ||
    normalized === "graphed"
  ) {
    return normalized;
  }
  if (CHAPTER_STAGES.includes(normalized as ChapterStage)) {
    throw new Error(
      withHelpRoute(
        "`sdpub chapter reset` does not support --to summarized.",
        helpRoute,
      ),
    );
  }

  throw new Error(
    withHelpRoute(
      `Invalid --to: ${value}. Expected planned, sourced, or graphed.`,
      helpRoute,
    ),
  );
}

function rejectActionFlag(
  value: string | undefined,
  flag: string,
  action: CLISdpubChapterAction,
  helpRoute: string,
): void {
  if (value !== undefined) {
    throw new Error(
      withHelpRoute(
        `The \`sdpub chapter ${action}\` action does not support ${flag}.`,
        helpRoute,
      ),
    );
  }
}

function rejectActionBooleanFlag(
  value: boolean | undefined,
  flag: string,
  action: CLISdpubChapterAction,
  helpRoute: string,
): void {
  if (value !== undefined) {
    throw new Error(
      withHelpRoute(
        `The \`sdpub chapter ${action}\` action does not support ${flag}.`,
        helpRoute,
      ),
    );
  }
}

function rejectSdpubChapterFlag(name: string, value: string | undefined): void {
  if (value !== undefined) {
    throw new Error(
      withHelpRoute(
        `The \`sdpub chapter\` command does not support --${name}.`,
        "spinedigest sdpub chapter --help",
      ),
    );
  }
}

function requireChapterId(
  chapterId: number | undefined,
  action: CLISdpubChapterAction,
  helpRoute: string,
): asserts chapterId is number {
  if (chapterId === undefined) {
    throw new Error(
      withHelpRoute(
        `Missing --chapter. \`sdpub chapter ${action}\` requires a chapter id.`,
        helpRoute,
      ),
    );
  }
}

function requireFlag(
  value: string | undefined,
  flag: string,
  action: CLISdpubChapterAction,
  helpRoute: string,
): asserts value is string {
  if (value === undefined) {
    throw new Error(
      withHelpRoute(
        `Missing ${flag}. \`sdpub chapter ${action}\` requires it.`,
        helpRoute,
      ),
    );
  }
}

function rejectHelpFlag(name: string, value: string | undefined): void {
  if (value !== undefined) {
    throw new Error(
      withHelpRoute(
        `The \`help\` command does not support --${name}.`,
        CLI_HELP_ROUTES.root,
      ),
    );
  }
}

function rejectStatusFlag(name: string, value: string | undefined): void {
  if (value !== undefined) {
    throw new Error(
      withHelpRoute(
        `The \`status\` command does not support --${name}.`,
        "spinedigest status --help",
      ),
    );
  }
}
