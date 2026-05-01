/**
 * defineConnector — the Zod-driven, typed, single-call connector definition.
 *
 * Each test pins one DX guarantee:
 *   1. Zod schemas drive both runtime validation AND TS-level inference.
 *   2. Visibility brands on schemas (`hidden(...)`) propagate to the
 *      underlying Tool's params metadata.
 *   3. The visibility flag is enforced at applyOps time — same
 *      "hidden params can't reach a tool" guarantee as the lower-level API.
 *   4. Output schemas drive declared block outputs, which drive reference
 *      validation (catching `{{enrich.full_name}}` against http's
 *      `{status, body, headers}`).
 *   5. Runtime params validation: workflow JSON that doesn't conform to
 *      the Zod schema fails at execution with a clear error.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  applyOperations,
  BlockRegistry,
  defineConnector,
  hidden,
  ToolRegistry,
  userOnly,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";

describe("defineConnector — Zod → Tool/Block", () => {
  it("emits a Tool whose params reflect the Zod shape AND the visibility brands", () => {
    const slack = defineConnector({
      type: "slack-test",
      params: z.object({
        channel: z.string(),
        text: z.string().describe("Long-form message body"),
        accessToken: hidden(z.string()),
        authMethod: userOnly(z.enum(["oauth", "apikey"])),
      }),
      outputs: z.object({
        ok: z.boolean(),
        ts: z.string(),
      }),
      async run({ channel, text }) {
        return { ok: true, ts: `${Date.now()}` };
      },
    });

    expect(slack.tool.params["channel"]).toMatchObject({ type: "string", required: true, visibility: "user-or-llm" });
    expect(slack.tool.params["accessToken"]).toMatchObject({ visibility: "hidden" });
    expect(slack.tool.params["authMethod"]).toMatchObject({ visibility: "user-only" });
    expect(slack.tool.outputs).toEqual({ ok: { type: "boolean" }, ts: { type: "string" } });
    // Hidden params are NOT included in subBlocks.
    expect(slack.block.subBlocks.find((s) => s.id === "accessToken")).toBeUndefined();
  });

  it("enforces visibility through applyOps — the LLM cannot land a hidden param", () => {
    const slack = defineConnector({
      type: "dx-slack",
      params: z.object({
        channel: z.string(),
        text: z.string(),
        accessToken: hidden(z.string()),
      }),
      outputs: z.object({ ok: z.boolean() }),
      async run() { return { ok: true }; },
    });
    const tools = new ToolRegistry();
    const blocks = new BlockRegistry();
    tools.register(slack.tool);
    blocks.register(slack.block);

    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      {
        operation_type: "add",
        block_id: "n",
        type: "dx-slack",
        params: { channel: "#x", text: "hi", accessToken: "stolen" },
      },
    ];
    // Need the trigger registered too:
    tools.register({ id: "__trigger__", name: "", description: "", params: {}, outputs: {}, async execute() { return {}; } });
    blocks.register({
      type: "trigger_webhook", name: "", description: "",
      category: "trigger", kind: "trigger",
      subBlocks: [], outputs: {},
      tools: { access: [], config: { tool: () => "__trigger__" } },
    });

    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const node = r.workflow.blocks.find((b) => b.id === "n")!;
    expect("accessToken" in node.params).toBe(false);
    expect(r.validation_errors.some((e) => (e as any).field === "accessToken")).toBe(true);
  });

  it("declared output schema drives reference validation — undeclared field errors structurally", () => {
    const fetch = defineConnector({
      type: "dx-fetch",
      params: z.object({ url: z.string() }),
      outputs: z.object({ status: z.number(), body: z.object({}).passthrough() }),
      async run() { return { status: 200, body: {} }; },
    });
    const echo = defineConnector({
      type: "dx-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    const tools = new ToolRegistry();
    const blocks = new BlockRegistry();
    tools.register(fetch.tool); tools.register(echo.tool);
    blocks.register(fetch.block); blocks.register(echo.block);
    tools.register({ id: "__trigger__", name: "", description: "", params: {}, outputs: {}, async execute() { return {}; } });
    blocks.register({
      type: "trigger_webhook", name: "", description: "",
      category: "trigger", kind: "trigger", subBlocks: [], outputs: {},
      tools: { access: [], config: { tool: () => "__trigger__" } },
    });

    const empty: SerializedWorkflow = { version: "1.0.0", blocks: [], connections: [] };
    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "f", type: "dx-fetch", params: { url: "https://example" } },
      // {{f.full_name}} doesn't exist — outputs only declare {status, body}.
      { operation_type: "add", block_id: "e", type: "dx-echo", params: { msg: "hi {{f.full_name}}" } },
      { operation_type: "connect", block_id: "trg", target_block_id: "f" },
      { operation_type: "connect", block_id: "f", target_block_id: "e" },
    ];
    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    const refErr = r.validation_errors.find((e) => e.block_id === "e");
    expect(refErr).toBeDefined();
    expect(refErr!.error).toMatch(/does not declare output 'full_name'/);
    expect(refErr!.error).toMatch(/Available: status, body/);
  });

  it("connector.run gets fully-typed params — the connector validates its input", async () => {
    const tool = defineConnector({
      type: "dx-typed",
      params: z.object({ count: z.number().int().min(0) }),
      outputs: z.object({ doubled: z.number() }),
      async run({ count }) {
        // count is `number` here — TS-checked.
        return { doubled: count * 2 };
      },
    });
    const ok = await tool.tool.execute({ count: 5 }, { env: {}, executionId: "x", blockId: "x", log: () => {} });
    expect(ok).toEqual({ doubled: 10 });
    // Bad input fails at the connector's own validation boundary.
    await expect(
      tool.tool.execute({ count: -1 }, { env: {}, executionId: "x", blockId: "x", log: () => {} }),
    ).rejects.toThrow(/dx-typed.*params validation failed/);
  });
});
