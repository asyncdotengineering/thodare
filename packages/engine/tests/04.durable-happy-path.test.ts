import { describe, it, expect, afterEach } from "vitest";
import {
  applyOperations,
  buildDurableWorkflow,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

let h: DurableHarness;
afterEach(async () => { await h.dispose(); });

describe("durable runtime: happy path", () => {
  it("runs trigger → http → slack on openworkflow with mocked tools", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    // Mock the http tool deterministically.
    tools.get("http_request")!.execute = async () => ({
      status: 200,
      body: { name: "Alice Example", company: "Acme Inc", score: 87 },
      headers: {},
    });

    const empty: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-durable-happy" },
      blocks: [],
      connections: [],
    };

    const ops: EditOp[] = [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", name: "Webhook", params: {} },
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
      {
        operation_type: "add",
        block_id: "notify",
        type: "slack",
        name: "Notify Sales",
        params: {
          operation: "send",
          channel: "#sales",
          text: "New lead: {{enrich.body.name}} ({{trigger.body.email}})",
        },
      },
      { operation_type: "connect", block_id: "trg", target_block_id: "enrich" },
      { operation_type: "connect", block_id: "enrich", target_block_id: "notify" },
    ];

    const r = applyOperations({ workflow: empty, ops, blockRegistry: blocks, toolRegistry: tools });
    expect(r.ok).toBe(true);

    const wf = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: r.workflow,
      env: { SLACK_BOT_TOKEN: "xoxb-fake" },
    });
    await h.startWorker();

    const handle = await wf.run({ body: { email: "alice@example.com" } });
    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["enrich"].body.name).toBe("Alice Example");
    expect(out.outputs["notify"]._text).toBe("New lead: Alice Example (alice@example.com)");
  });
});
