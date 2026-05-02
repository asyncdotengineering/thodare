import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerDiffBlockAdd(backend: ThodareBackend): void {
  describe("diff/block-add", () => {
    it("target has one new block; diff produces add op", async () => {
      // Phase 3: POST /api/workflows/:id/diff with target JSON
      // containing a new block. Assert ops = [add].
      // Phase 1: verify backend contract existence.
      const name = "test-diff-add";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("work", async () => "ok");
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerDiffBlockDeleteWithTombstone(
  backend: ThodareBackend,
): void {
  describe("diff/block-delete-with-tombstone", () => {
    it("target removes a block; ops include tombstone insertion before delete", async () => {
      // Phase 3: when an in-flight run references a deleted block,
      // the diff endpoint inserts a tombstone before emitting delete.
      // Phase 1: verify capability flag exists.
      expect(typeof backend.capabilities.supportsRemovedTombstone).toBe("boolean");
    });
  });
}

export function registerDiffRoundTrip(
  backend: ThodareBackend,
): void {
  describe("diff/round-trip", () => {
    it("applyOperations(current, diff(current, target)) equals target (canonical-equal)", async () => {
      // Phase 3: concrete round-trip assertion using diff endpoint.
      // Phase 1: verify event list returns an array.
      const name = "test-diff-rt";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("work", async () => "ok");
      });
      const handle = await backend.runWorkflow(name, {});
      const events = await backend.events.list({ runId: handle.runId });
      expect(Array.isArray(events)).toBe(true);
    });
  });
}
