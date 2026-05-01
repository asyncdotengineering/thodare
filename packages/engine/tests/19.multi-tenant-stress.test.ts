/**
 * Multi-tenant stress.
 *
 *   1. 100 parallel runs of THE SAME workflow with unique tenant inputs and
 *      random 1-5s wait_durations. Verify correctness, no cross-talk, perf
 *      bound.
 *   2. 100 OFF-TIMED runs — workflows started over a 4s window with mixed
 *      wait durations. The scheduler sees real arrival churn, not a perfect
 *      thundering herd.
 *   3. Hard multi-tenancy with 5 distinct namespaceIds (each its own
 *      BackendPostgres + OpenWorkflow) — verifies tenant isolation at the
 *      DB row level.
 */

import { describe, it, expect, afterEach } from "vitest";
import { OpenWorkflow } from "@thodare/openworkflow";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { randomUUID } from "node:crypto";
import {
  BlockRegistry,
  ToolRegistry,
  buildDurableWorkflow,
  registerBuiltinBlocks,
  registerBuiltinTools,
  registerWaitTools,
  type SerializedWorkflow,
} from "../src/index.js";

const PG_URL = process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test";

interface PgInst {
  ow: OpenWorkflow;
  backend: BackendPostgres;
  schema: string;
  worker: { start(): Promise<void>; stop(): Promise<void> } | null;
  dispose: () => Promise<void>;
}

async function newPgInst(opts: { namespaceId?: string } = {}): Promise<PgInst> {
  const schema = `wfkit_t_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const backend = await BackendPostgres.connect(PG_URL, {
    schema,
    ...(opts.namespaceId ? { namespaceId: opts.namespaceId } : {}),
  });
  const ow = new OpenWorkflow({ backend });
  const inst: PgInst = {
    ow,
    backend,
    schema,
    worker: null,
    dispose: async () => {
      try { if (inst.worker) await inst.worker.stop(); } catch {}
      try { await backend.stop(); } catch {}
      try {
        const postgres = (await import("postgres")).default;
        const sql = postgres(PG_URL, { max: 1 });
        try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await sql.end({ timeout: 5 }); }
      } catch {}
    },
  };
  return inst;
}

function freshRegistries() {
  const tools = new ToolRegistry();
  const blocks = new BlockRegistry();
  registerBuiltinTools(tools);
  registerWaitTools(tools);
  registerBuiltinBlocks(blocks);
  return { tools, blocks };
}

/** Workflow shape: trg → stamp(tenantId) → wait → stamp(2) → done(carries tenantId through). */
function buildTenantWf(name: string, waitSec: number): SerializedWorkflow {
  return {
    version: "1.0.0",
    metadata: { name },
    blocks: [
      { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
      {
        id: "step1",
        type: "transform",
        enabled: true,
        params: { template: { tenantId: "{{trigger.tenantId}}", phase: "step1" } },
      },
      {
        id: "wait",
        type: "wait_duration",
        enabled: true,
        params: { duration: waitSec, unit: "seconds" },
      },
      {
        id: "step2",
        type: "transform",
        enabled: true,
        params: { template: { tenantId: "{{trigger.tenantId}}", phase: "step2" } },
      },
      {
        id: "done",
        type: "transform",
        enabled: true,
        params: {
          template: {
            tenantId: "{{trigger.tenantId}}",
            // tracksThrough confirms ALL three phases (trigger, step1, step2)
            // saw the same tenantId — no cross-talk between concurrent runs.
            seenInTrigger: "{{trigger.tenantId}}",
            seenInStep1: "{{step1.result.tenantId}}",
            seenInStep2: "{{step2.result.tenantId}}",
          },
        },
      },
    ],
    connections: [
      { source: "trg", target: "step1" },
      { source: "step1", target: "wait" },
      { source: "wait", target: "step2" },
      { source: "step2", target: "done" },
    ],
  };
}

describe("multi-tenant stress on Postgres", () => {
  let inst: PgInst;
  afterEach(async () => { await inst.dispose(); });

  it("100 parallel workflows complete with no cross-tenant data leakage", async () => {
    inst = await newPgInst();
    const { tools, blocks } = freshRegistries();

    const N = 100;
    // One workflow definition, but each run gets a unique tenantId via input.
    // Random 1-5s waits so they don't all wake up at the exact same instant.
    const waitMatrix: number[] = [];
    const tenantIds: string[] = [];
    const compiled: ReturnType<typeof buildDurableWorkflow>[] = [];

    // We register N distinct workflow names so step keys don't collide
    // across tenants on a single openworkflow registry. Each has the same
    // shape but a different name (a real product might do this once per
    // tenant template).
    for (let i = 0; i < N; i++) {
      const waitSec = 1 + Math.floor(Math.random() * 5);
      waitMatrix.push(waitSec);
      const tenantId = `tenant-${i.toString().padStart(3, "0")}`;
      tenantIds.push(tenantId);
      const wf = buildTenantWf(`stress-${i}`, waitSec);
      compiled.push(
        buildDurableWorkflow({ ow: inst.ow, backend: inst.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wf }),
      );
    }

    const w = inst.ow.newWorker({ concurrency: 25 });
    inst.worker = w;
    await w.start();

    const t0 = Date.now();
    const handles = await Promise.all(
      compiled.map((c, i) => c.run({ tenantId: tenantIds[i]! })),
    );
    const results = await Promise.all(handles.map((h) => h.result()));
    const elapsedMs = Date.now() - t0;

    // Every result has the matching tenantId threaded through every step.
    for (let i = 0; i < N; i++) {
      const out = results[i] as { outputs: Record<string, any> };
      const finalDone = out.outputs["done"].result;
      expect(finalDone.tenantId).toBe(tenantIds[i]);
      expect(finalDone.seenInTrigger).toBe(tenantIds[i]);
      expect(finalDone.seenInStep1).toBe(tenantIds[i]);
      expect(finalDone.seenInStep2).toBe(tenantIds[i]);
    }

    const maxWaitSec = Math.max(...waitMatrix);
    // With concurrency 25 and waits 1-5s, total wall-clock is dominated by
    // the slowest wait + queue latency. Bound: maxWait + 12s slack.
    expect(elapsedMs).toBeLessThan((maxWaitSec + 12) * 1000);
    // Print throughput for visibility (vitest captures stdout).
    // eslint-disable-next-line no-console
    console.log(
      `[stress-100] elapsed=${(elapsedMs / 1000).toFixed(1)}s, ` +
      `max-wait=${maxWaitSec}s, ` +
      `mean-wait=${(waitMatrix.reduce((a, b) => a + b, 0) / N).toFixed(2)}s`,
    );
  });

  it("100 OFF-TIMED workflows (started over a 4s arrival window) all complete correctly", async () => {
    inst = await newPgInst();
    const { tools, blocks } = freshRegistries();

    const N = 100;
    const tenantIds = Array.from({ length: N }, (_, i) => `offtimed-${i.toString().padStart(3, "0")}`);
    const compiled = tenantIds.map((_, i) => {
      const waitSec = 1 + Math.floor(Math.random() * 8); // 1-8s waits
      const wf = buildTenantWf(`offtimed-${i}`, waitSec);
      return buildDurableWorkflow({ ow: inst.ow, backend: inst.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wf });
    });

    const w = inst.ow.newWorker({ concurrency: 30 });
    inst.worker = w;
    await w.start();

    const t0 = Date.now();
    // Stagger the starts: each run goes in at a random offset in [0, 4000ms].
    const handles = await Promise.all(
      compiled.map(async (c, i) => {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4000)));
        return c.run({ tenantId: tenantIds[i]! });
      }),
    );
    const results = await Promise.all(handles.map((h) => h.result()));
    const elapsedMs = Date.now() - t0;

    for (let i = 0; i < N; i++) {
      const out = results[i] as { outputs: Record<string, any> };
      expect(out.outputs["done"].result.tenantId).toBe(tenantIds[i]);
    }
    // eslint-disable-next-line no-console
    console.log(`[off-timed-100] elapsed=${(elapsedMs / 1000).toFixed(1)}s`);
  });
});

describe("hard multi-tenancy via namespaceId", () => {
  it("5 tenants × 20 workflows each, each tenant on its own namespaceId, total isolation", async () => {
    const TENANTS = 5;
    const PER_TENANT = 20;

    const insts: PgInst[] = [];
    try {
      // Each tenant has its OWN Postgres schema + namespaceId. (Two layers
      // of isolation; in production you'd typically pick one.)
      for (let t = 0; t < TENANTS; t++) {
        insts.push(await newPgInst({ namespaceId: `ns-${t}` }));
      }
      const { tools, blocks } = freshRegistries();

      const allTenantInputs: Array<{ tIdx: number; tenantId: string }> = [];
      const compiledPerTenant: Array<Array<ReturnType<typeof buildDurableWorkflow>>> = [];

      for (let t = 0; t < TENANTS; t++) {
        const ts: ReturnType<typeof buildDurableWorkflow>[] = [];
        for (let j = 0; j < PER_TENANT; j++) {
          const tenantId = `t${t}-w${j.toString().padStart(2, "0")}`;
          const waitSec = 1 + Math.floor(Math.random() * 4);
          const wf = buildTenantWf(`tenant${t}_wf${j}`, waitSec);
          ts.push(
            buildDurableWorkflow({
              ow: insts[t]!.ow, backend: insts[t]!.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wf,
            }),
          );
          allTenantInputs.push({ tIdx: t, tenantId });
        }
        compiledPerTenant.push(ts);
      }

      // Start one worker per tenant. Each worker only sees ITS namespace.
      for (let t = 0; t < TENANTS; t++) {
        const w = insts[t]!.ow.newWorker({ concurrency: 10 });
        insts[t]!.worker = w;
        await w.start();
      }

      const t0 = Date.now();
      // Run all (T × N) workflows in parallel.
      const handles = await Promise.all(
        allTenantInputs.map(async (inp, idx) => {
          const tenantWfs = compiledPerTenant[inp.tIdx]!;
          const wfIdxWithinTenant = idx % PER_TENANT;
          return tenantWfs[wfIdxWithinTenant]!.run({ tenantId: inp.tenantId });
        }),
      );
      const results = await Promise.all(handles.map((h) => h.result()));
      const elapsedMs = Date.now() - t0;

      // All completed with correct tenant data.
      for (let i = 0; i < allTenantInputs.length; i++) {
        const out = results[i] as { outputs: Record<string, any> };
        expect(out.outputs["done"].result.tenantId).toBe(allTenantInputs[i]!.tenantId);
      }

      // Tenancy isolation: each tenant's PG schema saw only ITS workflow runs.
      // Verify by counting workflow_runs rows per schema.
      const postgres = (await import("postgres")).default;
      const sql = postgres(PG_URL, { max: 1 });
      try {
        for (let t = 0; t < TENANTS; t++) {
          const schema = insts[t]!.schema;
          const rows = await sql.unsafe(
            `SELECT COUNT(*)::int AS n FROM "${schema}".workflow_runs`,
          );
          expect((rows as any)[0]!.n).toBe(PER_TENANT);
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
      // eslint-disable-next-line no-console
      console.log(
        `[multi-tenant ${TENANTS}×${PER_TENANT}] elapsed=${(elapsedMs / 1000).toFixed(1)}s ` +
        `(total ${TENANTS * PER_TENANT} runs, isolated by schema)`,
      );
    } finally {
      await Promise.all(insts.map((i) => i.dispose()));
    }
  });
});
