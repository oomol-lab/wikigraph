import { defineConfig } from "tsup";

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

export default defineConfig([
  {
    ...SHARED_OPTIONS,
    clean: true,
    dts: true,
    entry: {
      index: "src/index.ts",
    },
    format: ["cjs"],
    outExtension() {
      return {
        js: ".cjs",
      };
    },
  },
  {
    ...SHARED_OPTIONS,
    dts: true,
    entry: {
      cli: "src/cli.ts",
      index: "src/index.ts",
      "queue-worker": "src/queue-worker.ts",
    },
    format: ["esm"],
  },
]);
