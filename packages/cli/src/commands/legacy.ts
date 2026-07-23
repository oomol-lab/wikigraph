import type { CLILegacyArguments } from "../args/index.js";
import { upgradeWikiGraphMaintenanceTarget } from "wiki-graph-core";

export async function runLegacyCommand(
  args: CLILegacyArguments,
): Promise<void> {
  switch (args.action) {
    case "migrate": {
      process.stderr.write(
        "`wg legacy migrate` is deprecated. Use `wg maintenance upgrade <sdpub-path>`.\n",
      );
      const result = await upgradeWikiGraphMaintenanceTarget(args.inputPath, {
        ...(args.outputPath === undefined
          ? {}
          : { outputPath: args.outputPath }),
      });

      if (result.kind !== "sdpub") {
        throw new Error("Legacy migrate only supports sdpub inputs.");
      }

      process.stdout.write(`Wrote ${result.outputPath}\n`);
      return;
    }
  }
}
