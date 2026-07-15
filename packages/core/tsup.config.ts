import { defineConfig } from "tsup";

const CJS_DATA_DIR_BANNER = [
  'globalThis.__WIKIGRAPH_DATA_DIR__ ??= require("path").resolve(',
  "  __dirname,",
  '  "../data",',
  ");",
].join("\n");
const ESM_DATA_DIR_BANNER = [
  'import { fileURLToPath } from "url";',
  'import { resolve } from "path";',
  'globalThis.__WIKIGRAPH_DATA_DIR__ ??= resolve(fileURLToPath(new URL("../data", import.meta.url)));',
].join("\n");
const SHARED_OPTIONS = {
  bundle: true,
  clean: false,
  outDir: "dist",
  platform: "node",
  skipNodeModulesBundle: true,
  sourcemap: true,
  splitting: false,
  target: "node22",
} as const;
const ENTRY = {
  gc: "src/gc.ts",
  index: "src/index.ts",
  worker: "src/worker.ts",
} as const;

export default defineConfig([
  {
    ...SHARED_OPTIONS,
    banner: {
      js: CJS_DATA_DIR_BANNER,
    },
    clean: true,
    dts: true,
    entry: ENTRY,
    format: ["cjs"],
    outExtension() {
      return {
        js: ".cjs",
      };
    },
  },
  {
    ...SHARED_OPTIONS,
    banner: {
      js: ESM_DATA_DIR_BANNER,
    },
    dts: true,
    entry: ENTRY,
    format: ["esm"],
  },
]);
