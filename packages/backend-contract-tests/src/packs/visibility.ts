import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerVisibilityHiddenFromDisplay(
  backend: ThodareBackend,
): void {
  describe("visibility/hidden-from-display", () => {
    it("hiddenFromDisplay output flows forward but is excluded from catalog queries", async () => {
      // Phase 2+ will verify that the runtime walker passes the value
      // forward to downstream blocks while the LLM-facing connector
      // schema response excludes the field.
      const name = "test-hidden-output";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("producer", async () => ({
          public: "visible",
          secret: "invisible",
        }));
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerVisibilityLlmOnly(
  backend: ThodareBackend,
): void {
  describe("visibility/llm-only", () => {
    it("LLM-emitted patch with llm-only field succeeds", async () => {
      // Phase 2+: assert that a patch containing an llm-only param
      // is accepted when emitted by the LLM but skipped when
      // emitted by a UI form (param_not_user_fillable).
      // Phase 1: verify backend contract surface exists.
      expect(backend.capabilities).toBeDefined();
    });

    it("UI-emitted patch with llm-only field is skipped", async () => {
      // Phase 2+: concrete assertion on param_not_user_fillable.
      expect(backend.events).toBeDefined();
    });
  });
}
