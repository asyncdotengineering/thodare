import { describe, it, expect, afterEach } from "vitest";
import { buildDurableWorkflow, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

let h: DurableHarness;
afterEach(async () => { await h.dispose(); });

describe("durable runtime: wait_duration", () => {
  it("durably pauses for a fixed duration then continues", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-wait-dur" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "wait", type: "wait_duration", enabled: true, params: { duration: 1, unit: "seconds" } },
        { id: "after", type: "transform", enabled: true, params: { template: { resumed: true } } },
      ],
      connections: [
        { source: "trg", target: "wait" },
        { source: "wait", target: "after" },
      ],
    };

    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: wf,
    });
    await h.startWorker();

    const t0 = Date.now();
    const out = (await (await compiled.run({})).result()) as { outputs: Record<string, any> };
    const elapsed = Date.now() - t0;

    expect(out.outputs["after"].result.resumed).toBe(true);
    // Resolution is in seconds for openworkflow's step.sleep; require ≥ 900ms.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});
