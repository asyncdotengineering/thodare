/**
 * The full DX win in one flow: createWfkit + defineConnector + workflow
 * builder + durable run, on Postgres.
 *
 * If this passes, a user can go from zero to a typed durable workflow in
 * 30 lines.
 */

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { randomUUID } from "node:crypto";
import {
  createWfkit,
  defineConnector,
  defineWorkflow,
  hidden,
  type Wfkit,
} from "../src/index.js";

const PG_URL = process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test";

let wfkit: Wfkit | null = null;
let testSchema = "";

async function newWfkit(): Promise<Wfkit> {
  testSchema = `wfkit_dx_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const backend = await BackendPostgres.connect(PG_URL, { schema: testSchema });
  const kit = await createWfkit({ backend });
  wfkit = kit;
  return kit;
}

afterEach(async () => {
  if (wfkit) {
    await wfkit.stop();
    const postgres = (await import("postgres")).default;
    const sql = postgres(PG_URL, { max: 1 });
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`); }
    finally { await sql.end({ timeout: 5 }); }
    wfkit = null;
  }
});

describe("createWfkit end-to-end", () => {
  it("zero to typed durable workflow in <30 LoC", async () => {
    // 1. Define a typed connector.
    const fakeApiCalls: Array<{ url: string; body: unknown }> = [];
    const fetchUser = defineConnector({
      type: "fetch-user",
      params: z.object({
        url: z.string(),
        body: z.object({ email: z.string() }),
      }),
      outputs: z.object({
        status: z.number(),
        body: z.object({ name: z.string(), company: z.string() }),
      }),
      async run({ url, body }) {
        fakeApiCalls.push({ url, body });
        return { status: 200, body: { name: "Alice Example", company: "Acme" } };
      },
    });

    const sentMessages: Array<{ channel: string; text: string }> = [];
    const slackSend = defineConnector({
      type: "slack-send",
      params: z.object({
        channel: z.string(),
        text: z.string(),
        accessToken: hidden(z.string()).default("placeholder"),
      }),
      outputs: z.object({ ok: z.boolean(), ts: z.string() }),
      async run({ channel, text }) {
        sentMessages.push({ channel, text });
        return { ok: true, ts: `${Date.now() / 1000}` };
      },
    });

    // 2. Build a workflow with typed step references.
    const wf = defineWorkflow("dx-e2e-lead")
      .input(z.object({ email: z.string() }))
      .step("enrich", fetchUser, ({ input }) => ({
        url: "https://api.example.com/enrich",
        body: { email: input.email },
      }))
      .step("notify", slackSend, ({ input, enrich }) => ({
        channel: "#sales",
        text: `Lead ${enrich.body.name} at ${enrich.body.company} (${input.email})`,
      }))
      .build();

    // 3. Wire and run.
    const kit = await newWfkit();
    kit.register(fetchUser, slackSend);
    const compiled = kit.compile(wf);
    await kit.start();

    const handle = await kit.run(compiled, { email: "alice@x.com" });
    const out = (await handle.result()) as { outputs: Record<string, any> };

    // 4. Verify everything threaded through.
    expect(fakeApiCalls).toEqual([
      { url: "https://api.example.com/enrich", body: { email: "alice@x.com" } },
    ]);
    expect(sentMessages).toEqual([
      { channel: "#sales", text: "Lead Alice Example at Acme (alice@x.com)" },
    ]);
    expect(out.outputs["enrich"].body.name).toBe("Alice Example");
    expect(out.outputs["notify"].ok).toBe(true);
  });

  it("createWfkit refuses register/compile after start() — clear error", async () => {
    const kit = await newWfkit();
    await kit.start();
    expect(() => kit.register(defineConnector({
      type: "z", params: z.object({}), outputs: z.object({}),
      async run() { return {}; },
    }))).toThrow(/cannot be called after start/);
    expect(() => kit.compile({ version: "1", blocks: [], connections: [] })).toThrow(/cannot be called after start/);
  });

  it("applyOps via the kit returns the same shape as the lower-level applyOperations", async () => {
    const kit = await newWfkit();
    kit.register(defineConnector({
      type: "noop",
      params: z.object({}),
      outputs: z.object({ ok: z.boolean() }),
      async run() { return { ok: true }; },
    }));
    const r = kit.applyOps(
      { version: "1.0.0", blocks: [], connections: [] },
      [
        { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
        { operation_type: "add", block_id: "n", type: "noop", params: {} },
        // unknown block → typed skip
        { operation_type: "add", block_id: "ghost", type: "definitely-not-real", params: {} },
        { operation_type: "connect", block_id: "trg", target_block_id: "n" },
      ],
    );
    expect(r.skipped_items.find((s) => s.reason_code === "block_type_not_registered")).toBeDefined();
    expect(r.workflow.blocks.find((b) => b.id === "n")).toBeDefined();
  });
});
