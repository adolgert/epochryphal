import { defineConfig } from "vitest/config";

// Level 4 (test/live) runs only when HARNESS_LIVE_MODEL names a model.
const live = process.env.HARNESS_LIVE_MODEL ? ["test/live/**/*.test.ts"] : [];

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/sdk/**/*.test.ts", "test/cli/**/*.test.ts", ...live],
    testTimeout: 20_000,
    // Each test file runs in its own process: SDK tests change process.env.
    pool: "forks",
  },
});
