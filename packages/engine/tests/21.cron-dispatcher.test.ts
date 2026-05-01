/**
 * Cron dispatcher TDD.
 *
 * Three tiers:
 *   1. Pure unit — parseCron, isCronMatch.
 *   2. Logic — dispatchOnce: idempotency, end_at, no-match skip, batch fire.
 *   3. End-to-end — a real openworkflow workflow gets run by the dispatcher.
 *
 * Cron-dispatcher patterns:
 *   - Idempotency on `(scheduleId, cutoffMinute)` via runWorkflow's
 *     idempotencyKey option.
 *   - Schedules carry an `endAt` cutoff after which they stop firing.
 *   - No second-resolution cron — minute is the smallest tick.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  buildDurableWorkflow,
  dispatchOnce,
  InMemoryScheduleStore,
  isCronMatch,
  newScheduleId,
  parseCron,
  startCronDispatcher,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

describe("parseCron", () => {
  it("parses every-minute (`* * * * *`)", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dayOfMonth.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dayOfWeek.size).toBe(7);
  });

  it("parses step (every 5 minutes via */5)", () => {
    const p = parseCron("*/5 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("parses commas and ranges", () => {
    const p = parseCron("0,30 9-17 * * 1-5");
    expect([...p.minute].sort()).toEqual([0, 30]);
    expect([...p.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...p.dayOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects malformed input", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("xx * * * *")).toThrow(/bad cron/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/bad cron step/);
  });
});

describe("isCronMatch", () => {
  it("matches a hand-picked instant (Mon 2026-05-04T09:00:00Z) for `0 9 * * 1`", () => {
    const monday = new Date(Date.UTC(2026, 4, 4, 9, 0, 0));
    const sundayLater = new Date(Date.UTC(2026, 4, 3, 9, 0, 0));
    const p = parseCron("0 9 * * 1");
    expect(isCronMatch(p, monday)).toBe(true);
    expect(isCronMatch(p, sundayLater)).toBe(false);
  });

  it("`*/5` minute matches at :00, :05, :10 and skips :03", () => {
    const p = parseCron("*/5 * * * *");
    expect(isCronMatch(p, new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe(true);
    expect(isCronMatch(p, new Date(Date.UTC(2026, 0, 1, 0, 5, 0)))).toBe(true);
    expect(isCronMatch(p, new Date(Date.UTC(2026, 0, 1, 0, 10, 0)))).toBe(true);
    expect(isCronMatch(p, new Date(Date.UTC(2026, 0, 1, 0, 3, 0)))).toBe(false);
  });
});

describe("dispatchOnce idempotency / end-of-schedule / batch", () => {
  it("fires every matching schedule exactly once for a given cutoff minute, even when called twice", async () => {
    const store = new InMemoryScheduleStore();
    store.add({ id: "s1", cron: "* * * * *", workflowName: "w_a", payload: { kind: "a" } });
    store.add({ id: "s2", cron: "* * * * *", workflowName: "w_b", payload: { kind: "b" } });
    store.add({ id: "s3", cron: "0 9 * * 1", workflowName: "w_mon", payload: {} }); // no-match for cutoff

    const fired: Array<{ name: string; key: string }> = [];
    const fakeRun = async (workflowName: string, _input: unknown, opts: { idempotencyKey: string }) => {
      fired.push({ name: workflowName, key: opts.idempotencyKey });
      return { workflowRun: { id: `r_${workflowName}_${fired.length}` } };
    };

    const cutoff = new Date(Date.UTC(2026, 4, 5, 12, 0, 0)); // Tuesday — only s1/s2 match
    const r1 = await dispatchOnce({ store, runWorkflow: fakeRun }, cutoff);
    expect(r1.fired.map((f) => f.scheduleId).sort()).toEqual(["s1", "s2"]);
    expect(r1.skippedNotMatching).toBe(1); // s3

    // SECOND call for the SAME cutoff minute. Must skip both because they're already fired.
    const r2 = await dispatchOnce({ store, runWorkflow: fakeRun }, cutoff);
    expect(r2.fired).toHaveLength(0);
    expect(r2.skippedAlreadyFired).toBe(2);
    // The fakeRun was called only twice total (once per schedule, the first time).
    expect(fired).toHaveLength(2);

    // Every idempotency key contains the schedule id and the cutoff ISO.
    for (const f of fired) expect(f.key).toMatch(/^cron:s\d:2026-05-05T12:00:00\.000Z$/);
  });

  it("respects endAt — schedules past their end never fire", async () => {
    const store = new InMemoryScheduleStore();
    store.add({
      id: "expired", cron: "* * * * *", workflowName: "w", payload: {},
      endAt: "2024-01-01T00:00:00.000Z", // long past
    });
    store.add({
      id: "active", cron: "* * * * *", workflowName: "w", payload: {},
      endAt: "2099-01-01T00:00:00.000Z",
    });
    let count = 0;
    const fakeRun = async () => {
      count += 1;
      return { workflowRun: { id: "x" } };
    };
    const r = await dispatchOnce(
      { store, runWorkflow: fakeRun },
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    );
    expect(count).toBe(1);
    expect(r.fired.map((f) => f.scheduleId)).toEqual(["active"]);
    expect(r.skippedExpired).toBe(1);
  });
});

describe("startCronDispatcher", () => {
  it("tickNow() forces an immediate dispatch and the loop's stop() halts the cadence", async () => {
    const store = new InMemoryScheduleStore();
    store.add({ id: newScheduleId(), cron: "* * * * *", workflowName: "w_x", payload: {} });
    let runs = 0;
    const fakeRun = async () => {
      runs += 1;
      return { workflowRun: { id: `run_${runs}` } };
    };
    // tickOnStart: false so we control firing entirely from tickNow().
    const fixedNow = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const handle = startCronDispatcher({
      store, runWorkflow: fakeRun, tickIntervalMs: 60_000_000, clock: () => fixedNow,
      tickOnStart: false,
    });
    const r = await handle.tickNow();
    expect(r.fired).toHaveLength(1);
    expect(runs).toBe(1);
    await handle.stop();
  });
});

describe("end-to-end: cron-driven openworkflow run", () => {
  let h: DurableHarness;
  afterEach(async () => { await h.dispose(); });

  it("dispatcher tick spawns a real openworkflow run that completes with the schedule's payload", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const wfDoc: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "cron-target" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        {
          id: "echo",
          type: "transform",
          enabled: true,
          params: { template: { schedule: "{{trigger.scheduleId}}", payload: "{{trigger.note}}" } },
        },
      ],
      connections: [{ source: "trg", target: "echo" }],
    };
    const wf = buildDurableWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: wfDoc,
    });
    await h.startWorker();

    // Schedule fires at "the current cutoff minute". Use `*/1` (= every minute)
    // and tick with a synthetic clock that's exactly aligned.
    const store = new InMemoryScheduleStore();
    const id = newScheduleId();
    store.add({
      id, cron: "* * * * *", workflowName: "cron-target",
      payload: { scheduleId: id, note: "hello-from-cron" },
    });
    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

    // The dispatcher's `runWorkflow` uses openworkflow's runWorkflow API
    // directly so we get idempotencyKey support natively.
    const result = await dispatchOnce(
      {
        store,
        runWorkflow: async (name, input, opts) => {
          // Look up the workflow by name. @thodare/engine doesn't yet expose a
          // by-name lookup, so we use the one we just compiled.
          if (name === "cron-target") {
            return wf.run(input, opts);
          }
          throw new Error(`unknown workflow: ${name}`);
        },
      },
      cutoff,
    );
    expect(result.fired).toHaveLength(1);
    const runId = result.fired[0]!.runId;

    // Wait for the run via a fresh handle.
    const handle = wf.getHandle(runId);
    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["echo"].result).toMatchObject({
      schedule: id,
      payload: "hello-from-cron",
    });
  });
});
