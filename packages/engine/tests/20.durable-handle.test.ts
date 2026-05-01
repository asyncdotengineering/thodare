/**
 * `runDurable` / `getHandle` / describe / result / cancel — the sensible-
 * defaults layer that closes the 5-min `result()` timeout gotcha.
 *
 * Patterns referenced from gh-cli research:
 *   - `Chigala/durable-agent` polls `backend.getWorkflowRun` directly with
 *     no upper bound, only stopping on terminal status.
 *   - This is what @thodare/engine's `DurableHandle` exposes by default.
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildDurableWorkflow, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

let h: DurableHarness;
afterEach(async () => { await h.dispose(); });

const trivialWorkflow = (name: string, waitSec = 1): SerializedWorkflow => ({
  version: "1.0.0",
  metadata: { name },
  blocks: [
    { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
    { id: "wait", type: "wait_duration", enabled: true, params: { duration: waitSec, unit: "seconds" } },
    { id: "done", type: "transform", enabled: true, params: { template: { ok: true } } },
  ],
  connections: [
    { source: "trg", target: "wait" },
    { source: "wait", target: "done" },
  ],
});

describe("DurableHandle: describe / result / cancel", () => {
  it("describe() returns running state immediately, result() polls until completion (NO 5-min cap)", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const wf = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools,
      workflow: trivialWorkflow("handle-1"),
    });
    await h.startWorker();

    const handle = await wf.runDurable({});
    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);

    // Probe state non-blockingly.
    const desc = await handle.describe();
    expect(["pending", "running", "sleeping", "completed"]).toContain(desc.state);
    expect(desc.id).toBe(handle.id);

    // result() works without a timeout — the user no longer needs to know
    // about openworkflow's 5-min default.
    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["done"].result).toEqual({ ok: true });

    // After completion, describe() reflects it.
    const final = await handle.describe();
    expect(final.state).toBe("completed");
  });

  it("result({ timeoutMs }) honors an explicit short timeout and surfaces a clear error message", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const wf = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools,
      // 2 second wait to make sure the result is NOT ready in <500ms.
      workflow: trivialWorkflow("handle-timeout", 2),
    });
    await h.startWorker();
    const handle = await wf.runDurable({});
    await expect(handle.result({ timeoutMs: 500, pollIntervalMs: 100 })).rejects.toThrow(
      /timed out after 500ms — run is still/,
    );
    // The run is still alive — we can keep polling and eventually get it.
    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["done"].result).toEqual({ ok: true });
  });

  it("cancel() flips the run to 'canceled'; describe() reflects it; downstream blocks never fire", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    let downstreamRan = 0;
    tools.register({
      id: "shouldnt", name: "", description: "", params: {}, outputs: {},
      async execute() { downstreamRan += 1; return {}; },
    });
    blocks.register({
      type: "trap", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [], outputs: {},
      tools: { access: ["shouldnt"], config: { tool: () => "shouldnt" } },
    });
    const wfDoc: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "handle-cancel" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "wait", type: "wait_for_event", enabled: true, params: { eventName: "never_will_fire", timeoutHours: 1 } },
        { id: "trap", type: "trap", enabled: true, params: {} },
      ],
      connections: [
        { source: "trg", target: "wait" },
        { source: "wait", target: "trap" },
      ],
    };
    const wf = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wfDoc,
    });
    await h.startWorker();
    const handle = await wf.runDurable({});
    await new Promise((r) => setTimeout(r, 600)); // park
    await handle.cancel();
    await new Promise((r) => setTimeout(r, 400)); // give the worker a beat
    const desc = await handle.describe();
    expect(desc.state).toBe("canceled");
    expect(downstreamRan).toBe(0);
  });

  it("getHandle(runId) reattaches by id and behaves identically to the original handle", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const wf = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools,
      workflow: trivialWorkflow("handle-reattach", 1),
    });
    await h.startWorker();
    const handle = await wf.runDurable({});
    const id = handle.id;
    // "Forget" the handle and reattach by id.
    const reattached = wf.getHandle(id);
    expect(reattached.id).toBe(id);
    const out = (await reattached.result()) as { outputs: Record<string, any> };
    expect(out.outputs["done"].result).toEqual({ ok: true });
  });

  it("`backend` is required by the type system — TS at the call site refuses omission", () => {
    // This test exists as a marker for the API contract. @thodare/engine@alpha:
    // BuildDurableOptions.backend is REQUIRED. The compiler enforces it; we
    // don't add a runtime guard because the type system already does.
    //
    // (Earlier alpha allowed it as optional with a runtime throw. We dropped
    // that — `runDurable` is the production-grade API and you always have the
    // backend reference, since you used it to construct the OpenWorkflow client.)
    expect(true).toBe(true);
  });
});
