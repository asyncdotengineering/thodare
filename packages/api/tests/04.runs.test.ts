/**
 * C-4: POST /api/workflows/:id/run + GET /api/runs/:runId + logs + cancel.
 * Plus end-to-end: an LLM-shaped flow (POST workflow → patches → run).
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, hidden } from "@thodare/engine";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

const echoConn = defineConnector({
  type: "rt-echo",
  params: z.object({ msg: z.string() }),
  outputs: z.object({ msg: z.string() }),
  async run({ msg }) { return { msg }; },
});

async function createAndPatch(
  h: ApiHarness,
  ops: Array<Record<string, unknown>>,
): Promise<{ id: string; version: number }> {
  const created = (await (
    await h.fetch("/api/workflows", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json()) as { id: string; version: number };
  if (ops.length > 0) {
    await h.fetch(`/api/workflows/${created.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ ops }),
    });
  }
  return created;
}

describe("runs: dispatch + introspection", () => {
  it("POST /api/workflows/:id/run dispatches and returns 202 + runId", async () => {
    h = await newApiHarness({ connectors: [echoConn] });
    const wf = await createAndPatch(h, [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "e", type: "rt-echo", params: { msg: "{{trigger.msg}}" } },
      { operation_type: "connect", block_id: "trg", target_block_id: "e" },
    ]);
    const r = await h.fetch(`/api/workflows/${wf.id}/run`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ input: { msg: "hello" } }),
    });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { runId: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET /api/runs/:runId reflects state transitions until completed", async () => {
    h = await newApiHarness({ connectors: [echoConn] });
    const wf = await createAndPatch(h, [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "e", type: "rt-echo", params: { msg: "{{trigger.msg}}" } },
      { operation_type: "connect", block_id: "trg", target_block_id: "e" },
    ]);
    const startResp = (await (
      await h.fetch(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ input: { msg: "x" } }),
      })
    ).json()) as { runId: string };

    // Poll until completed.
    const deadline = Date.now() + 8000;
    let last: { state: string; output?: any } | null = null;
    while (Date.now() < deadline) {
      const r = await h.fetch(`/api/runs/${startResp.runId}`, { headers: withAuth(h.token) });
      expect(r.status).toBe(200);
      last = (await r.json()) as { state: string; output?: any };
      if (last.state === "completed" || last.state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(last?.state).toBe("completed");
    expect((last?.output as { outputs?: Record<string, any> })?.outputs?.["e"]?.msg).toBe("x");
  });

  it("GET /api/runs/:runId returns 404 for unknown run", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/runs/00000000-0000-0000-0000-000000000000", {
      headers: withAuth(h.token),
    });
    expect(r.status).toBe(404);
  });

  it("GET /api/runs/:runId/logs returns paginated step attempts", async () => {
    h = await newApiHarness({ connectors: [echoConn] });
    const wf = await createAndPatch(h, [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "e", type: "rt-echo", params: { msg: "x" } },
      { operation_type: "connect", block_id: "trg", target_block_id: "e" },
    ]);
    const startResp = (await (
      await h.fetch(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { runId: string };

    // Wait for completion.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const r = (await (
        await h.fetch(`/api/runs/${startResp.runId}`, { headers: withAuth(h.token) })
      ).json()) as { state: string };
      if (r.state === "completed" || r.state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const logs = await h.fetch(`/api/runs/${startResp.runId}/logs`, { headers: withAuth(h.token) });
    expect(logs.status).toBe(200);
    const body = (await logs.json()) as { data: Array<{ name: string; status: string }>; pagination: any };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/runs/:runId/cancel cancels a running workflow", async () => {
    // Use a wait-for-event workflow so we can cancel before it completes.
    h = await newApiHarness({ connectors: [echoConn] });
    const wf = await createAndPatch(h, [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "w", type: "wait_for_event",
        params: { eventName: "never", timeoutHours: 1 } },
      { operation_type: "connect", block_id: "trg", target_block_id: "w" },
    ]);
    const startResp = (await (
      await h.fetch(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { runId: string };
    // Give it a beat to park.
    await new Promise((r) => setTimeout(r, 600));
    const cancel = await h.fetch(`/api/runs/${startResp.runId}/cancel`, {
      method: "POST",
      headers: withAuth(h.token),
    });
    expect(cancel.status).toBe(204);
    // State eventually flips to canceled.
    await new Promise((r) => setTimeout(r, 400));
    const desc = (await (
      await h.fetch(`/api/runs/${startResp.runId}`, { headers: withAuth(h.token) })
    ).json()) as { state: string };
    expect(desc.state).toBe("canceled");
  });

  it("idempotencyKey passes through — duplicate POST /run with same key returns same runId", async () => {
    h = await newApiHarness({ connectors: [echoConn] });
    const wf = await createAndPatch(h, [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "e", type: "rt-echo", params: { msg: "x" } },
      { operation_type: "connect", block_id: "trg", target_block_id: "e" },
    ]);
    const r1 = (await (
      await h.fetch(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ input: {}, idempotencyKey: "dedupe-1" }),
      })
    ).json()) as { runId: string };
    const r2 = (await (
      await h.fetch(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ input: {}, idempotencyKey: "dedupe-1" }),
      })
    ).json()) as { runId: string };
    expect(r1.runId).toBe(r2.runId);
  });

  it("LLM end-to-end: empty workflow → bad-patch turn → fix-up patch → run → outputs", async () => {
    h = await newApiHarness({ connectors: [echoConn] });
    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ metadata: { name: "llm-loop" } }),
      })
    ).json()) as { id: string };

    // Turn 1: includes a bogus block + a bad ref. The good ops still apply.
    const turn1 = (await (
      await h.fetch(`/api/workflows/${created.id}/operations`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({
          ops: [
            { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
            { operation_type: "add", block_id: "ghost", type: "this-doesnt-exist", params: {} },
            { operation_type: "add", block_id: "e", type: "rt-echo",
              params: { msg: "{{trigger.message}}" } }, // 'message' instead of 'msg'
            { operation_type: "connect", block_id: "trg", target_block_id: "e" },
          ],
        }),
      })
    ).json()) as { ok: boolean; skipped_items: any[]; validation_errors: any[] };

    expect(turn1.ok).toBe(false);
    expect(turn1.skipped_items.length).toBeGreaterThan(0);

    // Turn 2: LLM fixes the ref.
    const turn2 = (await (
      await h.fetch(`/api/workflows/${created.id}/operations`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({
          ops: [
            { operation_type: "edit", block_id: "e", params: { msg: "{{trigger.msg}}" } },
          ],
        }),
      })
    ).json()) as { ok: boolean };
    expect(turn2.ok).toBe(true);

    // Run it.
    const startResp = (await (
      await h.fetch(`/api/workflows/${created.id}/run`, {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ input: { msg: "FROM-LLM-LOOP" } }),
      })
    ).json()) as { runId: string };

    const deadline = Date.now() + 8000;
    let final: { state: string; output?: any } | null = null;
    while (Date.now() < deadline) {
      final = (await (
        await h.fetch(`/api/runs/${startResp.runId}`, { headers: withAuth(h.token) })
      ).json()) as { state: string; output?: any };
      if (final.state === "completed" || final.state === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(final?.state).toBe("completed");
    expect((final?.output as { outputs: any }).outputs.e.msg).toBe("FROM-LLM-LOOP");
  });
});
