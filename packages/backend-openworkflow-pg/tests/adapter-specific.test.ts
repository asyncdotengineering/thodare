import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { BackendOpenworkflowPg } from "../src/adapter.js";

const PG_URL =
  process.env["WFKIT_DURABLE_PG_URL"] ??
  "postgresql://localhost:5432/wfkit_durable_test";

describe("adapter-specific: PG", () => {
  let adapter: BackendOpenworkflowPg;
  let schema: string;

  beforeAll(async () => {
    schema = `boa_spec_${Math.random().toString(36).slice(2, 10)}`;
    adapter = await BackendOpenworkflowPg.connect({
      pgUrl: PG_URL,
      schema,
    });
  });

  afterAll(async () => {
    try {
      await adapter.close();
    } catch {
      /* best-effort */
    }
    try {
      const pg = postgres(PG_URL, { max: 1 });
      await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pg.end({ timeout: 5 });
    } catch {
      /* best-effort */
    }
  });

  it("adapter exposes expected id and capabilities", () => {
    expect(adapter.id).toBe("openworkflow-pg");
    expect(adapter.capabilities.exactlyOnceSteps).toBe(true);
    expect(adapter.capabilities.serverless).toBe(false);
    expect(adapter.capabilities.supportsLiveSubscription).toBe(false);
    expect(adapter.capabilities.supportsResumeFromStep).toBe(false);
    expect(adapter.capabilities.supportsRecover).toBe(false);
    expect(adapter.capabilities.supportsContainerBlocks).toBe(false);
    expect(adapter.mode).toBe("embedded");
    expect(adapter.specVersion).toBeGreaterThanOrEqual(1);
  });

  it("defineWorkflow then runWorkflow creates a run with a valid runId", async () => {
    await adapter.defineWorkflow(
      { name: "spec-test" },
      async (ctx) => {
        return await ctx.step.run("work", async () => "done");
      },
    );
    const handle = await adapter.runWorkflow("spec-test", { x: 1 });
    expect(typeof handle.runId).toBe("string");
    expect(handle.runId.length).toBeGreaterThan(0);
  });

  it("runWorkflow writes a run_started event immediately", async () => {
    await adapter.defineWorkflow(
      { name: "spec-events" },
      async (ctx) => {
        return await ctx.step.run("work", async () => "ok");
      },
    );
    const handle = await adapter.runWorkflow("spec-events", {});
    const events = await adapter.events.list({ runId: handle.runId });
    const started = events.find((e) => e.type === "run_started");
    expect(started).toBeDefined();
    if (started) {
      expect(started.payload).toBeDefined();
      expect((started.payload as Record<string, unknown>)["runId"]).toBe(
        handle.runId,
      );
    }
  });

  it("events.create and events.get roundtrip", async () => {
    const result = await adapter.events.create({
      type: "run_started",
      runId: "spec-test-run",
      payload: {
        type: "run_started",
        runId: "spec-test-run",
        workflowName: "spec",
        input: undefined,
        startedAt: new Date().toISOString(),
      },
      correlationId: "corr-1",
      organizationId: "org-1",
    });
    expect(result.event.id).toBeDefined();
    expect(result.event.correlationId).toBe("corr-1");
    expect(result.event.organizationId).toBe("org-1");

    const got = await adapter.events.get(result.event.id);
    expect(got).toBeDefined();
    if (got) {
      expect(got.type).toBe("run_started");
      expect(got.correlationId).toBe("corr-1");
    }
  });

  it("events.listByCorrelationId filters correctly", async () => {
    const corrId = `corr-spec-${Date.now()}`;
    await adapter.events.create({
      type: "run_started",
      runId: "spec-r1",
      payload: {
        type: "run_started",
        runId: "spec-r1",
        workflowName: "x",
        input: undefined,
        startedAt: new Date().toISOString(),
      },
      correlationId: corrId,
    });
    const events = await adapter.events.listByCorrelationId(corrId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(e.correlationId).toBe(corrId);
    }
  });

  it("resumeFromStep throws not_implemented", async () => {
    await expect(
      adapter.resumeFromStep("fake-run" as never, "fake-step" as never),
    ).rejects.toThrow("not_implemented");
  });

  it("recover throws not_implemented", async () => {
    await expect(
      adapter.recover("fake-run" as never),
    ).rejects.toThrow("not_implemented");
  });
});
