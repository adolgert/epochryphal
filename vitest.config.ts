import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Level 4 (test/live) is always collected, so its tests show as skipped; they run only when
    // HARNESS_LIVE_MODEL names a model (describe.skipIf in each file).
    include: ["test/unit/**/*.test.ts", "test/sdk/**/*.test.ts", "test/cli/**/*.test.ts", "test/live/**/*.test.ts"],
    testTimeout: 20_000,
    // Each test file runs in its own process: SDK tests change process.env.
    pool: "forks",
  },
});
