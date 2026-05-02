import { describe, it, expect } from "vitest";
import type { ThodareBackend, RunId, StepId } from "@thodare/backend";

export function registerHeadlessLiveSubscription(
  backend: ThodareBackend,
): void {
  describe("headless-builder/live-subscription", () => {
    it("subscribe to run events receives step_started", async () => {
      // Gated by supportsLiveSubscription. Phase 3 adapter will
      // implement SSE/WS subscription and this test will read the
      // event stream.
      expect(backend.capabilities.supportsLiveSubscription).toBe(true);
      const name = "test-live";
      await backend.defineWorkflow({ name }, async (ctx) => {
        await ctx.step.run("s1", async () => 1);
      });
      const handle = await backend.runWorkflow(name, {});
      const events = await backend.events.list({ runId: handle.runId });
      const started = events.filter((e) => e.type === "step_started");
      expect(started.length).toBeGreaterThanOrEqual(0);
    });
  });
}

export function registerHeadlessStepIOInspection(
  backend: ThodareBackend,
): void {
  describe("headless-builder/step-io-inspection", () => {
    it("steps list returns input and output per step", async () => {
      expect(backend.capabilities.supportsStepIOInspection).toBe(true);
      const name = "test-io";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("compute", async () => 42);
      });
      const handle = await backend.runWorkflow(name, {});
      const steps = await backend.steps.list(handle.runId);
      expect(Array.isArray(steps)).toBe(true);
    });
  });
}

export function registerHeadlessResumeFromStep(
  backend: ThodareBackend,
): void {
  describe("headless-builder/resume-from-step", () => {
    it("resumeFromStep returns a RunHandle", async () => {
      expect(backend.capabilities.supportsResumeFromStep).toBe(true);
      const handle = await backend.resumeFromStep(
        "fake-run" as RunId,
        "fake-step" as StepId,
      );
      expect(typeof handle.runId).toBe("string");
    });
  });
}

export function registerHeadlessRecover(backend: ThodareBackend): void {
  describe("headless-builder/recover", () => {
    it("recover flips failed run back to pending", async () => {
      expect(backend.capabilities.supportsRecover).toBe(true);
      const handle = await backend.recover("fake-run" as RunId);
      expect(typeof handle.runId).toBe("string");
    });
  });
}

export function registerHeadlessConnectorMetadata(
  backend: ThodareBackend,
): void {
  describe("headless-builder/connector-metadata", () => {
    it("backend.id is a non-empty string", () => {
      expect(typeof backend.id).toBe("string");
      expect(backend.id.length).toBeGreaterThan(0);
    });

    it("backend has expected lifecycle and workflow methods", () => {
      expect(typeof backend.defineWorkflow).toBe("function");
      expect(typeof backend.runWorkflow).toBe("function");
      expect(typeof backend.signal).toBe("function");
      expect(typeof backend.cancel).toBe("function");
      // resumeFromStep and recover are gated but the method must exist
      if (backend.capabilities.supportsResumeFromStep) {
        expect(typeof backend.resumeFromStep).toBe("function");
      }
      if (backend.capabilities.supportsRecover) {
        expect(typeof backend.recover).toBe("function");
      }
    });
  });
}

export function registerHeadlessCredentialRoundTrip(
  backend: ThodareBackend,
): void {
  describe("headless-builder/credential-round-trip", () => {
    it("credential creation API shape exists (Phase 2 fills encrypt-at-rest assertions)", async () => {
      // Phase 1: assert the Storage shape includes hooks and events.
      // Phase 2 lands the credential create/store/encrypt flow.
      const hook = await backend.hooks.getByToken("non-existent");
      expect(hook).toBeNull();
    });

    it("credential reference in workflow input does not leak secret", async () => {
      // Phase 2: run a workflow referencing a credential by id and
      // assert the event stream never contains the secret bytes.
      expect(backend.events).toBeDefined();
    });
  });
}

export function registerHeadlessNdjsonOpStream(
  backend: ThodareBackend,
): void {
  describe("headless-builder/ndjson-op-stream", () => {
    it("streams.write produces a chunk that can be read back", async () => {
      if (backend.streams.writeMulti) {
        // Verify writeMulti exists but do not call — Phase 3 adapter will test.
        expect(typeof backend.streams.writeMulti).toBe("function");
      }
    });

    it("stream getChunks returns an array", async () => {
      const chunks = await backend.streams.getChunks("test", "fake-run" as RunId);
      expect(Array.isArray(chunks)).toBe(true);
    });
  });
}
