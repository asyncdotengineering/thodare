/**
 * Real wall-clock multi-wait demo.
 *
 * Workflow shape:
 *   trg → start → wait_duration(W1) → tick5 → wait_duration(W2) → tick10 →
 *   wait_duration(W3) → done
 *
 * Default durations are 5m / 5m / 5m (cumulative 5 / 10 / 15 min). Override
 * with WAIT_SECONDS_LIST="300,300,300" to test other shapes — e.g. "30,30,30"
 * for a 90-second smoke version.
 *
 * Output:
 *   - Every milestone is logged to stdout with absolute ISO timestamp AND
 *     elapsed seconds since start. Each line is also appended to LOG_PATH
 *     so a Monitor can stream it.
 *   - At RESTART_AT_SECONDS into the run (default off), the worker is
 *     stopped and restarted. The run must continue from where it left off.
 *
 * Backend: Postgres (the production target). Schema is dropped on exit
 * unless KEEP_SCHEMA=1 is set.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { OpenWorkflow } from "@thodare/openworkflow";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { randomUUID } from "node:crypto";
import {
  BlockRegistry,
  ToolRegistry,
  buildDurableWorkflow,
  registerBuiltinBlocks,
  registerBuiltinTools,
  registerWaitTools,
  type SerializedWorkflow,
  type Tool,
} from "../src/index.js";

const PG_URL = process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test";
const WAIT_SECONDS = (process.env.WAIT_SECONDS_LIST ?? "300,300,300").split(",").map(Number);
const RESTART_AT = process.env.RESTART_AT_SECONDS ? Number(process.env.RESTART_AT_SECONDS) : 0;
const LOG_PATH = process.env.LOG_PATH ?? "/tmp/wfkit-multiwait.log";
const KEEP_SCHEMA = process.env.KEEP_SCHEMA === "1";

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
const isoNow = () => new Date().toISOString();

writeFileSync(LOG_PATH, "", "utf8");
function log(line: string): void {
  const stamped = `[${isoNow()}] [+${elapsed()}s] ${line}`;
  // eslint-disable-next-line no-console
  console.log(stamped);
  appendFileSync(LOG_PATH, stamped + "\n", "utf8");
}

log(`durations (sec): ${WAIT_SECONDS.join(", ")}  total = ${WAIT_SECONDS.reduce((a, b) => a + b, 0)}s`);
log(`restart at (sec): ${RESTART_AT > 0 ? RESTART_AT : "(none)"}`);
log(`log path: ${LOG_PATH}`);
log(`pg url: ${PG_URL}`);

const schema = `wfkit_demo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
log(`pg schema: ${schema}`);

const backend = await BackendPostgres.connect(PG_URL, { schema });
const ow = new OpenWorkflow({ backend });

const tools = new ToolRegistry();
const blocks = new BlockRegistry();
registerBuiltinTools(tools);
registerWaitTools(tools);
registerBuiltinBlocks(blocks);

// Custom "tick" tool that logs an event with the elapsed time.
const tickTool: Tool = {
  id: "tick",
  name: "Tick",
  description: "Logs a milestone with current elapsed time.",
  params: { label: { type: "string", required: true, visibility: "user-or-llm" } },
  outputs: { at: { type: "string" }, elapsedSec: { type: "number" } },
  async execute(p) {
    const at = isoNow();
    const e = (Date.now() - t0) / 1000;
    log(`★ TICK "${p.label}" at ${at}`);
    return { at, elapsedSec: e };
  },
};
tools.register(tickTool);
blocks.register({
  type: "tick_block",
  name: "Tick",
  description: "Milestone log",
  category: "tools",
  kind: "compute",
  subBlocks: [{ id: "label", title: "Label", type: "short-input", required: true }],
  outputs: tickTool.outputs,
  tools: { access: ["tick"], config: { tool: () => "tick" } },
});

const wf: SerializedWorkflow = {
  version: "1.0.0",
  metadata: { name: `wf-multiwait-${schema}` },
  blocks: [
    { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
    { id: "start", type: "tick_block", enabled: true, params: { label: "start" } },
    {
      id: "w1",
      type: "wait_duration",
      enabled: true,
      params: { duration: WAIT_SECONDS[0], unit: "seconds" },
    },
    { id: "tick1", type: "tick_block", enabled: true, params: { label: "after-w1" } },
    {
      id: "w2",
      type: "wait_duration",
      enabled: true,
      params: { duration: WAIT_SECONDS[1], unit: "seconds" },
    },
    { id: "tick2", type: "tick_block", enabled: true, params: { label: "after-w2" } },
    {
      id: "w3",
      type: "wait_duration",
      enabled: true,
      params: { duration: WAIT_SECONDS[2], unit: "seconds" },
    },
    { id: "done", type: "tick_block", enabled: true, params: { label: "done" } },
  ],
  connections: [
    { source: "trg", target: "start" },
    { source: "start", target: "w1" },
    { source: "w1", target: "tick1" },
    { source: "tick1", target: "w2" },
    { source: "w2", target: "tick2" },
    { source: "tick2", target: "w3" },
    { source: "w3", target: "done" },
  ],
};

const compiled = buildDurableWorkflow({
  ow,
  backend,
  blockRegistry: blocks,
  toolRegistry: tools,
  workflow: wf,
});

let worker = ow.newWorker({ concurrency: 2 });
await worker.start();
log(`worker started (pid ${process.pid})`);

const handle = await compiled.run({});
log(`workflow run created`);

// Optional mid-flight restart.
if (RESTART_AT > 0) {
  setTimeout(async () => {
    log(`>>> simulating crash: stopping worker at +${RESTART_AT}s`);
    try { await worker.stop(); } catch (e) { log(`stop error: ${String(e)}`); }
    log(`>>> worker stopped, sleeping 5s before restart`);
    await new Promise((r) => setTimeout(r, 5000));
    worker = ow.newWorker({ concurrency: 2 });
    await worker.start();
    log(`>>> worker restarted — run should continue durably from PG state`);
  }, RESTART_AT * 1000).unref();
}

// Heartbeat every 30s so the log shows we're still alive during long pauses.
const hb = setInterval(() => {
  log(`heartbeat — still running, +${elapsed()}s elapsed`);
}, 30_000);
hb.unref();

// CRITICAL: openworkflow's `WorkflowRunHandle.result()` defaults to a
// hardcoded 5-minute timeout. Any workflow longer than that needs an
// explicit override. We pass total expected duration + 5 min slack.
const expectedMs = WAIT_SECONDS.reduce((a, b) => a + b, 0) * 1000 + 5 * 60 * 1000;
const result = (await (handle as any).result({ timeoutMs: expectedMs })) as { outputs: Record<string, unknown> };
clearInterval(hb);
log(`★ DONE result.outputs.done = ${JSON.stringify(result.outputs["done"])}`);
log(`total elapsed: ${elapsed()}s`);

await worker.stop();
await backend.stop();

if (!KEEP_SCHEMA) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(PG_URL, { max: 1 });
  try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await sql.end({ timeout: 5 }); }
  log(`dropped schema ${schema}`);
}
log(`bye`);
