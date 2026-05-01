/**
 * The hero demo: wfkit's two-round LLM repair loop, with the resulting
 * workflow executed on the durable openworkflow runtime instead of in
 * memory. Same DSL, same patch tool, durability for free.
 *
 * Run it:
 *   npm run demo
 *
 * (Equivalent to `tsx examples/llm-round-trip-durable.ts` from this package.)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenWorkflow } from "@thodare/openworkflow";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";
import {
  applyOperations,
  BlockRegistry,
  buildDurableWorkflow,
  registerBuiltinBlocks,
  registerBuiltinTools,
  registerWaitTools,
  ToolRegistry,
  type EditOp,
  type SerializedWorkflow,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "wfkit-d-demo-"));
const dbPath = join(dir, "ow.sqlite");
const backend = BackendSqlite.connect(dbPath);
const ow = new OpenWorkflow({ backend });

const tools = new ToolRegistry();
const blocks = new BlockRegistry();
registerBuiltinTools(tools);
registerWaitTools(tools);
registerBuiltinBlocks(blocks);

// Mock the http tool so the demo doesn't hit the network.
tools.get("http_request")!.execute = async (params) => {
  console.log(`  [mock-http] ${params.method ?? "GET"} ${params.url}`);
  return {
    status: 200,
    body: { name: "Alice Example", company: "Acme Inc", score: 87 },
    headers: {},
  };
};

const empty: SerializedWorkflow = {
  version: "1.0.0",
  metadata: { name: "wf-llm-durable" },
  blocks: [],
  connections: [],
};

/* ─── ROUND 1: LLM emits 6 ops with 2 intentional mistakes ─── */
const round1: EditOp[] = [
  { operation_type: "add", block_id: "trg", type: "trigger_webhook", name: "Webhook", params: { path: "/leads" } },
  {
    operation_type: "add",
    block_id: "enrich",
    type: "http",
    name: "Enrich Lead",
    params: { url: "https://api.example.com/enrich", method: "POST", body: { email: "{{trigger.body.email}}" } },
  },
  // Hallucinated block type
  { operation_type: "add", block_id: "lookup", type: "salesforce_lookup", params: {} },
  // Bad reference: enrich.full_name is not a declared output
  {
    operation_type: "add",
    block_id: "notify",
    type: "slack",
    name: "Notify Sales",
    params: { operation: "send", channel: "#sales", text: "New lead: {{enrich.full_name}} ({{trigger.body.email}})" },
  },
  { operation_type: "connect", block_id: "trg", target_block_id: "enrich" },
  { operation_type: "connect", block_id: "enrich", target_block_id: "notify" },
];

console.log("\n══════════ ROUND 1 (LLM submits patches with 2 mistakes) ══════════");
const r1 = applyOperations({ workflow: empty, ops: round1, blockRegistry: blocks, toolRegistry: tools });
console.log(r1.summary);
console.log(`ok=${r1.ok}  skipped=${r1.skipped_items.length}  errors=${r1.validation_errors.length}`);

/* ─── ROUND 2: LLM corrects based on structured feedback ─── */
const round2: EditOp[] = [
  {
    operation_type: "edit",
    block_id: "notify",
    params: { text: "New lead: {{enrich.body.name}} ({{trigger.body.email}})" },
  },
];

console.log("\n══════════ ROUND 2 (LLM fix-up patch) ══════════");
const r2 = applyOperations({ workflow: r1.workflow, ops: round2, blockRegistry: blocks, toolRegistry: tools });
console.log(r2.summary);
console.log(`ok=${r2.ok}`);

console.log("\n══════════ FINAL WORKFLOW JSON ══════════");
console.log(JSON.stringify(r2.workflow, null, 2));

/* ─── EXECUTE ON THE DURABLE RUNTIME ─── */
console.log("\n══════════ DURABLE EXECUTION (openworkflow + SQLite) ══════════");
const compiled = buildDurableWorkflow({
  ow,
  backend,
  blockRegistry: blocks,
  toolRegistry: tools,
  workflow: r2.workflow,
  env: { SLACK_BOT_TOKEN: "xoxb-fake" },
});
const worker = ow.newWorker({ concurrency: 2 });
await worker.start();

const handle = await compiled.run({ body: { email: "alice@example.com" } });
const result = (await handle.result()) as { outputs: Record<string, unknown> };

console.log("\n══════════ FINAL OUTPUTS ══════════");
console.log(JSON.stringify(result.outputs, null, 2));

await worker.stop();
await backend.stop();
rmSync(dir, { recursive: true, force: true });
console.log("\nDone.");
