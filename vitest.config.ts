import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    // All test files share one Postgres database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: { POSTGRES_DB: "ops_test", NODE_ENV: "test" },
  },
});
