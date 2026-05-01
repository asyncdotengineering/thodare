import { describe, it, expect } from "vitest";
import {
  applyOperations,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";

/**
 * Three guarantees the LLM-facing surface MUST preserve. These pin down
 * security/correctness invariants that should never regress as we extend
 * @thodare/engine.
 */
describe("LLM-surface guarantees", () => {
  it("hidden params are stripped before they can land in the workflow JSON", () => {
    const { tools, blocks } = freshRegistries();
    const empty: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [],
      connections: [],
    };
    // Slack's `accessToken` is `visibility: 'hidden'` — the LLM is trying to
    // smuggle it in via a patch. The apply layer must strip it.
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      {
        operation_type: "add",
        block_id: "n",
        type: "slack",
        params: {
          operation: "send",
          channel: "#general",
          text: "hi",
          accessToken: "xoxb-LLM-INJECTED-CREDENTIAL",
        },
      },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const slack = r.workflow.blocks.find((b) => b.id === "n")!;
    // accessToken is gone.
    expect("accessToken" in slack.params).toBe(false);
    // We surfaced a structured error so the LLM knows what happened.
    const fieldErr = r.validation_errors.find(
      (e) => e.block_id === "n" && (e as any).field === "accessToken",
    );
    expect(fieldErr).toBeDefined();
    expect(fieldErr!.error).toMatch(/not exposed by block 'slack'/);
  });

  it("reference to an undeclared block output produces a structured error citing available outputs", () => {
    const { tools, blocks } = freshRegistries();
    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      {
        operation_type: "add",
        block_id: "fetch",
        type: "http",
        params: { url: "https://example.com" },
      },
      // {{fetch.full_name}} doesn't exist — http only declares status/body/headers.
      {
        operation_type: "add",
        block_id: "send",
        type: "slack",
        params: { operation: "send", channel: "#x", text: "hi {{fetch.full_name}}" },
      },
      { operation_type: "connect", block_id: "trg", target_block_id: "fetch" },
      { operation_type: "connect", block_id: "fetch", target_block_id: "send" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const refErr = r.validation_errors.find((e) => e.block_id === "send");
    expect(refErr).toBeDefined();
    expect(refErr!.error).toMatch(/does not declare output 'full_name'/);
    expect(refErr!.error).toMatch(/Available: status, body, headers/);
  });

  it("a single bad op skips with a typed reason and does not crash the batch", () => {
    const { tools, blocks } = freshRegistries();
    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      // unknown block type — must skip, not throw.
      { operation_type: "add", block_id: "x", type: "totally_made_up", params: {} },
      // valid follow-up still applies.
      {
        operation_type: "add",
        block_id: "fetch",
        type: "http",
        params: { url: "https://example.com" },
      },
      { operation_type: "connect", block_id: "trg", target_block_id: "fetch" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.skipped_items).toHaveLength(1);
    expect(r.skipped_items[0]!.reason_code).toBe("block_type_not_registered");
    expect(r.skipped_items[0]!.block_id).toBe("x");
    // Other ops still applied.
    expect(r.workflow.blocks.find((b) => b.id === "trg")).toBeDefined();
    expect(r.workflow.blocks.find((b) => b.id === "fetch")).toBeDefined();
    expect(r.workflow.connections).toHaveLength(1);
  });

  it("connecting in a cycle is refused with a typed skip", () => {
    const { tools, blocks } = freshRegistries();
    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "a", type: "transform", params: { template: {} } },
      { operation_type: "add", block_id: "b", type: "transform", params: { template: {} } },
      { operation_type: "connect", block_id: "a", target_block_id: "b" },
      // would cycle
      { operation_type: "connect", block_id: "b", target_block_id: "a" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const skip = r.skipped_items.find((s) => s.reason_code === "cycle_introduced");
    expect(skip).toBeDefined();
    expect(r.workflow.connections).toHaveLength(1);
  });
});
