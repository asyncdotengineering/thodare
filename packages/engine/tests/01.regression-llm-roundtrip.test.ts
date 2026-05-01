import { describe, it, expect } from "vitest";
import {
  applyOperations,
  execute,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";

/**
 * Regression: the original wfkit demo flow.
 *
 * Round 1 — LLM emits 6 ops with two intentional mistakes.
 *   - Hallucinated block type 'salesforce_lookup' → must SKIP (typed reason).
 *   - References '{{enrich.full_name}}' (not a declared output) → must EMIT
 *     a structured validation error.
 *
 * Round 2 — LLM submits a 1-op edit fixing the bad reference. Workflow now
 * applies cleanly.
 *
 * Execution — runs against a mocked http tool; outputs flow correctly.
 */
describe("LLM round-trip regression", () => {
  it("rejects hallucinated block type and bad ref, accepts the patch, then executes", async () => {
    const { tools, blocks } = freshRegistries();

    const empty: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "New Lead Notifier" },
      blocks: [],
      connections: [],
    };

    const round1: EditOp[] = [
      {
        operation_type: "add",
        block_id: "trg",
        type: "trigger_webhook",
        name: "Webhook",
        params: { path: "/leads" },
      },
      {
        operation_type: "add",
        block_id: "enrich",
        type: "http",
        name: "Enrich Lead",
        params: {
          url: "https://api.example.com/enrich",
          method: "POST",
          body: { email: "{{trigger.body.email}}" },
        },
      },
      // hallucinated
      {
        operation_type: "add",
        block_id: "lookup",
        type: "salesforce_lookup",
        params: { email: "{{trigger.body.email}}" },
      },
      // bad reference {{enrich.full_name}}
      {
        operation_type: "add",
        block_id: "notify",
        type: "slack",
        name: "Notify Sales",
        params: {
          operation: "send",
          channel: "#sales",
          text: "New lead: {{enrich.full_name}} ({{trigger.body.email}})",
        },
      },
      { operation_type: "connect", block_id: "trg", target_block_id: "enrich" },
      { operation_type: "connect", block_id: "enrich", target_block_id: "notify" },
    ];

    const r1 = applyOperations({ workflow: empty, ops: round1, blockRegistry: blocks, toolRegistry: tools });

    // The hallucinated block was skipped with the right reason code.
    expect(r1.skipped_items).toHaveLength(1);
    expect(r1.skipped_items[0]).toMatchObject({
      reason_code: "block_type_not_registered",
      operation_type: "add",
      block_id: "lookup",
    });

    // The bad reference produced a structured validation error pointing at
    // the actual available outputs.
    const refErr = r1.validation_errors.find((e) => e.block_id === "notify");
    expect(refErr).toBeDefined();
    expect(refErr!.error).toMatch(/does not declare output 'full_name'/);
    expect(refErr!.error).toMatch(/Available: status, body, headers/);

    // Round 2: 1-op patch fixing the reference.
    const r2 = applyOperations({
      workflow: r1.workflow,
      ops: [
        {
          operation_type: "edit",
          block_id: "notify",
          params: { text: "New lead: {{enrich.body.name}} ({{trigger.body.email}})" },
        },
      ],
      blockRegistry: blocks,
      toolRegistry: tools,
    });
    expect(r2.ok).toBe(true);
    expect(r2.skipped_items).toHaveLength(0);
    expect(r2.validation_errors).toHaveLength(0);

    // Execute against a mocked http tool; ensure refs resolve correctly.
    tools.get("http_request")!.execute = async () => ({
      status: 200,
      body: { name: "Alice Example", company: "Acme Inc", score: 87 },
      headers: {},
    });

    const result = await execute({
      workflow: r2.workflow,
      toolRegistry: tools,
      blockRegistry: blocks,
      trigger: { body: { email: "alice@example.com" } },
      env: { SLACK_BOT_TOKEN: "xoxb-fake" },
    });

    expect(result.success).toBe(true);
    expect(result.paused).toBeFalsy();

    const slack = result.outputs["notify"] as { _text?: string; channel?: string };
    expect(slack.channel).toBe("#sales");
    expect(slack._text).toBe("New lead: Alice Example (alice@example.com)");
  });
});
