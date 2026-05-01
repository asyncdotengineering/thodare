/**
 * Pause / resume / signal red-team.
 *
 * The pause primitive is supposed to be the single durable suspension
 * mechanism. These tests poke at the edges:
 *   - Resuming the same in-memory snapshot twice
 *   - Resuming with a payload of the wrong shape
 *   - wait_for_event timeout (resumeAt fires, no signal arrives)
 *   - Two concurrent waiters on the same signal name
 *   - Pausing on the very first executable block
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  buildDurableWorkflow,
  execute,
  resume,
  type SerializedWorkflow,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

describe("in-memory pause/resume red-team", () => {
  it("resuming the same snapshot twice produces two completions (no built-in idempotency)", async () => {
    // The durable runtime owns idempotency (openworkflow's run-id is unique).
    // The in-memory executor is dev-only and does NOT enforce snapshot
    // single-use. Document that the caller is responsible for idempotency
    // (this is what `consumed` flag would enforce in a Postgres pauseSnapshots
    // table — but we deliberately don't have that table here).
    const { tools, blocks } = freshRegistries();
    let afterCount = 0;
    tools.register({
      id: "count_tool",
      name: "",
      description: "",
      params: {},
      outputs: { count: { type: "number" } },
      async execute() { afterCount += 1; return { count: afterCount }; },
    });
    blocks.register({
      type: "count_block",
      name: "",
      description: "",
      category: "tools",
      kind: "compute",
      subBlocks: [],
      outputs: { count: { type: "number" } },
      tools: { access: ["count_tool"], config: { tool: () => "count_tool" } },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "wait", type: "human_approval", enabled: true, params: { prompt: "?" } },
        { id: "after", type: "count_block", enabled: true, params: {} },
      ],
      connections: [
        { source: "trg", target: "wait" },
        { source: "wait", target: "after" },
      ],
    };
    const r1 = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r1.paused).toBe(true);

    await resume(r1.snapshot!, { approved: true }, { toolRegistry: tools, blockRegistry: blocks });
    expect(afterCount).toBe(1);
    // SECOND resume — without idempotency, the after block fires AGAIN.
    await resume(r1.snapshot!, { approved: true }, { toolRegistry: tools, blockRegistry: blocks });
    expect(afterCount).toBe(2);
    // This documents the behavior. Production should either move to the
    // durable runtime (which has idempotent run IDs) or wrap resume() in a
    // single-use token check.
  });

  it("a wait at the very first executable position pauses cleanly with empty completed list", async () => {
    const { tools, blocks } = freshRegistries();
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "wait", type: "wait_for_event", enabled: true, params: { eventName: "x" } },
      ],
      connections: [{ source: "trg", target: "wait" }],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools, trigger: {} });
    expect(r.paused).toBe(true);
    expect(r.snapshot!.pausedAtBlockId).toBe("wait");
    // Trigger ran (it's not a "wait"); only wait paused. So completed should
    // include trg.
    expect(r.snapshot!.completedBlockIds).toContain("trg");
    expect(r.snapshot!.completedBlockIds).not.toContain("wait");
  });

  it("resume payload overrides the wait block's output cleanly even when the shape is unexpected", async () => {
    // Wait block's declared output is { approved, by, note }. We feed a
    // resume payload that's a number. The downstream block must still see
    // SOMETHING on the resolver chain (we capture what it sees).
    const { tools, blocks } = freshRegistries();
    let captured: unknown = undefined;
    tools.register({
      id: "capture",
      name: "", description: "",
      params: { incoming: { type: "object", visibility: "user-or-llm" } },
      outputs: {},
      async execute(p) { captured = p.incoming; return {}; },
    });
    blocks.register({
      type: "cap",
      name: "", description: "",
      category: "tools", kind: "compute",
      subBlocks: [{ id: "incoming", title: "i", type: "json" }],
      outputs: {},
      tools: { access: ["capture"], config: { tool: () => "capture" } },
    });
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "h", type: "human_approval", enabled: true, params: { prompt: "?" } },
        { id: "c", type: "cap", enabled: true, params: { incoming: "{{h}}" } },
      ],
      connections: [
        { source: "trg", target: "h" },
        { source: "h", target: "c" },
      ],
    };
    const r1 = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r1.paused).toBe(true);
    // Wrong-shape resume: a number.
    await resume(r1.snapshot!, 42, { toolRegistry: tools, blockRegistry: blocks });
    // The downstream block saw the raw value via {{h}} (single ref).
    expect(captured).toBe(42);
  });
});

describe("durable wait/signal red-team", () => {
  let h: DurableHarness;
  afterEach(async () => { await h.dispose(); });

  it("wait_for_event with a tight timeout and no emitter resumes with timedOut=true", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-timeout" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        {
          id: "w",
          type: "wait_for_event",
          enabled: true,
          // ~1.5s — long enough for openworkflow to schedule the wait,
          // short enough for the test to finish quickly.
          params: { eventName: "never_fires", timeoutHours: 0.0004 },
        },
        { id: "after", type: "transform", enabled: true, params: { template: { reached: true, td: "{{w.timedOut}}" } } },
      ],
      connections: [
        { source: "trg", target: "w" },
        { source: "w", target: "after" },
      ],
    };
    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: wf,
    });
    await h.startWorker();
    const out = (await (await compiled.run({})).result()) as { outputs: Record<string, any> };
    expect(out.outputs["after"].result.reached).toBe(true);
    // The downstream observes timedOut=true via the resolver.
    expect(out.outputs["after"].result.td).toBe(true);
  });

  it("two concurrent workflows on the same event name BOTH receive the signal", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    // Build TWO instances of the same wait workflow.
    const mkWf = (label: string): SerializedWorkflow => ({
      version: "1.0.0",
      metadata: { name: `wf-fanout-${label}` },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "w", type: "wait_for_event", enabled: true, params: { eventName: "broadcast" } },
        {
          id: "after",
          type: "transform",
          enabled: true,
          params: { template: { from: label, got: "{{w.data.payload}}" } },
        },
      ],
      connections: [
        { source: "trg", target: "w" },
        { source: "w", target: "after" },
      ],
    });
    const a = buildDurableWorkflow({ ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: mkWf("A") });
    const b = buildDurableWorkflow({ ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools, workflow: mkWf("B") });
    const sig = h.ow.defineWorkflow({ name: "fanout_emit" }, async ({ step }) => {
      await step.sendSignal({ name: "emit", signal: "broadcast", data: { payload: "hello-all" } });
      return { sent: true };
    });

    await h.startWorker();
    const handleA = await a.run({});
    const handleB = await b.run({});
    // Give both a beat to park.
    await new Promise((r) => setTimeout(r, 800));
    await (await sig.run({})).result();

    const [outA, outB] = await Promise.all([handleA.result(), handleB.result()]) as Array<{ outputs: any }>;
    expect(outA.outputs["after"].result.from).toBe("A");
    expect(outB.outputs["after"].result.from).toBe("B");
    expect(outA.outputs["after"].result.got).toBe("hello-all");
    expect(outB.outputs["after"].result.got).toBe("hello-all");
  });

  it("emit BEFORE any waiter is parked is dropped (no buffering) — wfkit conv 06 semantic", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    const mainWf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-late" },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        {
          id: "w",
          type: "wait_for_event",
          enabled: true,
          params: { eventName: "tooEarly", timeoutHours: 0.0004 },
        },
        {
          id: "after",
          type: "transform",
          enabled: true,
          params: { template: { td: "{{w.timedOut}}" } },
        },
      ],
      connections: [
        { source: "trg", target: "w" },
        { source: "w", target: "after" },
      ],
    };
    const compiledMain = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: mainWf,
    });
    const sig = h.ow.defineWorkflow({ name: "early_emit" }, async ({ step }) => {
      await step.sendSignal({ name: "emit", signal: "tooEarly", data: { x: 1 } });
      return {};
    });

    await h.startWorker();
    // EMIT FIRST — before main has even been started.
    await (await sig.run({})).result();
    // Then start main; nothing is waiting at emit time, so the signal is gone.
    const out = (await (await compiledMain.run({})).result()) as { outputs: any };
    // Main eventually times out and reports timedOut=true.
    expect(out.outputs["after"].result.td).toBe(true);
  });
});
