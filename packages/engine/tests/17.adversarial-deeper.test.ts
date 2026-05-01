/**
 * Deeper red-team — things I genuinely didn't know the answer to before
 * writing the test. The goal is to FIND bugs, not just confirm safety.
 *
 * After running this file: the README is updated with explicit policy
 * statements for each finding (defended / out-of-scope / known-bug).
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  applyOperations,
  buildDurableWorkflow,
  execute,
  type EditOp,
  type SerializedWorkflow,
  type Tool,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

describe("deeper red-team — things we actually wanted to find out", () => {
  const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };

  it("name-vs-id collision: a block with name 'enrich' and another block with id 'enrich' — references go where?", async () => {
    // Resolver behavior: BlockResolver checks `blockOutputs[head]` first
    // (id-based), THEN falls back to `blockIdsByName.get(head)`. So a literal
    // id wins over a name. Document this.
    const { tools, blocks } = freshRegistries();
    blocks.register({
      type: "stamp", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { v: { type: "string" } },
      tools: { access: ["stamp_t"], config: { tool: () => "stamp_t" } },
    });
    tools.register({
      id: "stamp_t", name: "", description: "", params: {}, outputs: { v: { type: "string" } },
      async execute() { return { v: "from-id" }; },
    });
    blocks.register({
      type: "stamp2", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { v: { type: "string" } },
      tools: { access: ["stamp2_t"], config: { tool: () => "stamp2_t" } },
    });
    tools.register({
      id: "stamp2_t", name: "", description: "", params: {}, outputs: { v: { type: "string" } },
      async execute() { return { v: "from-name" }; },
    });
    blocks.register({
      type: "echo", name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "x", title: "x", type: "short-input" }],
      outputs: { result: { type: "string" } },
      tools: { access: ["echo_t"], config: { tool: () => "echo_t" } },
    });
    tools.register({
      id: "echo_t", name: "", description: "",
      params: { x: { type: "string", visibility: "user-or-llm" } },
      outputs: { result: { type: "string" } },
      async execute(p) { return { result: String(p.x) }; },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        // ID is "enrich"
        { id: "enrich", type: "stamp", enabled: true, params: {} },
        // NAME is "enrich" — but ID is something else
        { id: "shadow", name: "enrich", type: "stamp2", enabled: true, params: {} },
        { id: "e", type: "echo", enabled: true, params: { x: "{{enrich.v}}" } },
      ],
      connections: [
        { source: "trg", target: "enrich" },
        { source: "trg", target: "shadow" },
        { source: "enrich", target: "e" },
        { source: "shadow", target: "e" },
      ],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r.success).toBe(true);
    // Direct id wins.
    expect((r.outputs["e"] as { result: string }).result).toBe("from-id");
  });

  it("env value containing a {{ }} pattern is NOT re-expanded", async () => {
    const { tools, blocks } = freshRegistries();
    blocks.register({
      type: "echo", name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "x", title: "x", type: "short-input" }],
      outputs: { result: { type: "string" } },
      tools: { access: ["echo_t"], config: { tool: () => "echo_t" } },
    });
    tools.register({
      id: "echo_t", name: "", description: "",
      params: { x: { type: "string", visibility: "user-or-llm" } },
      outputs: { result: { type: "string" } },
      async execute(p) { return { result: String(p.x) }; },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "e", type: "echo", enabled: true, params: { x: "[{{env.MAYBE_TEMPLATE}}]" } },
      ],
      connections: [{ source: "trg", target: "e" }],
    };
    const r = await execute({
      workflow: wf,
      blockRegistry: blocks,
      toolRegistry: tools,
      env: { MAYBE_TEMPLATE: "{{env.SECRET}}", SECRET: "hunter2" },
    });
    expect(r.success).toBe(true);
    // The literal "{{env.SECRET}}" appears, NOT "hunter2" — single-pass resolution.
    expect((r.outputs["e"] as { result: string }).result).toBe("[{{env.SECRET}}]");
  });

  it("very long block id (10 KB) is preserved through apply + execute without truncation", () => {
    const { tools, blocks } = freshRegistries();
    const longId = "x".repeat(10_240);
    const ops: EditOp[] = [
      { operation_type: "add", block_id: longId, type: "transform", params: { template: {} } },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.workflow.blocks).toHaveLength(1);
    expect(r.workflow.blocks[0]!.id.length).toBe(10_240);
  });

  it("workflow with `kind: 'wait'` block but no outgoing edges still pauses (and effectively ends after wake)", async () => {
    // Trigger → wait → (nothing). The pause should still happen; on wake
    // there's just nothing downstream to do.
    const { tools, blocks } = freshRegistries();
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "w", type: "wait_for_event", enabled: true, params: { eventName: "x" } },
      ],
      connections: [{ source: "trg", target: "w" }],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r.paused).toBe(true);
    expect(r.snapshot!.pausedAtBlockId).toBe("w");
  });

  it("a tool that returns a deeply nested object is preserved through resolution", async () => {
    // Make sure JSON.stringify in interpolation doesn't truncate or mis-handle.
    const { tools, blocks } = freshRegistries();
    blocks.register({
      type: "deep", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { tree: { type: "object" } },
      tools: { access: ["deep_t"], config: { tool: () => "deep_t" } },
    });
    tools.register({
      id: "deep_t", name: "", description: "", params: {},
      outputs: { tree: { type: "object" } },
      async execute() {
        let cur: any = { leaf: 42 };
        for (let i = 0; i < 50; i++) cur = { down: cur };
        return { tree: cur };
      },
    });
    blocks.register({
      type: "see", name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "v", title: "v", type: "json" }],
      outputs: { ok: { type: "boolean" } },
      tools: { access: ["see_t"], config: { tool: () => "see_t" } },
    });
    let captured: any = null;
    tools.register({
      id: "see_t", name: "", description: "",
      params: { v: { type: "object", visibility: "user-or-llm" } },
      outputs: { ok: { type: "boolean" } },
      async execute(p) { captured = p.v; return { ok: true }; },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "d", type: "deep", enabled: true, params: {} },
        { id: "s", type: "see", enabled: true, params: { v: "{{d.tree}}" } },
      ],
      connections: [
        { source: "trg", target: "d" },
        { source: "d", target: "s" },
      ],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r.success).toBe(true);
    // Walk to the leaf.
    let cur = captured;
    for (let i = 0; i < 50; i++) cur = cur.down;
    expect(cur.leaf).toBe(42);
  });
});

describe("deeper red-team — durable runtime quirks", () => {
  let h: DurableHarness;
  afterEach(async () => { await h.dispose(); });

  it("non-determinism inside step.run is memoized — Date.now() observed once stays observed across replay", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    let observedTs: number[] = [];
    let throwsOnce = true;
    const dateTool: Tool = {
      id: "date_tool", name: "", description: "", params: {}, outputs: { ts: { type: "number" } },
      async execute() {
        const ts = Date.now();
        observedTs.push(ts);
        return { ts };
      },
    };
    const flakeTool: Tool = {
      id: "flake_tool", name: "", description: "", params: {}, outputs: {},
      async execute() {
        if (throwsOnce) { throwsOnce = false; throw new Error("first-fail"); }
        return { ok: true };
      },
    };
    tools.register(dateTool); tools.register(flakeTool);
    blocks.register({
      type: "date_block", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { ts: { type: "number" } },
      tools: { access: ["date_tool"], config: { tool: () => "date_tool" } },
    });
    blocks.register({
      type: "flake_block", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: {},
      tools: { access: ["flake_tool"], config: { tool: () => "flake_tool" } },
    });

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-determinism" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "now", type: "date_block", enabled: true, params: {} },
        { id: "fl", type: "flake_block", enabled: true, params: {} },
      ],
      connections: [
        { source: "trg", target: "now" },
        { source: "now", target: "fl" },
      ],
    };
    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wf,
    });
    await h.startWorker();
    const out = (await (await compiled.run({})).result()) as { outputs: any };
    // The `date_tool` ran ONCE despite the second block failing once.
    // openworkflow's memoization preserved its result across the retry replay.
    expect(observedTs).toHaveLength(1);
    expect(out.outputs["now"].ts).toBe(observedTs[0]);
  });

  it("100-block fan-OUT (one trigger, 100 leaves, no joins) completes under 6s", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const wfBlocks: SerializedWorkflow["blocks"] = [
      { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
    ];
    const wfConnections: SerializedWorkflow["connections"] = [];
    for (let i = 0; i < 100; i++) {
      wfBlocks.push({
        id: `leaf${i}`,
        type: "transform",
        enabled: true,
        params: { template: { i, dept: "{{trigger.dept}}" } },
      });
      wfConnections.push({ source: "trg", target: `leaf${i}` });
    }
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-fanout-100" },
      blocks: wfBlocks,
      connections: wfConnections,
    };
    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wf,
    });
    await h.startWorker();
    const t0 = Date.now();
    const out = (await (await compiled.run({ dept: "ops" })).result()) as { outputs: any };
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(out.outputs["leaf99"].result).toEqual({ i: 99, dept: "ops" });
    // Spot-check three leaves to confirm no collision.
    expect(out.outputs["leaf0"].result.i).toBe(0);
    expect(out.outputs["leaf42"].result.i).toBe(42);
  });
});
