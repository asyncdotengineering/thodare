import { describe, it, expect, afterEach } from "vitest";
import { buildDurableWorkflow, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";

let h: DurableHarness;
afterEach(async () => { await h.dispose(); });

/**
 * The proof that closes the loop:
 *   - Two compute blocks. The first always succeeds; the second fails with
 *     a synthetic error on its first attempt and succeeds on the next.
 *   - We let the workflow run, hit the failure, then RESTART the worker
 *     before the retry budget is exhausted. The restart reclaims the run.
 *   - On replay, openworkflow uses the cached result of block #1 — so
 *     `firstCalls` stays at 1 — and re-executes block #2 (which now
 *     succeeds because we toggled the flag).
 *
 * If the interpreter were generating non-stable step names this would
 * re-execute block #1 too. The fact that it doesn't is the durability
 * guarantee.
 */
describe("durable runtime: crash recovery via openworkflow replay", () => {
  it("replays cached step results after a worker restart and continues to completion", async () => {
    h = await newDurableHarness();
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
      metadata: { name: "wf-crash" },
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

    // Wait until block one has run AND second has been attempted at least once.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (firstCalls >= 1 && secondCalls >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBeGreaterThanOrEqual(1);

    // Simulate worker crash: stop and restart. Toggle the flag so the next
    // attempt of `second_step` succeeds.
    secondShouldFail = false;
    await h.restartWorker();

    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["one"].stamp).toBe("first-done");
    expect(out.outputs["two"].stamp).toBe("second-done");

    // First step's result was memoized — no replay re-execution.
    expect(firstCalls).toBe(1);
    // Second step had at least one failure and at least one success.
    expect(secondCalls).toBeGreaterThanOrEqual(2);
  });
});
