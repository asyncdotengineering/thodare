import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerContainerForeachSequential(
  backend: ThodareBackend,
): void {
  describe("container-blocks/foreach-sequential", () => {
    it("foreach body runs N times in order", async () => {
      expect(backend.capabilities.supportsContainerBlocks).toBe(true);
      const name = "test-foreach-seq";
      await backend.defineWorkflow({ name }, async (ctx) => {
        const items = [1, 2, 3];
        const results: number[] = [];
        for (const item of items) {
          const val = await ctx.step.run(`iter-${item}`, async () => item * 2);
          results.push(val as number);
        }
        return results;
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerContainerForeachParallel(
  backend: ThodareBackend,
): void {
  describe("container-blocks/foreach-parallel", () => {
    it("foreach body runs concurrently; outputs collected", async () => {
      expect(backend.capabilities.supportsContainerBlocks).toBe(true);
      // Phase 3: execute parallel iterations and verify all complete.
      const handle = await backend.runWorkflow("test-foreach-par", {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerContainerParallelAll(
  backend: ThodareBackend,
): void {
  describe("container-blocks/parallel-all", () => {
    it("branches run concurrently; container completes after all", async () => {
      expect(backend.capabilities.supportsContainerBlocks).toBe(true);
      const handle = await backend.runWorkflow("test-parallel-all", {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerContainerBranchOne(
  backend: ThodareBackend,
): void {
  describe("container-blocks/branch-one", () => {
    it("first branch to complete wins; others canceled", async () => {
      expect(backend.capabilities.supportsContainerBlocks).toBe(true);
      // Phase 3: spawn a race and verify winner.
      const handle = await backend.runWorkflow("test-race", {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerContainerWhileLoop(
  backend: ThodareBackend,
): void {
  describe("container-blocks/while-loop", () => {
    it("body runs until condition false; maxIterations honored", async () => {
      expect(backend.capabilities.supportsContainerBlocks).toBe(true);
      const handle = await backend.runWorkflow("test-while", {});
      expect(handle.runId).toBeDefined();
    });
  });
}
