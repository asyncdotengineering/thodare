/**
 * Cron red-team coverage:
 * production-shape schedule dispatcher leans on:
 *   - atomic claim per (scheduleId, cutoffMinute)
 *   - hard endAt cutoff
 *   - graceful skip when a target is missing
 *
 * Probe each of those edges plus a few I'm specifically worried about.
 */

import { describe, it, expect } from "vitest";
import {
  dispatchOnce,
  InMemoryScheduleStore,
  parseCron,
  type ScheduleSpec,
} from "../src/index.js";

describe("cron red-team", () => {
  it("CONCURRENT dispatchOnce calls for the same cutoff fire each schedule exactly once", async () => {
    const store = new InMemoryScheduleStore();
    for (let i = 0; i < 10; i++) {
      store.add({ id: `s${i}`, cron: "* * * * *", workflowName: "w", payload: { i } });
    }
    let runs = 0;
    const fakeRun = async () => {
      runs += 1;
      // Add a small async tick to force interleaving.
      await new Promise((r) => setTimeout(r, 5));
      return { workflowRun: { id: `r${runs}` } };
    };
    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const results = await Promise.all([
      dispatchOnce({ store, runWorkflow: fakeRun }, cutoff),
      dispatchOnce({ store, runWorkflow: fakeRun }, cutoff),
      dispatchOnce({ store, runWorkflow: fakeRun }, cutoff),
    ]);
    // Exactly 10 firings across all three concurrent dispatchers.
    expect(runs).toBe(10);
    const fired = results.flatMap((r) => r.fired.map((f) => f.scheduleId));
    expect(new Set(fired).size).toBe(10);
  });

  it("a schedule whose runWorkflow THROWS is recorded as `failed` and does NOT block the rest of the tick", async () => {
    const store = new InMemoryScheduleStore();
    store.add({ id: "broken", cron: "* * * * *", workflowName: "broken", payload: {} });
    store.add({ id: "ok", cron: "* * * * *", workflowName: "ok", payload: {} });
    const fakeRun = async (name: string) => {
      if (name === "broken") throw new Error("kaboom");
      return { workflowRun: { id: "ok-run" } };
    };
    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const r = await dispatchOnce({ store, runWorkflow: fakeRun }, cutoff);
    expect(r.fired.map((f) => f.scheduleId)).toEqual(["ok"]);
    expect(r.failed).toEqual([{ scheduleId: "broken", error: "kaboom" }]);
  });

  it("malformed cron is skipped, not crashed (skippedNotMatching)", async () => {
    const store = new InMemoryScheduleStore();
    store.add({ id: "bad", cron: "totally bogus", workflowName: "x", payload: {} });
    store.add({ id: "good", cron: "* * * * *", workflowName: "x", payload: {} });
    let runs = 0;
    const fakeRun = async () => { runs += 1; return { workflowRun: { id: "r" } }; };
    const r = await dispatchOnce(
      { store, runWorkflow: fakeRun },
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    );
    expect(r.fired.map((f) => f.scheduleId)).toEqual(["good"]);
    // bad got counted into skippedNotMatching by the parser fall-through.
    expect(r.skippedNotMatching).toBeGreaterThanOrEqual(1);
    expect(runs).toBe(1);
  });

  it("an absurdly large step (`*/120` for minutes) parses but matches nothing — silent no-op", async () => {
    // Step 120 on a 60-element domain matches only minute 0.
    const p = parseCron("*/120 * * * *");
    expect(p.minute.has(0)).toBe(true);
    expect(p.minute.size).toBe(1);
  });

  it("endAt in the past keeps the schedule in the store but never fires it", async () => {
    const store = new InMemoryScheduleStore();
    const expired: ScheduleSpec = {
      id: "expired", cron: "* * * * *", workflowName: "x", payload: {},
      endAt: "2024-01-01T00:00:00.000Z",
    };
    store.add(expired);
    let runs = 0;
    const fakeRun = async () => { runs += 1; return { workflowRun: { id: "r" } }; };
    // Dispatch many ticks; never fires.
    for (let h = 0; h < 24; h++) {
      await dispatchOnce(
        { store, runWorkflow: fakeRun },
        new Date(Date.UTC(2026, 0, 1, h, 0, 0)),
      );
    }
    expect(runs).toBe(0);
    expect((await store.list()).map((s) => s.id)).toContain("expired");
  });

  it("clock travels backwards: an earlier cutoff after a later one already fired DOES fire (idempotency is per-cutoff)", async () => {
    // This is honest behavior: if your wall clock got rewound, schedules
    // for the earlier minute haven't been claimed yet. Document.
    const store = new InMemoryScheduleStore();
    store.add({ id: "s", cron: "* * * * *", workflowName: "w", payload: {} });
    let runs = 0;
    const fakeRun = async () => { runs += 1; return { workflowRun: { id: `r${runs}` } }; };
    const later = new Date(Date.UTC(2026, 0, 1, 12, 30, 0));
    const earlier = new Date(Date.UTC(2026, 0, 1, 12, 29, 0));
    await dispatchOnce({ store, runWorkflow: fakeRun }, later);
    await dispatchOnce({ store, runWorkflow: fakeRun }, earlier);
    expect(runs).toBe(2);
    // Documented behavior — production should never rewind the clock; if
    // you do, accept doubled firings or wrap the dispatcher with a
    // monotonic-clock check.
  });

  it("the idempotency key is stable across seconds within the same minute", async () => {
    const store = new InMemoryScheduleStore();
    store.add({ id: "stable", cron: "* * * * *", workflowName: "w", payload: {} });
    const captured: string[] = [];
    const fakeRun = async (_n: string, _i: unknown, opts: { idempotencyKey: string }) => {
      captured.push(opts.idempotencyKey);
      return { workflowRun: { id: "r" } };
    };
    // Different sub-second timestamps in the same minute → same key.
    await dispatchOnce(
      { store, runWorkflow: fakeRun },
      new Date(Date.UTC(2026, 0, 1, 12, 30, 7, 123)),
    );
    await dispatchOnce(
      { store, runWorkflow: fakeRun },
      new Date(Date.UTC(2026, 0, 1, 12, 30, 41, 999)),
    );
    expect(captured[0]).toBe("cron:stable:2026-01-01T12:30:00.000Z");
    // The second call sees the same cutoff → already-claimed, no key emitted.
    expect(captured).toHaveLength(1);
  });
});
