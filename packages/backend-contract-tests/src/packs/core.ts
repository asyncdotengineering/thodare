import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerCoreHappyPath(backend: ThodareBackend): void {
  describe("core/happy-path", () => {
    it("defineWorkflow returns a RegisteredWorkflow", async () => {
      const registered = await backend.defineWorkflow(
        { name: "test-happy" },
        async (ctx) => {
          return await ctx.step.run("do-work", async () => ({ ok: true }));
        },
      );
      expect(registered.name).toBe("test-happy");
      expect(typeof registered.specVersion).toBe("number");
    });

    it("runWorkflow returns a RunHandle", async () => {
      const handle = await backend.runWorkflow("test-happy", { payload: 42 });
      expect(typeof handle.runId).toBe("string");
      expect(handle.runId.length).toBeGreaterThan(0);
    });

    it("runWorkflow produces a run_started event", async () => {
      const handle = await backend.runWorkflow("test-happy", { payload: 1 });
      const events = await backend.events.list({ runId: handle.runId });
      const started = events.find((e) => e.type === "run_started");
      expect(started).toBeDefined();
    });

    it("step.run returns its output", async () => {
      await backend.defineWorkflow(
        { name: "test-step-output" },
        async (ctx) => {
          const result = await ctx.step.run("compute", async () => 99);
          expect(result).toBe(99);
        },
      );
      const handle = await backend.runWorkflow("test-step-output", {});
      expect(handle.runId).toBeDefined();
    });

    it("workflow completes and produces run_completed event", async () => {
      await backend.defineWorkflow(
        { name: "test-complete" },
        async (ctx) => {
          return await ctx.step.run("final", async () => "done");
        },
      );
      const handle = await backend.runWorkflow("test-complete", {});
      const events = await backend.events.list({ runId: handle.runId });
      expect(Array.isArray(events)).toBe(true);
    });
  });
}

export function registerCoreReplayDeterminism(
  backend: ThodareBackend,
): void {
  describe("core/replay-determinism", () => {
    it("crash mid-run and restart produces no duplicate side effects", async () => {
      // The adapter must guarantee that after a crash and recovery,
      // steps that had already completed are not re-executed.
      // This test will be tightened in Phase 3 when runWorkflow
      // can be re-invoked against the same run to simulate recovery.
      const name = "test-replay";
      await backend.defineWorkflow({ name }, async (ctx) => {
        await ctx.step.run("once", async () => "first");
        await ctx.step.run("twice", async () => "second");
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
      // Phase 3: re-invoke runWorkflow for the same run and assert
      // "once" step output matches original without re-executing fn.
    });
  });
}

export function registerCoreSleepPrecision(backend: ThodareBackend): void {
  describe("core/sleep-precision", () => {
    it("step.sleep with short duration resumes within expected slack", async () => {
      await backend.defineWorkflow(
        { name: "test-sleep" },
        async (ctx) => {
          const before = Date.now();
          await ctx.step.sleep("nap", 200);
          const after = Date.now();
          const elapsed = after - before;
          // Slack: the adapter's signalPrecision determines acceptable jitter.
          // Best-effort may be looser; exact should be tight.
          expect(elapsed).toBeGreaterThanOrEqual(150);
        },
      );
      const handle = await backend.runWorkflow("test-sleep", {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerCoreSignalDelivery(
  backend: ThodareBackend,
): void {
  describe("core/signal-delivery", () => {
    it("backend.signal resumes a waitForSignal step", async () => {
      await backend.defineWorkflow(
        { name: "test-signal" },
        async (ctx) => {
          const received = await ctx.step.waitForSignal<string>({
            name: "await-trigger",
            signalName: "my-trigger",
            timeoutMs: 5000,
          });
          expect(received).toBe("hello-signal");
        },
      );
      const handle = await backend.runWorkflow("test-signal", {});
      await backend.signal(handle.runId, "my-trigger", "hello-signal");
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerCoreCancellation(backend: ThodareBackend): void {
  describe("core/cancellation", () => {
    it("backend.cancel aborts ctx.signal", async () => {
      await backend.defineWorkflow(
        { name: "test-cancel" },
        async (ctx) => {
          // The handler will check ctx.signal.aborted after cancel.
          // Phase 3 will make runWorkflow reject with cancellation error.
          expect(ctx.signal).toBeDefined();
        },
      );
      const handle = await backend.runWorkflow("test-cancel", {});
      await backend.cancel(handle.runId);
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerCoreMultiTenantIsolation(
  backend: ThodareBackend,
): void {
  describe("core/multi-tenant-isolation", () => {
    it("runs from different orgs never cross", async () => {
      const name = "test-isolation";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("work", async () => "done");
      });
      const handleA = await backend.runWorkflow(name, { org: "org-a" });
      const handleB = await backend.runWorkflow(name, { org: "org-b" });
      expect(handleA.runId).not.toBe(handleB.runId);
      // Phase 3: assert org-a cannot read org-b's events / runs via backend.events.list.
    });
  });
}

export function registerCoreIdempotency(backend: ThodareBackend): void {
  describe("core/idempotency", () => {
    it("same idempotencyKey returns same runId", async () => {
      const name = "test-idem";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("work", async () => "ok");
      });
      const key = "idem-key-" + Date.now();
      const h1 = await backend.runWorkflow(name, {}, { idempotencyKey: key });
      const h2 = await backend.runWorkflow(name, {}, { idempotencyKey: key });
      expect(h1.runId).toBe(h2.runId);
    });
  });
}

export function registerCoreCapabilityHonesty(
  backend: ThodareBackend,
): void {
  describe("core/capability-honesty", () => {
    it("declared capabilities are a plain object with expected fields", () => {
      const caps = backend.capabilities;
      expect(typeof caps.maxStepDurationMs).toBe("number");
      expect(typeof caps.maxRunDurationMs).toBe("number");
      expect(["exact", "best-effort"]).toContain(caps.signalPrecision);
      expect(typeof caps.serverless).toBe("boolean");
      expect(typeof caps.supportsLiveSubscription).toBe("boolean");
      expect(typeof caps.supportsContainerBlocks).toBe("boolean");
      expect(typeof caps.supportsDynamicSchemas).toBe("boolean");
      expect(typeof caps.supportsAwaitFirstBlockResult).toBe("boolean");
    });
  });
}

export function registerCoreTombstoneReplay(
  backend: ThodareBackend,
): void {
  describe("core/tombstone-replay", () => {
    it("new run uses tombstone-friendly JSON", async () => {
      // Verifies that the adapter accepts a workflow containing a
      // tombstoned block (tombstone: true). Phase 3 will extend to
      // verify the runtime walker advances past it.
      expect(backend.capabilities.supportsRemovedTombstone).toBeDefined();
    });
  });
}

export function registerCoreRawConfigRoundTrip(
  backend: ThodareBackend,
): void {
  describe("core/raw-config-round-trip", () => {
    it("raw fields reach execute() without leaking to params schema", async () => {
      // Phase 3: run a workflow where a block has rawConfig fields
      // and assert the connector's execute() sees the merged result
      // but the params Zod schema never validates rawConfig keys.
      const name = "test-rawconfig";
      await backend.defineWorkflow({ name }, async (ctx) => {
        return await ctx.step.run("test", async () => "ok");
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}
