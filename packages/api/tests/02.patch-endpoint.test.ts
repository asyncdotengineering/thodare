/**
 * C-2: POST /api/workflows/:id/operations — the LLM patch loop endpoint.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, hidden } from "@thodare/engine";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

const httpC = defineConnector({
  type: "http",
  params: z.object({
    url: z.string(),
    method: z.string().optional(),
    body: z.object({}).passthrough().optional(),
  }),
  outputs: z.object({
    status: z.number(),
    body: z.object({}).passthrough(),
  }),
  async run({ url }) { return { status: 200, body: { name: "Alice" } }; },
});

const slackC = defineConnector({
  type: "slack",
  params: z.object({
    channel: z.string(),
    text: z.string(),
    accessToken: hidden(z.string()).default("xoxb-test"),
  }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async run({ channel }) { return { ok: true, ts: `${Date.now()}` }; },
});

async function createWf(h: ApiHarness): Promise<{ id: string; version: number }> {
  const r = await h.fetch("/api/workflows", {
    method: "POST",
    headers: { ...withAuth(h.token), "content-type": "application/json" },
    body: JSON.stringify({ metadata: { name: "test-flow" } }),
  });
  return (await r.json()) as { id: string; version: number };
}

describe("POST /api/workflows/:id/operations — LLM patch loop", () => {
  it("applies a clean patch and increments version", async () => {
    h = await newApiHarness({ connectors: [httpC, slackC] });
    const wf = await createWf(h);
    const r = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
          { operation_type: "add", block_id: "fetch", type: "http", params: { url: "https://x" } },
          { operation_type: "connect", block_id: "trg", target_block_id: "fetch" },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; version: number; workflow: any };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(2);
    expect(body.workflow.blocks.find((b: any) => b.id === "fetch")).toBeDefined();
  });

  it("returns 200 with skipped_items + validation_errors when ops have issues", async () => {
    h = await newApiHarness({ connectors: [httpC, slackC] });
    const wf = await createWf(h);
    const r = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
          // unknown block type → typed skip
          { operation_type: "add", block_id: "ghost", type: "definitely-not-real", params: {} },
          { operation_type: "add", block_id: "fetch", type: "http", params: { url: "https://x" } },
          // bad ref: http only declares status/body/headers
          { operation_type: "add", block_id: "say", type: "slack",
            params: { channel: "#x", text: "{{fetch.full_name}}" } },
          { operation_type: "connect", block_id: "trg", target_block_id: "fetch" },
          { operation_type: "connect", block_id: "fetch", target_block_id: "say" },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      skipped_items: Array<{ reason_code: string }>;
      validation_errors: Array<{ error: string }>;
      version: number;
    };
    expect(body.ok).toBe(false);
    expect(body.skipped_items.some((s) => s.reason_code === "block_type_not_registered")).toBe(true);
    expect(body.validation_errors.some((e) => /full_name/.test(e.error))).toBe(true);
    // The workflow still updates (with the skipped op excluded). Version increments.
    expect(body.version).toBe(2);
  });

  it("hidden params smuggled in a patch are stripped — defense in depth at the API boundary", async () => {
    h = await newApiHarness({ connectors: [httpC, slackC] });
    const wf = await createWf(h);
    const r = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
          { operation_type: "add", block_id: "say", type: "slack",
            params: { channel: "#x", text: "hi", accessToken: "STOLEN" } },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { workflow: any };
    const say = body.workflow.blocks.find((b: any) => b.id === "say");
    expect("accessToken" in say.params).toBe(false);
  });

  it("If-Match with stale version returns 412 with current version", async () => {
    h = await newApiHarness({ connectors: [httpC] });
    const wf = await createWf(h);
    // First patch advances version 1 → 2.
    await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({
        ops: [{ operation_type: "add", block_id: "a", type: "http", params: { url: "https://x" } }],
      }),
    });
    // Second patch with stale If-Match=1 should 412.
    const r = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({
        ops: [{ operation_type: "add", block_id: "b", type: "http", params: { url: "https://y" } }],
      }),
    });
    expect(r.status).toBe(412);
    const body = (await r.json()) as { error: string; current: number };
    expect(body.error).toBe("version_mismatch");
    expect(body.current).toBe(2);
  });

  it("404 when patching a workflow that doesn't exist", async () => {
    h = await newApiHarness({ connectors: [httpC] });
    const r = await h.fetch(`/api/workflows/00000000-0000-0000-0000-000000000000/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ ops: [] }),
    });
    expect(r.status).toBe(404);
  });

  it("invalid body — missing ops field — returns 400", async () => {
    h = await newApiHarness({ connectors: [httpC] });
    const wf = await createWf(h);
    const r = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ noops: true }),
    });
    expect(r.status).toBe(400);
  });

  it("EditOp with unknown operation_type rejected at body validation (Zod)", async () => {
    h = await newApiHarness({ connectors: [httpC] });
    const wf = await createWf(h);
    const r = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ operation_type: "execute", code: "rm -rf /" }],
      }),
    });
    expect(r.status).toBe(400);
  });
});
