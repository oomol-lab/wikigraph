import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, resolve } from "path";

const packageRoot = resolve(import.meta.dirname, "..");
const coreRoot = join(packageRoot, "packages", "core");
const cliRoot = join(packageRoot, "packages", "cli");
const tempRoot = mkdtempSync(join(tmpdir(), "wiki-graph-pack-"));
const packedTarballs = [];

function readTarballName(packOutput) {
  const packResult = JSON.parse(packOutput);
  const filename = Array.isArray(packResult)
    ? packResult[0]?.filename
    : packResult.filename;

  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Failed to resolve tarball filename from npm pack output.");
  }

  return filename;
}

function packPackage(packageDirectory) {
  const packOutput = execFileSync(
    "pnpm",
    ["pack", "--json", "--pack-destination", tempRoot],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const tarballName = readTarballName(packOutput);
  const tarballPath = isAbsolute(tarballName)
    ? tarballName
    : join(packageDirectory, tarballName);
  packedTarballs.push(tarballPath);
  return tarballPath;
}

function assertCommonJsExport(specifier, exportName) {
  execFileSync(
    process.execPath,
    [
      "-e",
      [
        `const mod = require(${JSON.stringify(specifier)});`,
        `if (mod[${JSON.stringify(exportName)}] === undefined || mod[${JSON.stringify(exportName)}] === null) {`,
        `  throw new Error(${JSON.stringify(`CommonJS export ${exportName} is not available from ${specifier}`)});`,
        "}",
      ].join(" "),
    ],
    {
      cwd: tempRoot,
      stdio: "inherit",
    },
  );
}

function assertEsmExport(specifier, exportName) {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const mod = await import(${JSON.stringify(specifier)});`,
        `if (mod[${JSON.stringify(exportName)}] === undefined || mod[${JSON.stringify(exportName)}] === null) {`,
        `  throw new Error(${JSON.stringify(`ESM export ${exportName} is not available from ${specifier}`)});`,
        "}",
      ].join(" "),
    ],
    {
      cwd: tempRoot,
      stdio: "inherit",
    },
  );
}

try {
  const coreTarballPath = packPackage(coreRoot);
  const cliTarballPath = packPackage(cliRoot);

  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "wiki-graph-pack-smoke", private: true }),
  );

  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      coreTarballPath,
      cliTarballPath,
    ],
    {
      cwd: tempRoot,
      stdio: "inherit",
    },
  );

  assertCommonJsExport("wiki-graph", "Language");
  assertEsmExport("wiki-graph", "Language");
  assertCommonJsExport("wiki-graph-core", "WikiGraph");
  assertEsmExport("wiki-graph-core", "WikiGraph");
  assertCommonJsExport("wiki-graph-core/gc", "tryRunWikiGraphGc");
  assertEsmExport("wiki-graph-core/gc", "tryRunWikiGraphGc");
  assertCommonJsExport("wiki-graph-core/worker", "runBuildJobWorker");
  assertEsmExport("wiki-graph-core/worker", "runBuildJobWorker");

  for (const command of ["wg", "wikigraph"]) {
    execFileSync(join(tempRoot, "node_modules", ".bin", command), ["--help"], {
      cwd: tempRoot,
      stdio: "inherit",
    });
  }
} finally {
  for (const tarballPath of packedTarballs) {
    rmSync(tarballPath, { force: true });
  }

  rmSync(tempRoot, { force: true, recursive: true });
}
