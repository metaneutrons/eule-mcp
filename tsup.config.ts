import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "server/index": "src/server/index.ts",
  },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false, // Disabled: tsup DTS generator incompatible with TypeScript 6.x
  splitting: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
