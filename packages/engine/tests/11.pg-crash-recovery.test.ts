import { describe, it, expect, afterEach } from "vitest";
import { buildDurableWorkflow, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newPgDurableHarness, type PgDurableHarness } from "./_durable-pg-harness.js";

let h: PgDurableHarness;
afterEach(async () => { await h.dispose(); });

/**
 * Same proof as test 08, but on Postgres. Confirms that openworkflow's PG
 * backend gives identical durability guarantees as SQLite for our DSL.
 *
 * Strategy:
 *   - First block: succeeds, increments firstCalls.
 *   - Second block: fails on the first attempt, succeeds after we toggle
 *     `secondShouldFail = false`.
 *   - We let the workflow fire, observe the failure, RESTART the worker, and
 *     toggle the flag. The restart reclaims the run from the PG backend.
 *   - On replay, openworkflow uses the cached result of block #1 — so
 *     `firstCalls` stays at 1 — and re-executes block #2 (now succeeds).
 */
describe("Postgres backend: crash recovery via openworkflow replay", () => {
  it("replays cached step results after a worker restart and continues to completion", async () => {
    h = await newPgDurableHarness();
    const { tools, blocks } = freshRegistries();

    let firstCalls = 0;
    let secondCalls = 0;
    let secondShouldFail = true;

    tools.register({
      id: "first_step",
      name: "First Step",
      description: "test",
      params: {},
      outputs: { stamp: { type: "string" } },
      async execute() {
        firstCalls += 1;
        return { stamp: "first-done" };
      },
    });
    tools.register({
      id: "second_step",
      name: "Second Step",
      description: "test",
      params: {},
      outputs: { stamp: { type: "string" } },
      async execute() {
        secondCalls += 1;
        if (secondShouldFail) throw new Error("synthetic crash");
        return { stamp: "second-done" };
      },
    });

    blocks.register({
      type: "first_block",
      name: "First",
      description: "test",
      category: "tools",
      kind: "compute",
      subBlocks: [],
      outputs: { stamp: { type: "string" } },
      tools: { access: ["first_step"], config: { tool: () => "first_step" } },
    });
    blocks.register({
      type: "second_block",
      name: "Second",
      description: "test",
      category: "tools",
      kind: "compute",
      subBlocks: [],
      outputs: { stamp: { type: "string" } },
      tools: { access: ["second_step"], config: { tool: () => "second_step" } },
    });

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: `wf-pg-crash-${h.schema}` },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "one", type: "first_block", enabled: true, params: {} },
        { id: "two", type: "second_block", enabled: true, params: {} },
      ],
      connections: [
        { source: "trg", target: "one" },
        { source: "one", target: "two" },
      ],
    };

    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: wf,
    });
    await h.startWorker();

    const handle = await compiled.run({});

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (firstCalls >= 1 && secondCalls >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBeGreaterThanOrEqual(1);

    // Simulated crash: stop, fix the flag, restart.
    secondShouldFail = false;
    await h.restartWorker();

    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["one"].stamp).toBe("first-done");
    expect(out.outputs["two"].stamp).toBe("second-done");

    // First step's result was memoized — durability is real on PG too.
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBeGreaterThanOrEqual(2);
  });
});
