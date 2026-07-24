import { existsSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join } from "path";

const binNames = ["wg", "wikigraph"];
const binSuffixes = ["", ".cmd", ".bat", ".ps1"];
const localGlobalDirName = ".wiki-graph-local-global";

function normalizePathText(value) {
  return value.replaceAll("\\", "/");
}

function expandPnpmShimPathText(content, globalBinDir) {
  const normalizedGlobalBinDir = normalizePathText(globalBinDir);

  return normalizePathText(content)
    .replaceAll("$basedir/", `${normalizedGlobalBinDir}/`)
    .replaceAll("%dp0%/", `${normalizedGlobalBinDir}/`)
    .replaceAll("%~dp0/", `${normalizedGlobalBinDir}/`);
}

function isOwnedBinShim(binPath, globalBinDir) {
  if (!existsSync(binPath)) {
    return false;
  }

  try {
    const content = readFileSync(binPath, "utf8");
    const expandedContent = expandPnpmShimPathText(content, globalBinDir);
    const localGlobalDir = normalizePathText(getLocalGlobalDir(globalBinDir));

    return expandedContent.includes(localGlobalDir);
  } catch {
    return false;
  }
}

export function getLocalGlobalDir(globalBinDir) {
  return join(globalBinDir, localGlobalDirName);
}

export function removeLocalInstallState(globalBinDir) {
  for (const binName of binNames) {
    for (const binSuffix of binSuffixes) {
      const binPath = join(globalBinDir, `${binName}${binSuffix}`);

      if (isOwnedBinShim(binPath, globalBinDir)) {
        unlinkSync(binPath);
      }
    }
  }

  rmSync(getLocalGlobalDir(globalBinDir), { force: true, recursive: true });
}
