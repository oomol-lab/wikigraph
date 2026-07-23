import { renderMaintenanceCommandHelpText } from "../help.js";
import { withHelpRoute } from "../../support/index.js";
import type { ArchiveArgumentValues, ParsedCLIArguments } from "../types.js";

export function parseMaintenanceArguments(
  positionals: readonly string[],
  values: ArchiveArgumentValues,
): ParsedCLIArguments {
  const action = positionals[0];

  if (values.help === true && action === undefined) {
    return {
      help: true,
      helpText: renderMaintenanceCommandHelpText(),
      kind: "help",
    };
  }

  if (action !== "upgrade") {
    throw new Error(
      withHelpRoute(
        action === undefined
          ? "Missing maintenance command."
          : `Invalid maintenance command: ${action}.`,
        "wg maintenance --help",
      ),
    );
  }

  if (values.help === true) {
    return {
      help: true,
      helpText: renderMaintenanceCommandHelpText("upgrade"),
      kind: "help",
    };
  }

  rejectMaintenanceFlag("--input", values.input);
  rejectMaintenanceFlag("--import", values.import);
  rejectMaintenanceFlag("--input-format", values["input-format"]);
  rejectMaintenanceFlag("--output-format", values["output-format"]);
  rejectMaintenanceFlag("--llm", values.llm);
  rejectMaintenanceFlag("--prompt", values.prompt);
  rejectMaintenanceBooleanFlag("--jsonl", values.jsonl);
  rejectMaintenanceBooleanFlag("--verbose", values.verbose);

  const target = positionals[1];
  if (target === undefined) {
    throw new Error(
      withHelpRoute(
        "Missing maintenance upgrade target.",
        "wg maintenance upgrade --help",
      ),
    );
  }
  if (positionals.length > 2) {
    throw new Error(
      withHelpRoute(
        `Unexpected positional arguments: ${positionals.slice(2).join(" ")}.`,
        "wg maintenance upgrade --help",
      ),
    );
  }

  return {
    args: {
      action,
      ...(values.json === undefined ? {} : { json: values.json }),
      ...(values.output === undefined ? {} : { outputPath: values.output }),
      target,
    },
    help: false,
    kind: "maintenance-command",
  };
}

function rejectMaintenanceFlag(flag: string, value: unknown): void {
  if (value !== undefined) {
    throw new Error(
      withHelpRoute(
        `\`wg maintenance upgrade\` does not support ${flag}.`,
        "wg maintenance upgrade --help",
      ),
    );
  }
}

function rejectMaintenanceBooleanFlag(
  flag: string,
  value: boolean | undefined,
): void {
  if (value === true) {
    rejectMaintenanceFlag(flag, value);
  }
}
