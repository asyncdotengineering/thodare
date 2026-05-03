import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendOpenworkflowSqlite } from "../src/adapter.js";

describe("adapter-specific: SQLite", () => {
  let adapter: BackendOpenworkflowSqlite;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "boa-sqlite-spec-"));
    adapter = BackendOpenworkflowSqlite.connect({
      path: join(dir, "thodare.db"),
    });
    await adapter.defineWorkflow(
      { name: "step-io-sqlite" },
      async (ctx) => {
        return await ctx.step.run("compute", async () => 99);
      },
    );
    await adapter.start();
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

  it("steps.list returns output for completed steps after worker execution", async () => {
    const handle = await adapter.runWorkflow("step-io-sqlite", {});

    let run: { status: string } | null = null;
    for (let i = 0; i < 50; i++) {
      run = await adapter.runs.get(handle.runId);
      if (run?.status === "completed" || run?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(run?.status).toBe("completed");

    const steps = await adapter.steps.list(handle.runId);
    const computeStep = steps.find((s) => s.name === "compute");
    expect(computeStep).toBeDefined();
    expect(computeStep?.status).toBe("completed");
    expect(computeStep?.output).toBe(99);
  });

  it("cross-namespace isolation: adapter B cannot see adapter A data", async () => {
    const dbPath = join(dir, "thodare.db");
    const adapterA = BackendOpenworkflowSqlite.connect({
      path: dbPath,
      namespaceId: "ns-a",
    });
    await adapterA.defineWorkflow(
      { name: "iso-sqlite" },
      async (ctx) => {
        return await ctx.step.run("work", async () => "from-a");
      },
    );
    await adapterA.start();

    const adapterB = BackendOpenworkflowSqlite.connect({
      path: dbPath,
      namespaceId: "ns-b",
    });
    await adapterB.start();

    try {
      const handleA = await adapterA.runWorkflow("iso-sqlite", {});

      let aRun: { status: string } | null = null;
      for (let i = 0; i < 50; i++) {
        aRun = await adapterA.runs.get(handleA.runId);
        if (aRun?.status === "completed" || aRun?.status === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(aRun?.status).toBe("completed");

      const runFromB = await adapterB.runs.get(handleA.runId);
      expect(runFromB).toBeNull();

      const eventsFromB = await adapterB.events.list({ runId: handleA.runId });
      expect(eventsFromB).toEqual([]);

      const stepsFromB = await adapterB.steps.list(handleA.runId);
      expect(stepsFromB).toEqual([]);
    } finally {
      await adapterA.close();
      await adapterB.close();
    }
  });
});
