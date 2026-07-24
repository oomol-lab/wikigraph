import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, resolve } from "path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const cliRoot = join(workspaceRoot, "packages", "cli");
const packRoot = mkdtempSync(join(tmpdir(), "wiki-graph-local-pack-"));

function createNpmEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toLowerCase().startsWith("npm_config_"),
    ),
  );
}

function readTarballPath(packOutput) {
  const packResult = JSON.parse(packOutput);
  const filename = Array.isArray(packResult)
    ? packResult[0]?.filename
    : packResult.filename;

  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(
      "Failed to resolve tarball filename from pnpm pack output.",
    );
  }

  return isAbsolute(filename) ? filename : join(packRoot, filename);
}

execFileSync("pnpm", ["build"], {
  cwd: workspaceRoot,
  stdio: "inherit",
});

try {
  const packOutput = execFileSync(
    "pnpm",
    ["pack", "--json", "--pack-destination", packRoot],
    {
      cwd: cliRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const tarballPath = readTarballPath(packOutput);

  execFileSync("npm", ["install", "--global", "--force", tarballPath], {
    cwd: workspaceRoot,
    env: createNpmEnv(),
    stdio: "inherit",
  });
} finally {
  rmSync(packRoot, { force: true, recursive: true });
}
