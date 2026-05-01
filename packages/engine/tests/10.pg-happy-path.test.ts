import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  applyOperations,
  buildDurableWorkflow,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newPgDurableHarness, type PgDurableHarness } from "./_durable-pg-harness.js";

let h: PgDurableHarness;
afterEach(async () => { await h.dispose(); });

beforeAll(async () => {
  // Sanity: ensure the local PG is reachable. If not, the suite fails fast
  // with a clear message instead of timing out per-test.
  try {
    h = await newPgDurableHarness();
  } catch (e: any) {
    throw new Error(
      `Cannot reach local Postgres. Run \`createdb wfkit_durable_test\` first, or set WFKIT_DURABLE_PG_URL. Underlying error: ${e?.message ?? e}`,
    );
  }
  await h.dispose();
});

describe("Postgres backend: happy path", () => {
  it("runs trigger → http → slack on openworkflow + Postgres", async () => {
    h = await newPgDurableHarness();
    const { tools, blocks } = freshRegistries();

    tools.get("http_request")!.execute = async () => ({
      status: 200,
      body: { name: "Alice Example", company: "Acme Inc", score: 87 },
      headers: {},
    });

    const empty: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: `wf-pg-happy-${h.schema}` },
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
