/**
 * buildRuntimeWorkflow — ONE registered openworkflow workflow that takes
 * `{ workflow, input }` and walks it dynamically. Lets the API service
 * register new workflows AFTER worker.start() without restarting the worker.
 *
 * The @thodare/engine runtime workflow is what powers the @thodare/api
 * (Spike 4). Workflows live in a Postgres table; the runtime walks them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRuntimeWorkflow,
  defineConnector,
  defineWorkflow,
  type Wfkit,
} from "../src/index.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";
import { freshRegistries } from "./_setup.js";

let h: DurableHarness;
afterEach(async () => { await h.dispose(); });

describe("buildRuntimeWorkflow", () => {
  it("walks an arbitrary SerializedWorkflow passed as input", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    const echo = defineConnector({
      type: "rt-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    tools.register(echo.tool);
    blocks.register(echo.block);

    const runtime = buildRuntimeWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools,
    });

    // Build a workflow with the BUILDER (just to get a SerializedWorkflow).
    const wf = defineWorkflow("rt-test")
      .input(z.object({ msg: z.string() }))
      .step("e", echo, ({ input }) => ({ msg: input.msg }))
      .build();

    await h.startWorker();

    const handle = await runtime.run({ workflow: wf, input: { msg: "hello-runtime" } });
    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["e"].msg).toBe("hello-runtime");
  });

  it("two different workflows can run on the SAME runtime instance — no per-workflow registration", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    const echo = defineConnector({
      type: "rt-echo-two",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    tools.register(echo.tool);
    blocks.register(echo.block);

    const runtime = buildRuntimeWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools,
    });

    const wfA = defineWorkflow("rt-a")
      .input(z.object({ msg: z.string() }))
      .step("e", echo, ({ input }) => ({ msg: `A:${input.msg}` }))
      .build();
    const wfB = defineWorkflow("rt-b")
      .input(z.object({ msg: z.string() }))
      .step("e", echo, ({ input }) => ({ msg: `B:${input.msg}` }))
      .build();

    await h.startWorker();

    const [a, b] = await Promise.all([
      runtime.run({ workflow: wfA, input: { msg: "x" } }),
      runtime.run({ workflow: wfB, input: { msg: "x" } }),
    ]);
    const [outA, outB] = await Promise.all([a.result(), b.result()]) as Array<{ outputs: any }>;
    expect(outA.outputs["e"].msg).toBe("A:x");
    expect(outB.outputs["e"].msg).toBe("B:x");
  });

  it("runtime survives a worker restart mid-run (durability inherited from openworkflow)", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    let firstCalls = 0;
    let secondCalls = 0;
    let secondShouldFail = true;
    tools.register({
      id: "rt_first", name: "", description: "", params: {}, outputs: { stamp: { type: "string" } },
      async execute() { firstCalls += 1; return { stamp: "first" }; },
    });
    tools.register({
      id: "rt_second", name: "", description: "", params: {}, outputs: { stamp: { type: "string" } },
      async execute() {
        secondCalls += 1;
        if (secondShouldFail) throw new Error("synthetic crash");
        return { stamp: "second" };
      },
    });
    blocks.register({
      type: "rt_first_block", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { stamp: { type: "string" } },
      tools: { access: ["rt_first"], config: { tool: () => "rt_first" } },
    });
    blocks.register({
      type: "rt_second_block", name: "", description: "",
      category: "tools", kind: "compute", subBlocks: [],
      outputs: { stamp: { type: "string" } },
      tools: { access: ["rt_second"], config: { tool: () => "rt_second" } },
    });

    const runtime = buildRuntimeWorkflow({
      ow: h.ow, backend: h.backend, blockRegistry: blocks, toolRegistry: tools,
    });

    const wf = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "one", type: "rt_first_block", enabled: true, params: {} },
        { id: "two", type: "rt_second_block", enabled: true, params: {} },
      ],
      connections: [
        { source: "trg", target: "one" },
        { source: "one", target: "two" },
      ],
    };

    await h.startWorker();
    const handle = await runtime.run({ workflow: wf, input: {} });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (firstCalls >= 1 && secondCalls >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBeGreaterThanOrEqual(1);

    secondShouldFail = false;
    await h.restartWorker();

    const out = (await handle.result()) as { outputs: any };
    expect(out.outputs["one"].stamp).toBe("first");
    expect(out.outputs["two"].stamp).toBe("second");
    // First step result was memoized — runtime mode preserves replay determinism.
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBeGreaterThanOrEqual(2);
  });

  it("resolves credentialId from block params and injects into ToolContext.credential", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();

    let capturedCredential: unknown = undefined;
    const conn = defineConnector({
      type: "rt-cred",
      credential: { required: true, type: "api-key" },
      params: z.object({ msg: z.string() }),
      outputs: z.object({ hasCred: z.boolean(), keyLen: z.number() }),
      async run(_params, ctx) {
        capturedCredential = ctx.credential;
        return {
          hasCred: ctx.credential !== undefined,
          keyLen: typeof ctx.credential?.secret === "object" ? Object.keys(ctx.credential.secret).length : 0,
        };
      },
    });
    tools.register(conn.tool);
    blocks.register(conn.block);

    let resolveCalls = 0;
    const runtime = buildRuntimeWorkflow({
      ow: h.ow,
      backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      resolveCredential: async (credentialId, organizationId) => {
        resolveCalls += 1;
        if (credentialId === "cred-abc" && organizationId === "org-1") {
          return { id: "cred-abc", type: "api-key", displayName: "Test Key", secret: { apiKey: "sk-test-12345" } };
        }
        return null;
      },
    });

    const wf = {
      version: "1.0.0",
      blocks: [
        { id: "e", type: "rt-cred", enabled: true, params: { msg: "hello", credentialId: "cred-abc" } },
      ],
      connections: [],
    };

    await h.startWorker();
    const handle = await runtime.run({ workflow: wf, input: {}, organizationId: "org-1" });
    const out = (await handle.result()) as { outputs: Record<string, unknown> };
    const result = out.outputs["e"] as { hasCred: boolean; keyLen: number };
    expect(result.hasCred).toBe(true);
    expect(result.keyLen).toBeGreaterThan(0);
    expect(resolveCalls).toBe(1);
    expect(capturedCredential).toBeDefined();
  });
});
