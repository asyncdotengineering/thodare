import { describe, it, expect, beforeAll } from "vitest";
import { D1Storage } from "../src/d1-storage.js";
import { CAPABILITIES } from "../src/capabilities.js";
import type { CFEnv } from "../src/types.js";
import { ddlStatements } from "./apply-migrations.js";
import { SPEC_VERSION_CURRENT } from "@thodare/backend";

const ORG_A = "test-org-a";
const ORG_B = "test-org-b";

async function getEnv(): Promise<CFEnv> {
  const mod = await import("cloudflare:test");
  return (mod as unknown as { env: Record<string, unknown> }).env as unknown as CFEnv;
}

describe("D1Storage: CRUD", () => {
  let env: CFEnv;
  let storage: D1Storage;

  beforeAll(async () => {
    env = await getEnv();
    for (const stmt of ddlStatements()) {
      await env.THODARE_DB.prepare(stmt).run();
    }
    storage = new D1Storage(env.THODARE_DB, ORG_A);
  });

  it("events.create and events.get roundtrip", async () => {
    const result = await storage.events.create({
      type: "run_started",
      runId: "cf-test-run",
      payload: {
        type: "run_started",
        runId: "cf-test-run",
        workflowName: "cf-spec-events",
        input: undefined,
        startedAt: new Date().toISOString(),
      },
      correlationId: "corr-cf-1",
      organizationId: ORG_A,
    });
    expect(result.event.id).toBeDefined();
    expect(result.event.correlationId).toBe("corr-cf-1");

    const got = await storage.events.get(result.event.id);
    expect(got).not.toBeNull();
    if (got) {
      expect(got.type).toBe("run_started");
      expect(got.correlationId).toBe("corr-cf-1");
    }
  });

  it("events.list filters by runId", async () => {
    const runId = "cf-test-run-list";
    await storage.events.create({
      type: "run_started",
      runId,
      payload: {
        type: "run_started",
        runId,
        workflowName: "cf-spec-list",
        input: undefined,
        startedAt: new Date().toISOString(),
      },
    });

    const events = await storage.events.list({ runId });
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(e.runId).toBe(runId);
    }
  });

  it("runs.insertRun and runs.get roundtrip with spec_version + idempotency_key", async () => {
    const runId = "cf-run-direct";
    await storage.insertRun({
      id: runId,
      workflowName: "cf-spec-run",
      organizationId: ORG_A,
      specVersion: SPEC_VERSION_CURRENT,
      idempotencyKey: null,
      input: { x: 1 },
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = await storage.runs.get(runId as never);
    expect(run).not.toBeNull();
    if (run) {
      expect(run.workflowName).toBe("cf-spec-run");
      expect(run.organizationId).toBe(ORG_A);
      expect(run.status).toBe("running");
    }
  });

  it("findRunByIdempotencyKey returns existing run", async () => {
    const runId = "cf-run-idem";
    const key = `idem-${Date.now()}`;
    await storage.insertRun({
      id: runId,
      workflowName: "cf-idem-wf",
      organizationId: ORG_A,
      specVersion: SPEC_VERSION_CURRENT,
      idempotencyKey: key,
      input: { y: 2 },
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const found = await storage.findRunByIdempotencyKey("cf-idem-wf", key);
    expect(found?.id).toBe(runId);

    const notFound = await storage.findRunByIdempotencyKey(
      "cf-idem-wf",
      "different-key",
    );
    expect(notFound).toBeNull();
  });

  it("runs.updateRunStatus transitions to completed", async () => {
    const runId = "cf-run-update";
    await storage.insertRun({
      id: runId,
      workflowName: "cf-spec-run-update",
      organizationId: ORG_A,
      specVersion: SPEC_VERSION_CURRENT,
      idempotencyKey: null,
      input: { y: 2 },
      status: "running",
      startedAt: new Date().toISOString(),
    });

    await storage.updateRunStatus(runId, "completed", {
      output: { result: 42 },
      completedAt: new Date().toISOString(),
    });

    const run = await storage.runs.get(runId as never);
    expect(run?.status).toBe("completed");
    expect(run?.output).toEqual({ result: 42 });
    expect(run?.completedAt).toBeDefined();
  });

  it("DDL is idempotent (run twice)", async () => {
    for (const stmt of ddlStatements()) {
      await env.THODARE_DB.prepare(stmt).run();
    }
    const result = await storage.events.create({
      type: "run_completed",
      runId: "cf-idempotent-check",
      payload: {
        type: "run_completed",
        runId: "cf-idempotent-check",
        output: "ok",
        completedAt: new Date().toISOString(),
      },
    });
    expect(result.event.id).toBeDefined();
  });
});

describe("T11 multi-tenant isolation: events / runs / steps / hooks", () => {
  let env: CFEnv;
  let storageA: D1Storage;
  let storageB: D1Storage;

  beforeAll(async () => {
    env = await getEnv();
    for (const stmt of ddlStatements()) {
      await env.THODARE_DB.prepare(stmt).run();
    }
    storageA = new D1Storage(env.THODARE_DB, ORG_A);
    storageB = new D1Storage(env.THODARE_DB, ORG_B);
  });

  it("events: org A cannot see org B's events", async () => {
    await storageA.events.create({
      type: "run_started",
      runId: "iso-events-A",
      payload: {
        type: "run_started",
        runId: "iso-events-A",
        workflowName: "iso",
        input: undefined,
        startedAt: new Date().toISOString(),
      },
      organizationId: ORG_A,
    });

    const eventsB = await storageB.events.list({});
    for (const e of eventsB) {
      expect(e.organizationId).not.toBe(ORG_A);
    }
  });

  it("runs: org A cannot see org B's runs", async () => {
    await storageA.insertRun({
      id: "iso-run-A",
      workflowName: "iso-wf",
      organizationId: ORG_A,
      specVersion: SPEC_VERSION_CURRENT,
      idempotencyKey: null,
      input: {},
      status: "running",
      startedAt: new Date().toISOString(),
    });

    expect(await storageA.runs.get("iso-run-A" as never)).not.toBeNull();
    // Cross-org read returns null even though the row exists.
    expect(await storageB.runs.get("iso-run-A" as never)).toBeNull();
  });

  it("steps: org A cannot see org B's steps via either get or list", async () => {
    const stepId = "iso-step-A";
    const runId = "iso-step-run";
    // Direct insert of a step row owned by org A.
    await env.THODARE_DB
      .prepare(
        `INSERT INTO steps (id, run_id, organization_id, name, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(stepId, runId, ORG_A, "iso-step", "running", new Date().toISOString())
      .run();

    // Org A sees it via both methods.
    expect(await storageA.steps.get(stepId as never)).not.toBeNull();
    const aList = await storageA.steps.list(runId as never);
    expect(aList.length).toBe(1);

    // Org B cannot see it via either method.
    expect(await storageB.steps.get(stepId as never)).toBeNull();
    const bList = await storageB.steps.list(runId as never);
    expect(bList.length).toBe(0);
  });

  it("hooks: stub returns empty regardless of org", async () => {
    // Hooks are stubbed to null/[] in v1 alpha. Verify both orgs return empty
    // — confirms no leakage path exists today even though the column is present.
    expect(await storageA.hooks.get("any" as never)).toBeNull();
    expect(await storageA.hooks.list({})).toEqual([]);
    expect(await storageB.hooks.get("any" as never)).toBeNull();
    expect(await storageB.hooks.list({})).toEqual([]);
  });
});

describe("capability honesty: backed by code", () => {
  it("declares supportsStepIOInspection: false because no code writes step rows", () => {
    expect(CAPABILITIES.supportsStepIOInspection).toBe(false);
  });
});
