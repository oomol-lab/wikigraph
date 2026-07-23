import {
  upgradeWikiGraphMaintenanceTarget,
  type WikiGraphMaintenanceUpgradeResult,
} from "wiki-graph-core";

import type { CLIMaintenanceArguments } from "../args/index.js";
import { formatCLIJSON, writeTextToStdout } from "../support/index.js";

export async function runMaintenanceCommand(
  args: CLIMaintenanceArguments,
): Promise<void> {
  switch (args.action) {
    case "upgrade": {
      const result = await upgradeWikiGraphMaintenanceTarget(args.target, {
        ...(args.outputPath === undefined
          ? {}
          : { outputPath: args.outputPath }),
      });
      await writeTextToStdout(
        args.json === true
          ? formatCLIJSON(result)
          : formatMaintenanceUpgradeResult(result),
      );
      return;
    }
  }
}

function formatMaintenanceUpgradeResult(
  result: WikiGraphMaintenanceUpgradeResult,
): string {
  switch (result.kind) {
    case "home":
      return `Home ${result.status}: ${result.path} (schema v${result.schemaVersionBefore} -> v${result.schemaVersionAfter})\n`;
    case "archive":
      return `Archive ${result.status}: ${result.path} (schema v${result.schemaVersionBefore} -> v${result.schemaVersionAfter})\n`;
    case "sdpub":
      return `Wrote ${result.outputPath}\n`;
    case "lib": {
      const lines = [
        `Library ${result.status}: ${result.library.uri}`,
        `upgraded: ${result.upgraded.length}`,
        `already current: ${result.skipped.length}`,
      ];
      if (result.failed !== undefined) {
        lines.push(`failed: ${result.failed.uri} (${result.failed.message})`);
      }
      return `${lines.join("\n")}\n`;
    }
  }
}
