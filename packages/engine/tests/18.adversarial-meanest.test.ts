/**
 * The mean ones — the tests I genuinely thought might find a bug.
 *
 * Goals:
 *   1. Real prototype-pollution path — JSON.parse with literal __proto__,
 *      not just an object literal.
 *   2. Concurrent runs racing on shared mutable state inside a tool.
 *   3. Cancel mid-flight on the durable runtime.
 *   4. Resume payload on the durable runtime that contains a {{ }} string —
 *      does it leak into subsequent reference resolution?
 *   5. Tool that mutates its own params object during execution.
 *   6. apply() with the same op submitted twice in one batch.
 *   7. EditOp with the wrong shape (Zod boundary).
 *   8. A workflow whose name collides with another defined workflow on
 *      the same OpenWorkflow instance.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  applyOperations,
  buildDurableWorkflow,
  EditOpSchema,
  execute,
  type EditOp,
  type SerializedWorkflow,
  type Tool,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

describe("the mean tests", () => {
  it("JSON.parse-style __proto__ payload (not object literal) does not pollute Object.prototype", () => {
    // Object literals with __proto__ get parsed specially. JSON.parse()'d
    // input lands as an own property. Confirm the apply layer rejects it
    // and Object.prototype stays clean.
    const { tools, blocks } = freshRegistries();
    const evilJson = JSON.parse(`{
      "__proto__": { "polluted": "yes" },
      "operation_type": "add",
      "block_id": "n",
      "type": "trigger_webhook",
      "params": {}
    }`);
    const ops: EditOp[] = [evilJson];
    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("EditOpSchema rejects an unknown operation_type", () => {
    const evil: any = { operation_type: "exec", block_id: "x", code: "rm -rf /" };
    const parsed = EditOpSchema.safeParse(evil);
    expect(parsed.success).toBe(false);
  });

  it("two ADD ops with the same block_id in one batch — second skips, first applies", () => {
    const { tools, blocks } = freshRegistries();
    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "x", type: "transform", params: { template: { v: 1 } } },
      { operation_type: "add", block_id: "x", type: "http", params: { url: "https://attacker" } },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.workflow.blocks.find((b) => b.id === "x")!.type).toBe("transform");
    expect(r.skipped_items.some((s) => s.reason_code === "block_already_exists")).toBe(true);
  });

  it("concurrent in-memory runs do not race through a shared mutable counter inside a tool", async () => {
    // Spin up 20 in-memory runs in parallel against the same tool instance.
    // The tool increments a private counter; all increments must land
    // (i.e. no awaits eat each other).
    const { tools, blocks } = freshRegistries();
    let counter = 0;
    const tool: Tool = {
      id: "incr", name: "", description: "", params: {}, outputs: { v: { type: "number" } },
      async execute() {
        const v = ++counter;
        await new Promise((r) => setTimeout(r, 5));
        return { v };
      },
    };
    tools.register(tool);
    blocks.register({
      type: "incr_block", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { v: { type: "number" } },
      tools: { access: ["incr"], config: { tool: () => "incr" } },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "i", type: "incr_block", enabled: true, params: {} },
      ],
      connections: [{ source: "trg", target: "i" }],
    };
    const runs = await Promise.all(
      Array.from({ length: 20 }, () => execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools })),
    );
    expect(runs.every((r) => r.success)).toBe(true);
    // 20 distinct values landed.
    const seen = new Set(runs.map((r) => (r.outputs["i"] as { v: number }).v));
    expect(seen.size).toBe(20);
    expect(counter).toBe(20);
  });

  it("a resume payload that contains a {{ }} string does NOT trigger another round of resolution downstream", async () => {
    const { tools, blocks } = freshRegistries();
    let captured: any = null;
    tools.register({
      id: "see", name: "", description: "",
      params: { v: { type: "object", visibility: "user-or-llm" } },
      outputs: {},
      async execute(p) { captured = p.v; return {}; },
    });
    blocks.register({
      type: "see_b", name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "v", title: "v", type: "json" }],
      outputs: {},
      tools: { access: ["see"], config: { tool: () => "see" } },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "h", type: "human_approval", enabled: true, params: { prompt: "?" } },
        // The downstream block reads the wait block's output via {{h.attack}}.
        // The wait block's resume payload contains a string that LOOKS like
        // a template — confirm the resolver does NOT re-expand it.
        { id: "s", type: "see_b", enabled: true, params: { v: "{{h.attack}}" } },
      ],
      connections: [
        { source: "trg", target: "h" },
        { source: "h", target: "s" },
      ],
    };
    const r1 = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r1.paused).toBe(true);
    const { resume } = await import("../src/index.js");
    await resume(
      r1.snapshot!,
      { attack: "{{env.SECRET}}" },
      { toolRegistry: tools, blockRegistry: blocks, env: { SECRET: "leak" } },
    );
    // Resolved literally — no re-expansion.
    expect(captured).toBe("{{env.SECRET}}");
  });

  it("tool that mutates its `params` argument cannot leak that mutation back into the workflow JSON", async () => {
    // Defensive copy contract. Even if a tool author writes `delete p.foo`
    // or `p.x = "evil"`, the next run with the same workflow JSON must not
    // observe the mutation.
    const { tools, blocks } = freshRegistries();
    tools.register({
      id: "mutate", name: "", description: "",
      params: { x: { type: "string", visibility: "user-or-llm" } },
      outputs: {},
      async execute(p) {
        (p as any).x = "MUTATED";
        delete (p as any).x;
        return {};
      },
    });
    blocks.register({
      type: "mut_b", name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "x", title: "x", type: "short-input" }],
      outputs: {},
      tools: { access: ["mutate"], config: { tool: () => "mutate" } },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "m", type: "mut_b", enabled: true, params: { x: "original" } },
      ],
      connections: [{ source: "trg", target: "m" }],
    };
    // Run twice in a row.
    await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    // Workflow JSON is unchanged.
    expect(wf.blocks.find((b) => b.id === "m")!.params["x"]).toBe("original");
    await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(wf.blocks.find((b) => b.id === "m")!.params["x"]).toBe("original");
  });

  it("two distinct durable workflow definitions registered with the SAME name throw a clear error", async () => {
    const { tools, blocks } = freshRegistries();
    const h = await newDurableHarness();
    try {
      const wfA: SerializedWorkflow = {
        version: "1.0.0",
        metadata: { name: "duplicate-name-test" },
        blocks: [
          { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
          { id: "x", type: "transform", enabled: true, params: { template: { v: "A" } } },
        ],
        connections: [{ source: "trg", target: "x" }],
      };
      const wfB: SerializedWorkflow = { ...wfA };
      buildDurableWorkflow({ ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wfA });
      // Register a SECOND with the same derived name — openworkflow must reject.
      expect(() =>
        buildDurableWorkflow({ ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wfB }),
      ).toThrow();
    } finally {
      await h.dispose();
    }
  });

  it("cancelling a paused durable run prevents the downstream blocks from ever running", async () => {
    const h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    let downstreamRan = false;
    tools.register({
      id: "shouldnt_run", name: "", description: "", params: {}, outputs: {},
      async execute() { downstreamRan = true; return {}; },
    });
    blocks.register({
      type: "trap", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: {},
      tools: { access: ["shouldnt_run"], config: { tool: () => "shouldnt_run" } },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-cancel" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        {
          id: "w",
          type: "wait_for_event",
          enabled: true,
          params: { eventName: "never_will_fire", timeoutHours: 1 },
        },
        { id: "down", type: "trap", enabled: true, params: {} },
      ],
      connections: [
        { source: "trg", target: "w" },
        { source: "w", target: "down" },
      ],
    };
    const compiled = buildDurableWorkflow({ ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wf });
    await h.startWorker();
    const handle = await compiled.run({});
    await new Promise((r) => setTimeout(r, 600)); // park
    await handle.cancel();
    await new Promise((r) => setTimeout(r, 400)); // give the worker a beat
    expect(downstreamRan).toBe(false);
    // Cleanup
    await h.dispose();
  });
});
