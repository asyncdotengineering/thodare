// Real-engine E2E: exercises wrapWorkflowBinding.create() → CF Workflows
// engine → ThodareWorkflow.run() → dispatcher loadRunner → walkWorkflow,
// validated through D1 step rows + lifecycle events. Closes the gap from
// the upstream-verification audit (D1 — no [[workflows]] block in
// wrangler; no test of the full dispatch round-trip).
//
// vitest-pool-workers@0.12.21 (workerd 1.20260310.1) DOES dispatch CF
// Workflows in-pool: the assertions below pass without any silent-skip.
import { describe, it, expect, beforeAll } from "vitest";
import { ddlStatements } from "./apply-migrations.js";
import type { CFEnv } from "../src/types.js";
import { BackendCloudflareDynamic } from "../src/adapter.js";
import { D1Storage } from "../src/d1-storage.js";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import { buildSingleStepWorkflowJson } from "./_fixtures.js";

const ORG_ID = "real-engine-org";

async function getEnv(): Promise<CFEnv> {
  const mod = await import("cloudflare:test");
  return (mod as unknown as { env: Record<string, unknown> }).env as unknown as CFEnv;
}

describe("real-engine E2E: wrapWorkflowBinding → CF Workflows → walkWorkflow", () => {
  let env: CFEnv;
  let backend: BackendCloudflareDynamic;

  beforeAll(async () => {
    env = await getEnv();
    for (const stmt of ddlStatements()) {
      await env.THODARE_DB.prepare(stmt).run();
    }
    backend = new BackendCloudflareDynamic({ env, organizationId: ORG_ID });
  });

  it("WORKFLOWS binding is available on env", () => {
    expect(env.WORKFLOWS).toBeDefined();
    expect(typeof env.WORKFLOWS.create).toBe("function");
  });

  it("real CF Workflows engine dispatches: create() → ThodareWorkflow.run() → walker writes step rows + events to D1", async () => {
    const wfName = `real-e2e-${crypto.randomUUID().slice(0, 8)}`;
    const runId = crypto.randomUUID();
    const wf = buildSingleStepWorkflowJson();

    // Register workflow via production path.
    await backend.defineWorkflow({ name: wfName }, async () => {});
    await backend.setWorkflowDefinition(wfName, 1, wf);

    // Insert a run row so the dispatcher can find it.
    await backend.storage.insertRun({
      id: runId,
      workflowName: wfName,
      organizationId: ORG_ID,
      specVersion: backend.specVersion,
      idempotencyKey: null,
      input: { message: "hello" },
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const binding = wrapWorkflowBinding(
      {
        workflowId: wfName,
        organizationId: ORG_ID,
        workflowVersion: "1",
        runId,
      },
      { bindingName: "WORKFLOWS" },
    );

    // Route through the CF Workflows engine to ThodareWorkflow.run(). If the
    // workerd in vitest-pool-workers doesn't support workflows dispatch, this
    // throws and the test fails loudly — that's the signal we need.
    await binding.create({
      id: runId,
      params: { message: "hello" },
    } as Record<string, unknown>);

    // create() must have succeeded — assert the engine dispatched and the
    // walker actually ran by checking D1 for step rows + lifecycle events.
    // No silent-skip: if these assertions fail, the pool isn't running CF
    // Workflows engine dispatch (or the dispatcher isn't being invoked).
    const completed = await pollForCompletion(backend.storage, runId);
    expect(completed, "run did not reach a terminal state — engine did not dispatch").toBe(true);

    const steps = await backend.storage.steps.list(runId as never);
    expect(
      steps.length,
      "no step rows written — walker did not execute",
    ).toBeGreaterThanOrEqual(1);
    for (const step of steps) {
      expect(step.status).toBe("completed");
    }

    const events = await backend.storage.events.list({ runId });
    const stepEvents = events.filter(
      (e) => e.type === "step_started" || e.type === "step_completed",
    );
    expect(
      stepEvents.length,
      "no lifecycle events written — cf-step-shim was not invoked",
    ).toBeGreaterThanOrEqual(2);
  });

  it("runWorkflow creates a run row and does not throw", async () => {
    // This test exercises the adapter's runWorkflow path (which wraps
    // wrapWorkflowBinding.create() and adds idempotency + error handling).
    // The workerd pool may not dispatch a second WF instance to the same
    // class in the same test run (CF Workflows engine concurrency limits
    // in the workerd test pool), so we only assert that the create()
    // call succeeds and the run row is written. The full dispatch
    // round-trip is proven in the test above.
    const wfName = `runwf-${crypto.randomUUID().slice(0, 8)}`;
    const wf = buildSingleStepWorkflowJson();

    await backend.defineWorkflow({ name: wfName }, async () => {});
    await backend.setWorkflowDefinition(wfName, 1, wf);

    const runHandle = await backend.runWorkflow(wfName, { message: "hello" });
    expect(runHandle).toBeDefined();
    expect(runHandle.runId).toBeDefined();

    // Verify the run row was created.
    const run = await backend.storage.runs.get(runHandle.runId as never);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("running");
  });
});

/** Poll D1 every 200ms up to 10s for run completion. Returns true if a
 *  terminal state was reached, false on timeout — the caller asserts. */
async function pollForCompletion(storage: D1Storage, runId: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await storage.runs.get(runId as never);
    if (run && (run.status === "completed" || run.status === "failed")) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
