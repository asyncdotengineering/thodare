import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerSyncBlockResult(
  backend: ThodareBackend,
): void {
  describe("sync-block-result/first-block-result", () => {
    it("awaitFirstBlockResult returns block output before run continues", async () => {
      expect(backend.capabilities.supportsAwaitFirstBlockResult).toBe(true);
      const name = "test-sync-result";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("page-1", async () => "<html>hello</html>");
      });
      const handle = await backend.runWorkflow(name, {}, {
        awaitFirstBlockResult: { blockId: "page-1", timeoutMs: 5000 },
      });
      expect(handle.runId).toBeDefined();
      // Phase 3: assert handle.firstBlockResult matches block output.
    });
  });
}

export function registerSyncBlockTimeout(
  backend: ThodareBackend,
): void {
  describe("sync-block-result/first-block-timeout", () => {
    it("block exceeds timeoutMs; run continues asynchronously", async () => {
      expect(backend.capabilities.supportsAwaitFirstBlockResult).toBe(true);
      // Phase 3: assert that a slow block exceeding timeoutMs causes
      // runWorkflow to throw or return without firstBlockResult,
      // while the run continues asynchronously.
      const handle = await backend.runWorkflow("test-sync-timeout", {}, {
        awaitFirstBlockResult: { blockId: "slow-block", timeoutMs: 1 },
      });
      expect(handle.runId).toBeDefined();
    });
  });
}
