/**
 * Graph-shape red-team. The DAG builder + topo sort + connection rules
 * are deceptively simple. These probe the edges where graph-validity
 * mistakes turn into runtime weirdness.
 */

import { describe, it, expect } from "vitest";
import {
  applyOperations,
  execute,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";

describe("graph shape red-team", () => {
  const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };

  it("duplicate block_id at apply time is skipped, not allowed to corrupt the workflow", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "x", type: "transform", params: { template: { v: 1 } } },
      // Same id, different params — should land as block_already_exists.
      { operation_type: "add", block_id: "x", type: "http", params: { url: "https://attacker.example" } },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(
      r.skipped_items.some((s) => s.reason_code === "block_already_exists" && s.block_id === "x"),
    ).toBe(true);
    // The original (transform) is preserved; the impostor (http with attacker URL) is gone.
    const x = r.workflow.blocks.find((b) => b.id === "x")!;
    expect(x.type).toBe("transform");
  });

  it("connection to/from a non-existent block is rejected with structured skip", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "real", type: "transform", params: { template: {} } },
      // From real → ghost
      { operation_type: "connect", block_id: "real", target_block_id: "ghost" },
      // From ghost → real
      { operation_type: "connect", block_id: "ghost", target_block_id: "real" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const sources = r.skipped_items.filter((s) => s.reason_code === "invalid_edge_source");
    const targets = r.skipped_items.filter((s) => s.reason_code === "invalid_edge_target");
    expect(targets.length + sources.length).toBe(2);
    expect(r.workflow.connections).toHaveLength(0);
  });

  it("a fork-and-join graph executes both arms before the join block fires", async () => {
    // trg → A
    //  ↓     ↘
    //  └→ B → join
    const { tools, blocks } = freshRegistries();
    const aRan: number[] = [];
    const bRan: number[] = [];
    const joinRan: { aOut: unknown; bOut: unknown }[] = [];

    blocks.register({
      type: "stamp_a",
      name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { v: { type: "number" } },
      tools: { access: ["stamp_a_t"], config: { tool: () => "stamp_a_t" } },
    });
    blocks.register({
      type: "stamp_b",
      name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { v: { type: "number" } },
      tools: { access: ["stamp_b_t"], config: { tool: () => "stamp_b_t" } },
    });
    blocks.register({
      type: "join_block",
      name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [
        { id: "aOut", title: "a", type: "json" },
        { id: "bOut", title: "b", type: "json" },
      ],
      outputs: { ok: { type: "boolean" } },
      tools: { access: ["join_t"], config: { tool: () => "join_t" } },
    });
    tools.register({
      id: "stamp_a_t", name: "", description: "", params: {}, outputs: { v: { type: "number" } },
      async execute() { aRan.push(Date.now()); return { v: 1 }; },
    });
    tools.register({
      id: "stamp_b_t", name: "", description: "", params: {}, outputs: { v: { type: "number" } },
      async execute() { bRan.push(Date.now()); return { v: 2 }; },
    });
    tools.register({
      id: "join_t", name: "", description: "",
      params: {
        aOut: { type: "object", visibility: "user-or-llm" },
        bOut: { type: "object", visibility: "user-or-llm" },
      },
      outputs: { ok: { type: "boolean" } },
      async execute(p) { joinRan.push({ aOut: p.aOut, bOut: p.bOut }); return { ok: true }; },
    });

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "A", type: "stamp_a", enabled: true, params: {} },
        { id: "B", type: "stamp_b", enabled: true, params: {} },
        { id: "J", type: "join_block", enabled: true, params: { aOut: "{{A}}", bOut: "{{B}}" } },
      ],
      connections: [
        { source: "trg", target: "A" },
        { source: "trg", target: "B" },
        { source: "A", target: "J" },
        { source: "B", target: "J" },
      ],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools, trigger: {} });
    expect(r.success).toBe(true);
    // Both arms ran before the join.
    expect(aRan).toHaveLength(1);
    expect(bRan).toHaveLength(1);
    expect(joinRan).toHaveLength(1);
    expect(joinRan[0]!.aOut).toEqual({ v: 1 });
    expect(joinRan[0]!.bOut).toEqual({ v: 2 });
  });

  it("workflow with no entrypoints (every block is its own root) executes every block as a root", async () => {
    // Sanity: an "all-roots" graph (no edges, no trigger) — apply allows it,
    // execute should run each node independently. This is a common
    // intermediate state during LLM construction.
    const { tools, blocks } = freshRegistries();
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "a", type: "transform", enabled: true, params: { template: { x: "a" } } },
        { id: "b", type: "transform", enabled: true, params: { template: { x: "b" } } },
        { id: "c", type: "transform", enabled: true, params: { template: { x: "c" } } },
      ],
      connections: [],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r.success).toBe(true);
    expect((r.outputs["a"] as any).result).toEqual({ x: "a" });
    expect((r.outputs["b"] as any).result).toEqual({ x: "b" });
    expect((r.outputs["c"] as any).result).toEqual({ x: "c" });
  });

  it("trigger payload not provided defaults to empty object, not null/undefined", async () => {
    const { tools, blocks } = freshRegistries();
    blocks.register({
      type: "see_trg", name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "got", title: "g", type: "json" }],
      outputs: { isObj: { type: "boolean" } },
      tools: { access: ["see_t"], config: { tool: () => "see_t" } },
    });
    tools.register({
      id: "see_t", name: "", description: "",
      params: { got: { type: "object", visibility: "user-or-llm" } },
      outputs: { isObj: { type: "boolean" } },
      async execute(p) { return { isObj: p.got !== null && typeof p.got === "object" }; },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "s", type: "see_trg", enabled: true, params: { got: "{{trigger}}" } },
      ],
      connections: [{ source: "trg", target: "s" }],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r.success).toBe(true);
    expect((r.outputs["s"] as any).isObj).toBe(true);
  });

  it("orphan disconnect (edge that doesn't exist) skips with structured reason and no graph mutation", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "a", type: "transform", params: { template: {} } },
      { operation_type: "add", block_id: "b", type: "transform", params: { template: {} } },
      { operation_type: "connect", block_id: "a", target_block_id: "b" },
      // Try to disconnect a different (non-existent) edge.
      { operation_type: "disconnect", block_id: "b", target_block_id: "a" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.skipped_items.some((s) => s.reason_code === "edge_not_found")).toBe(true);
    // The valid a→b connection is preserved.
    expect(r.workflow.connections).toHaveLength(1);
    expect(r.workflow.connections[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("delete cascades and removes dangling edges, but other graph stays intact", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "a", type: "transform", params: { template: {} } },
      { operation_type: "add", block_id: "b", type: "transform", params: { template: {} } },
      { operation_type: "add", block_id: "c", type: "transform", params: { template: {} } },
      { operation_type: "connect", block_id: "a", target_block_id: "b" },
      { operation_type: "connect", block_id: "b", target_block_id: "c" },
      { operation_type: "connect", block_id: "a", target_block_id: "c" },
      { operation_type: "delete", block_id: "b" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.workflow.blocks.map((x) => x.id).sort()).toEqual(["a", "c"]);
    // a→c remains, edges touching b are gone.
    expect(r.workflow.connections).toHaveLength(1);
    expect(r.workflow.connections[0]).toMatchObject({ source: "a", target: "c" });
  });
});
