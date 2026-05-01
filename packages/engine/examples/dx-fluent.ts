/**
 * The hero demo, rewritten with the new fluent / typed API.
 *
 * Compare with examples/llm-round-trip-durable.ts (the imperative version).
 * Same outcome — but here the workflow is built with full TypeScript
 * inference: every reference is typed, every connector's run() is typed,
 * every visibility flag lives on its Zod schema.
 *
 * Run with:  npm run demo:dx
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";
import {
  createWfkit,
  defineConnector,
  defineWorkflow,
  hidden,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "wfkit-dx-"));
const dbPath = join(dir, "ow.sqlite");
const backend = BackendSqlite.connect(dbPath);

// ── 1. Connectors. Each is ONE typed declaration. ──────────────────────

const enrichLead = defineConnector({
  type: "enrich-lead",
  description: "Enrich a lead from a CRM-like upstream API",
  params: z.object({
    email: z.string(),
  }),
  outputs: z.object({
    name: z.string(),
    company: z.string(),
    score: z.number(),
  }),
  async run({ email }, ctx) {
    ctx.log("info", `[enrich-lead] looking up ${email}`);
    return { name: "Alice Example", company: "Acme Inc", score: 87 };
  },
});

const notifySales = defineConnector({
  type: "notify-sales",
  description: "Post a Slack message to the sales channel",
  params: z.object({
    channel: z.string(),
    text: z.string(),
    // The LLM literally cannot put accessToken into workflow JSON — the
    // visibility brand strips it at applyOps time.
    accessToken: hidden(z.string()).default("xoxb-placeholder"),
  }),
  outputs: z.object({
    ok: z.boolean(),
    ts: z.string(),
  }),
  async run({ channel, text }) {
    // (mocked) — real impl hits chat.postMessage
    return { ok: true, ts: `${Date.now() / 1000}` };
  },
});

// ── 2. Build the workflow with FULL type safety. ────────────────────────

const wf = defineWorkflow("dx-lead-notifier")
  .input(z.object({ email: z.string() }))
  .step("enrich", enrichLead, ({ input }) => ({
    email: input.email, // ← typed: input.email is string
  }))
  .step("notify", notifySales, ({ input, enrich }) => ({
    channel: "#sales",
    // Both refs autocomplete from the connectors' Zod output schemas.
    text: `Lead ${enrich.name} at ${enrich.company} (${input.email}, score ${enrich.score})`,
  }))
  .build();

// ── 3. Run. ────────────────────────────────────────────────────────────

const wfkit = await createWfkit({ backend });
wfkit.register(enrichLead, notifySales);
const compiled = wfkit.compile(wf);
await wfkit.start();

const handle = await wfkit.run(compiled, { email: "alice@example.com" });
const out = (await handle.result()) as { outputs: Record<string, unknown> };

console.log("\n══════════ WORKFLOW JSON (the wire format the LLM emits) ══════════");
console.log(JSON.stringify(wf, null, 2));

console.log("\n══════════ OUTPUTS ══════════");
console.log(JSON.stringify(out.outputs, null, 2));

await wfkit.stop();
rmSync(dir, { recursive: true, force: true });
console.log("\nDone.");
