import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        isolatedStorage: false,
      },
    },
  },
});
