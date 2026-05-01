import { describe, it, expect, afterEach } from "vitest";
import { buildDurableWorkflow, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

let h: DurableHarness;
afterEach(async () => { await h.dispose(); });

/**
 * Two workflows:
 *   - main: trigger → wait_for_event(approval) → transform({{wait.data.approved}})
 *   - signaller: emits the named signal with a payload
 *
 * Verifies:
 *   - main parks on the wait
 *   - signaller's emit unblocks it
 *   - the event payload reaches the downstream transform via {{wait.data}}
 */
describe("durable runtime: wait_for_event", () => {
  it("parks on a named event and resumes with the payload when an emitter fires", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    const main: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-wait-event-main" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        {
          id: "wait",
          type: "wait_for_event",
          enabled: true,
          params: { eventName: "approval-received" },
        },
        {
          id: "after",
          type: "transform",
          enabled: true,
          params: { template: { ok: "{{wait.data.approved}}", by: "{{wait.data.by}}" } },
        },
      ],
      connections: [
        { source: "trg", target: "wait" },
        { source: "wait", target: "after" },
      ],
    };

    const signaller: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-emit-approval" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        // We expose `emit` as a private compute tool here for the test only.
      ],
      connections: [],
    };

    // Inject a one-off "emit" tool for the signaller. Keeps the public tool
    // surface clean: emit is a runner-side concept, not a wfkit block.
    tools.register({
      id: "test_emit",
      name: "Emit Signal (test)",
      description: "Emit an openworkflow signal — test-only.",
      params: {
        signal: { type: "string", required: true, visibility: "user-or-llm" },
        data: { type: "object", required: false, visibility: "user-or-llm" },
      },
      outputs: {},
      // The emit happens via step.sendSignal; the in-memory executor's tool
      // contract doesn't expose `step`, so this tool throws if used in dev.
      // The durable runtime never calls .execute on test_emit (we hand-craft
      // the signaller workflow below using openworkflow's API directly).
      async execute() {
        throw new Error("test_emit must be invoked through the durable runtime");
      },
    });

    // Build main as @thodare/engine; build signaller directly with openworkflow.
    const compiledMain = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: main,
    });
    const sig = h.ow.defineWorkflow(
      { name: "test_signaller" },
      async ({ input, step }) => {
        const payload = input as { approved: boolean; by: string };
        await step.sendSignal({
          name: "emit",
          signal: "approval-received",
          data: payload,
        });
        return { sent: true };
      },
    );
    void signaller; // keep the doc shape for completeness even though we use ow directly

    await h.startWorker();

    const mainHandle = await compiledMain.run({});
    // Give the main workflow a beat to park.
    await new Promise((r) => setTimeout(r, 800));

    await (await sig.run({ approved: true, by: "alice" })).result();

    const out = (await mainHandle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["after"].result.ok).toBe(true);
    expect(out.outputs["after"].result.by).toBe("alice");
  });
});
