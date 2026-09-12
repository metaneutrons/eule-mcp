import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        // Baseline for the existing provider-heavy codebase; ratchet upward
        // as coverage is added rather than making CI non-actionable.
        lines: 40,
        functions: 40,
        statements: 40,
        branches: 30,
      },
    },
  },
});
