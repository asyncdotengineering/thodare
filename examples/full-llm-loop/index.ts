/**
 * Full LLM-loop demo against the @thodare/api over HTTP.
 *
 * What this demonstrates end-to-end:
 *
 *   1. Boot the API (per-run Postgres schema, in-memory token).
 *   2. POST /api/workflows               → create empty workflow
 *   3. POST /api/workflows/:id/operations → first patch with INTENTIONAL mistakes
 *      (an unknown block type + a self-cycle). The response shows
 *      `ok=false` with `skipped_items` describing exactly what the LLM
 *      should fix. This is the feedback the agent sees as tool output.
 *   4. POST /api/workflows/:id/operations → fix-up patch. `ok=true`.
 *   5. POST /api/workflows/:id/run        → dispatch a real run.
 *   6. GET /api/runs/:runId               → poll until completed.
 *   7. Print the run's outputs.
 *   8. Tear down (drop schema).
 *
 * Run against a Postgres reachable from the local machine:
 *
 *   createdb wfkit_durable_test
 *   bun examples/full-llm-loop.ts
 *
 * Override the connection: WFKIT_DURABLE_PG_URL=postgres://… bun ...
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { createWfkit, defineConnector } from "@thodare/engine";
import { createControlPlaneApi } from "../src/index.js";

const PG_URL = process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test";
const TOKEN = "demo-token";
const SCHEMA = `cpa_demo_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

// Pretty-printer helper.
const log = (label: string, value: unknown) => {
  process.stdout.write(`\n── ${label} ──\n`);
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  process.stdout.write("\n");
};

// A trivial connector the demo workflow will call.
const greet = defineConnector({
  type: "greet",
  description: "Returns 'hello, <name>'.",
  params: z.object({ name: z.string() }),
  outputs: z.object({ message: z.string() }),
  async run({ name }) {
    return { message: `hello, ${name}` };
  },
});

async function main() {
  process.stdout.write(`▶ Booting API on schema=${SCHEMA}\n`);

  const backend = await BackendPostgres.connect(PG_URL, { schema: SCHEMA });
  const wfkit = await createWfkit({ backend });
  wfkit.register(greet);

  const api = await createControlPlaneApi({
    pgUrl: PG_URL,
    schema: SCHEMA,
    wfkit,
    tokens: [TOKEN],
    rateLimitPerMin: 1000,
  });
  await wfkit.start();

  // app.fetch is Hono's standard test path — same surface as a real HTTP server.
  const fetch = (path: string, init: RequestInit = {}) =>
    api.app.fetch(new Request(`http://demo${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    }));

  const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;

  try {
    // ─── 1. Create empty workflow.
    const created = await json<{ id: string; version: number }>(
      await fetch("/api/workflows", { method: "POST", body: "{}" }),
    );
    log("created workflow", created);

    // ─── 2. First patch — INTENTIONALLY broken.
    //   - "totally-unknown-block" doesn't exist (not in the connector catalog)
    //   - we connect a block to itself (cycle)
    const broken = await json<{
      ok: boolean;
      version: number;
      validation_errors: unknown[];
      skipped_items: Array<{ reason_code: string; reason: string }>;
      summary: string;
    }>(
      await fetch(`/api/workflows/${created.id}/operations`, {
        method: "POST",
        body: JSON.stringify({
          ops: [
            { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
            { operation_type: "add", block_id: "g", type: "totally-unknown-block", params: { name: "Ada" } },
            { operation_type: "connect", block_id: "g", target_block_id: "g" },
          ],
        }),
      }),
    );
    log("first patch (intentionally broken) — ok", broken.ok);
    log("first patch — skipped_items", broken.skipped_items);
    log("first patch — summary", broken.summary);

    // ─── 3. Fix-up patch. The LLM, seeing skipped_items, reasons:
    //   "totally-unknown-block" → I should use "greet"
    //   self-cycle             → connect trigger → greet instead.
    // We send the corrective ops with If-Match for optimistic concurrency.
    const fixed = await json<{ ok: boolean; version: number; summary: string }>(
      await fetch(`/api/workflows/${created.id}/operations`, {
        method: "POST",
        headers: { "if-match": String(broken.version) },
        body: JSON.stringify({
          ops: [
            { operation_type: "add", block_id: "g", type: "greet", params: { name: "Ada" } },
            { operation_type: "connect", block_id: "trg", target_block_id: "g" },
          ],
        }),
      }),
    );
    log("fix-up patch — ok", fixed.ok);
    log("fix-up patch — version", fixed.version);
    log("fix-up patch — summary", fixed.summary);

    // ─── 4. Dispatch a run.
    const dispatched = await json<{ runId: string; spec: string }>(
      await fetch(`/api/workflows/${created.id}/run`, {
        method: "POST",
        body: JSON.stringify({ input: { greeting: "hello there" } }),
      }),
    );
    log("dispatched run", dispatched);

    // ─── 5. Poll for completion.
    const deadline = Date.now() + 8_000;
    let run: { state: string; output?: { outputs?: Record<string, unknown> } } | null = null;
    while (Date.now() < deadline) {
      run = await json(
        await fetch(`/api/runs/${dispatched.runId}`),
      );
      if (run!.state === "completed" || run!.state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    log("final run state", run?.state);
    log("final run outputs", run?.output?.outputs);

    if (run?.state !== "completed") {
      throw new Error(`run did not complete: ${JSON.stringify(run)}`);
    }
    process.stdout.write("\n✓ end-to-end LLM loop succeeded\n");
  } finally {
    process.stdout.write("\n▶ Tearing down\n");
    try { await api.dispose(); } catch {}
    try { await wfkit.stop(); } catch {}
    const sql = postgres(PG_URL, { max: 1 });
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); }
    finally { await sql.end({ timeout: 5 }); }
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ demo failed: ${err.stack ?? err}\n`);
  process.exit(1);
});
