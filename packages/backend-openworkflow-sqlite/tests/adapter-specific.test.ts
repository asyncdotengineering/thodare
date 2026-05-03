import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendOpenworkflowSqlite } from "../src/adapter.js";

describe("adapter-specific: SQLite", () => {
  let adapter: BackendOpenworkflowSqlite;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "boa-sqlite-spec-"));
    adapter = BackendOpenworkflowSqlite.connect({
      path: join(dir, "thodare.db"),
    });
  });

  afterAll(async () => {
    try {
      await adapter.close();
    } catch {
      /* best-effort */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("adapter exposes expected id and capabilities", () => {
    expect(adapter.id).toBe("openworkflow-sqlite");
    expect(adapter.capabilities.exactlyOnceSteps).toBe(true);
    expect(adapter.capabilities.serverless).toBe(false);
    expect(adapter.capabilities.supportsLiveSubscription).toBe(false);
    expect(adapter.capabilities.supportsResumeFromStep).toBe(false);
    expect(adapter.mode).toBe("embedded");
    expect(adapter.specVersion).toBeGreaterThanOrEqual(1);
  });

  it("defineWorkflow then runWorkflow creates a run", async () => {
    await adapter.defineWorkflow(
      { name: "sqlite-spec" },
      async (ctx) => {
        return await ctx.step.run("work", async () => "done");
      },
    );
    const handle = await adapter.runWorkflow("sqlite-spec", {});
    expect(typeof handle.runId).toBe("string");
    expect(handle.runId.length).toBeGreaterThan(0);
  });

  it("runWorkflow writes a run_started event immediately", async () => {
    await adapter.defineWorkflow(
      { name: "sqlite-events" },
      async (ctx) => {
        return await ctx.step.run("work", async () => "ok");
      },
    );
    const handle = await adapter.runWorkflow("sqlite-events", {});
    const events = await adapter.events.list({ runId: handle.runId });
    const started = events.find((e) => e.type === "run_started");
    expect(started).toBeDefined();
  });

  it("events.create and events.get roundtrip", async () => {
    const result = await adapter.events.create({
      type: "run_started",
      runId: "sqlite-test-run",
      payload: {
        type: "run_started",
        runId: "sqlite-test-run",
        workflowName: "spec",
        input: undefined,
        startedAt: new Date().toISOString(),
      },
      correlationId: "corr-sqlite",
    });
    expect(result.event.id).toBeDefined();

    const got = await adapter.events.get(result.event.id);
    expect(got).toBeDefined();
    if (got) {
      expect(got.type).toBe("run_started");
      expect(got.correlationId).toBe("corr-sqlite");
    }
  });

  it("events.listByCorrelationId filters correctly", async () => {
    const corrId = `corr-sqlite-${Date.now()}`;
    await adapter.events.create({
      type: "run_completed",
      runId: "sqlite-r2",
      payload: {
        type: "run_completed",
        runId: "sqlite-r2",
        output: "ok",
        completedAt: new Date().toISOString(),
      },
      correlationId: corrId,
    });
    const events = await adapter.events.listByCorrelationId(corrId);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("resumeFromStep throws not_implemented", async () => {
    await expect(
      adapter.resumeFromStep("fake-run" as never, "fake-step" as never),
    ).rejects.toThrow("not_implemented");
  });
});
