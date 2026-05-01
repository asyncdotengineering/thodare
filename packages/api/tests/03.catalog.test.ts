/**
 * C-3: GET /api/connectors and /:type — for LLM system prompt + RAG.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, hidden } from "@thodare/engine";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

// Use connector types that don't collide with builtins.
const slack = defineConnector({
  type: "slack-cat",
  description: "Send messages to Slack",
  params: z.object({
    channel: z.string().describe("Channel ID like C123 or #channel"),
    text: z.string(),
    accessToken: hidden(z.string()),
  }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async run() { return { ok: true, ts: "1" }; },
});

const httpC = defineConnector({
  type: "http-cat",
  description: "Make an HTTP request",
  params: z.object({ url: z.string() }),
  outputs: z.object({ status: z.number(), body: z.object({}).passthrough() }),
  async run() { return { status: 200, body: {} }; },
});

describe("connector catalog", () => {
  it("GET /api/connectors lists every registered block (type, name, description, category, kind)", async () => {
    h = await newApiHarness({ connectors: [slack, httpC] });
    const r = await h.fetch("/api/connectors", { headers: withAuth(h.token) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: Array<{ type: string; name: string; description: string; category: string; kind: string }> };
    const types = body.data.map((d) => d.type);
    expect(types).toContain("slack-cat");
    expect(types).toContain("http-cat");
    // Built-ins should also be there.
    expect(types).toContain("wait_duration");
    expect(types).toContain("trigger_webhook");
    // Each entry has required fields populated.
    const slackEntry = body.data.find((d) => d.type === "slack-cat")!;
    expect(slackEntry.description).toBe("Send messages to Slack");
    expect(slackEntry.kind).toBe("compute");
  });

  it("GET /api/connectors/:type returns full metadata", async () => {
    h = await newApiHarness({ connectors: [slack] });
    const r = await h.fetch("/api/connectors/slack-cat", { headers: withAuth(h.token) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      type: string;
      subBlocks: Array<{ id: string }>;
      outputs: Record<string, { type: string }>;
    };
    expect(body.type).toBe("slack-cat");
    // Outputs visible.
    expect(body.outputs).toEqual({
      ok: { type: "boolean" },
      ts: { type: "string" },
    });
    // subBlocks include channel and text but NOT accessToken (it's hidden).
    const subIds = body.subBlocks.map((s) => s.id);
    expect(subIds).toContain("channel");
    expect(subIds).toContain("text");
    expect(subIds).not.toContain("accessToken");
  });

  it("hidden params NEVER appear in the catalog response (LLM never learns about them)", async () => {
    h = await newApiHarness({ connectors: [slack] });
    const r = await h.fetch("/api/connectors/slack-cat", { headers: withAuth(h.token) });
    const body = (await r.json()) as unknown;
    // Walk the entire response tree and assert "accessToken" never appears.
    const json = JSON.stringify(body);
    expect(json).not.toContain("accessToken");
  });

  it("GET /api/connectors/:type with unknown type returns 404", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/connectors/totally-not-real", { headers: withAuth(h.token) });
    expect(r.status).toBe(404);
  });
});
