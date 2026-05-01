/**
 * C-2: persistent schedule claim — `last_fired_at` + FOR UPDATE.
 *
 * Locks the multi-process tick contract: two parallel `/api/admin/tick`
 * requests dispatching the same schedule fire it exactly ONCE total.
 * The in-memory seen-set was only correct within one process; the
 * row-level lock makes it correct across any number.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector } from "@thodare/engine";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

const echoConn = defineConnector({
  type: "claim-echo",
  params: z.object({ msg: z.string() }),
  outputs: z.object({ msg: z.string() }),
  async run({ msg }) { return { msg }; },
});

describe("persistent schedule claim", () => {
  it("two parallel ticks dispatching the same schedule fire it exactly once", async () => {
    h = await newApiHarness({ connectors: [echoConn] });

    // A workflow that runs the echo connector on a webhook trigger.
    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };
    await h.fetch(`/api/workflows/${created.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
          { operation_type: "add", block_id: "e", type: "claim-echo", params: { msg: "{{trigger.tag}}" } },
          { operation_type: "connect", block_id: "trg", target_block_id: "e" },
        ],
      }),
    });
    await h.fetch("/api/schedules", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ workflowId: created.id, cron: "* * * * *", payload: { tag: "claim" } }),
    });

    // Fire two ticks in parallel.
    const [r1, r2] = await Promise.all([
      h.fetch("/api/admin/tick", { method: "POST", headers: withAuth(h.token) }),
      h.fetch("/api/admin/tick", { method: "POST", headers: withAuth(h.token) }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { fired: Array<{ scheduleId: string }> };
    const b2 = (await r2.json()) as { fired: Array<{ scheduleId: string }> };
    const totalFires = b1.fired.length + b2.fired.length;
    expect(totalFires).toBe(1);
  });

  it("a second tick at the same cutoff doesn't re-fire (claim is sticky)", async () => {
    h = await newApiHarness({ connectors: [echoConn] });

    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };
    await h.fetch(`/api/workflows/${created.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
        ],
      }),
    });
    await h.fetch("/api/schedules", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ workflowId: created.id, cron: "* * * * *" }),
    });

    const r1 = await h.fetch("/api/admin/tick", { method: "POST", headers: withAuth(h.token) });
    const b1 = (await r1.json()) as { fired: unknown[] };
    expect(b1.fired.length).toBeGreaterThanOrEqual(1);

    // Immediately fire again — no clock advance, same cutoff. Should NOT
    // fire again.
    const r2 = await h.fetch("/api/admin/tick", { method: "POST", headers: withAuth(h.token) });
    const b2 = (await r2.json()) as { fired: unknown[]; skippedAlreadyFired: number };
    expect(b2.fired.length).toBe(0);
    expect(b2.skippedAlreadyFired).toBeGreaterThanOrEqual(1);
  });

  it("ScheduleStore.tryClaim is atomic: 50 racers see exactly 1 success", async () => {
    h = await newApiHarness({ connectors: [echoConn] });

    // Create a schedule directly via the store so we have its id.
    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };
    const sched = (await (
      await h.fetch("/api/schedules", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ workflowId: created.id, cron: "* * * * *" }),
      })
    ).json()) as { id: string };

    // 50 parallel claims at the same cutoff.
    const cutoff = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => h.api.schedules.tryClaim(sched.id, cutoff)),
    );
    const successes = results.filter((r) => r === true).length;
    expect(successes).toBe(1);
  });
});
