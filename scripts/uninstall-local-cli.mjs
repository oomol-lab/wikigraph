import { execFileSync } from "child_process";
import { rmSync } from "fs";
import { delimiter, join, resolve } from "path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const globalBinDir = execFileSync("pnpm", ["bin", "--global"], {
  cwd: workspaceRoot,
  encoding: "utf8",
}).trim();
const localGlobalDir = join(globalBinDir, ".wiki-graph-local-global");
const pnpmGlobalEnv = {
  ...process.env,
  PATH: [globalBinDir, process.env.PATH].filter(Boolean).join(delimiter),
};

try {
  execFileSync(
    "pnpm",
    [
      "remove",
      "--global",
      "--global-dir",
      localGlobalDir,
      `--config.global-bin-dir=${globalBinDir}`,
      "wiki-graph",
    ],
    {
      cwd: workspaceRoot,
      env: pnpmGlobalEnv,
      stdio: "inherit",
    },
  );
} finally {
  rmSync(localGlobalDir, { force: true, recursive: true });
}
