/**
 * Runtime / executor red-team. The premise: a tool's `execute` is whatever
 * the integrator wrote, which may be a junior dev's first day or an LLM-
 * generated SDK adapter. The system must not collapse on weird inputs.
 *
 * Each test is named for the attack surface; we either prove it's contained
 * or document the failure mode.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  execute,
  type SerializedWorkflow,
  type Tool,
} from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newDurableHarness, type DurableHarness } from "./_durable-harness.js";
import { buildDurableWorkflow } from "../src/index.js";

const oneBlockWf = (id: string, type: string, params: Record<string, unknown> = {}): SerializedWorkflow => ({
  version: "1.0.0",
  blocks: [
    { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
    { id, type, enabled: true, params },
  ],
  connections: [{ source: "trg", target: id }],
});

const registerCustom = (tools: any, blocks: any, tool: Tool, blockType: string) => {
  tools.register(tool);
  blocks.register({
    type: blockType,
    name: blockType,
    description: "test",
    category: "tools",
    kind: "compute",
    subBlocks: [],
    outputs: tool.outputs,
    tools: { access: [tool.id], config: { tool: () => tool.id } },
  });
};

describe("runtime red-team", () => {
  it("tool that throws a non-Error (string) produces a sensible failure log", async () => {
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools,
      blocks,
      {
        id: "throws_string",
        name: "throws_string",
        description: "",
        params: {},
        outputs: {},
        async execute() { throw "oh no" as any; },
      },
      "throws_block",
    );
    const r = await execute({
      workflow: oneBlockWf("x", "throws_block"),
      blockRegistry: blocks,
      toolRegistry: tools,
    });
    expect(r.success).toBe(false);
    // Logged a real-looking error string even though the throw value wasn't
    // an Error instance.
    const failedLog = r.logs.find((l) => l.success === false);
    expect(failedLog).toBeDefined();
    expect(typeof failedLog!.error).toBe("string");
    expect(failedLog!.error).toContain("oh no");
  });

  it("tool that throws null/undefined doesn't NPE the executor", async () => {
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "throws_null",
        name: "throws_null",
        description: "",
        params: {}, outputs: {},
        async execute() { throw null as any; },
      },
      "throws_null_block",
    );
    const r = await execute({
      workflow: oneBlockWf("x", "throws_null_block"),
      blockRegistry: blocks,
      toolRegistry: tools,
    });
    expect(r.success).toBe(false);
    // The executor must produce SOME error string — not crash internally.
    const log = r.logs.find((l) => l.success === false);
    expect(log).toBeDefined();
    expect(typeof log!.error).toBe("string");
  });

  it("tool that returns undefined is recorded as undefined, not breaking downstream resolution", async () => {
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "ret_undef",
        name: "ret_undef",
        description: "",
        params: {}, outputs: { foo: { type: "string" } },
        async execute() { return undefined as any; },
      },
      "undef_block",
    );
    blocks.register({
      type: "echo_block",
      name: "echo",
      description: "",
      category: "tools",
      kind: "compute",
      subBlocks: [{ id: "value", title: "v", type: "short-input" }],
      outputs: { result: { type: "string" } },
      tools: {
        access: ["echo_tool"],
        config: { tool: () => "echo_tool" },
      },
    });
    tools.register({
      id: "echo_tool",
      name: "",
      description: "",
      params: { value: { type: "string", required: false, visibility: "user-or-llm" } },
      outputs: { result: { type: "string" } },
      async execute(p) { return { result: String(p.value) }; },
    });

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "u", type: "undef_block", enabled: true, params: {} },
        { id: "e", type: "echo_block", enabled: true, params: { value: "{{u.foo}}" } },
      ],
      connections: [
        { source: "trg", target: "u" },
        { source: "u", target: "e" },
      ],
    };
    const r = await execute({ workflow: wf, blockRegistry: blocks, toolRegistry: tools });
    expect(r.success).toBe(true);
    // Single-ref template against undefined output: raw undefined → `String(undefined)` = "undefined".
    expect((r.outputs["e"] as { result: string }).result).toBe("undefined");
  });

  it("compute block returning __paused on the in-memory executor pauses (intentional, dev-only behavior)", async () => {
    // wfkit's findings let any compute tool return __paused. The in-memory
    // executor honors that. The durable executor does NOT (separate test).
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "rogue_pause",
        name: "rogue_pause",
        description: "",
        params: {}, outputs: {},
        async execute() {
          return { __paused: true, reason: "wait_duration", resumeToken: "tok-test" };
        },
      },
      "rogue_block",
    );
    const r = await execute({
      workflow: oneBlockWf("x", "rogue_block"),
      blockRegistry: blocks,
      toolRegistry: tools,
    });
    expect(r.paused).toBe(true);
    expect(r.snapshot!.pause.reason).toBe("wait_duration");
  });
});

describe("durable runtime red-team", () => {
  let h: DurableHarness;
  afterEach(async () => { await h.dispose(); });

  it("compute block returning __paused on the durable runtime is rejected with a clear error", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "rogue_pause_durable",
        name: "rogue_pause_durable",
        description: "",
        params: {}, outputs: {},
        async execute() {
          return { __paused: true, reason: "wait_duration", resumeToken: "tok" };
        },
      },
      "rogue_d_block",
    );
    const wf: SerializedWorkflow = oneBlockWf("x", "rogue_d_block");
    wf.metadata = { name: "wf-rogue" };
    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: wf,
    });
    await h.startWorker();
    const handle = await compiled.run({});
    await expect(handle.result()).rejects.toThrow(/Compute block .* returned __paused/);
  });

  it("scales to a 100-block linear chain in under 6 seconds", async () => {
    h = await newDurableHarness();
    const { tools, blocks } = freshRegistries();
    // A no-op transform per block.
    const allBlocks: SerializedWorkflow["blocks"] = [
      { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
    ];
    const allConnections: SerializedWorkflow["connections"] = [];
    let prev = "trg";
    for (let i = 0; i < 100; i++) {
      const id = `t${i}`;
      allBlocks.push({
        id,
        type: "transform",
        enabled: true,
        params: { template: { i } },
      });
      allConnections.push({ source: prev, target: id });
      prev = id;
    }
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: "wf-large" },
      blocks: allBlocks,
      connections: allConnections,
    };
    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: wf,
    });
    await h.startWorker();
    const t0 = Date.now();
    const out = (await (await compiled.run({})).result()) as { outputs: Record<string, any> };
    const dur = Date.now() - t0;
    expect(out.outputs["t99"].result).toEqual({ i: 99 });
    expect(dur).toBeLessThan(6000);
  });
});

describe("template resolution red-team", () => {
  it("deeply-missing path resolves to undefined, not a thrown error", async () => {
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "echo_t",
        name: "",
        description: "",
        params: { v: { type: "string", visibility: "user-or-llm" } },
        outputs: { result: { type: "string" } },
        async execute(p) { return { result: String(p.v) }; },
      },
      "echo_b",
    );
    const r = await execute({
      workflow: oneBlockWf("e", "echo_b", { v: "{{trigger.a.b.c.d.missing}}" }),
      blockRegistry: blocks,
      toolRegistry: tools,
      trigger: {},
    });
    expect(r.success).toBe(true);
    // Single-ref → raw undefined → String(undefined) = "undefined". This is
    // honest — a missing path produces an explicit "undefined" string,
    // surfacing the bug to the caller rather than silently zero-stringing.
    expect((r.outputs["e"] as { result: string }).result).toBe("undefined");
  });

  it("trigger payload that is itself a string with {{ }} does NOT get re-expanded", async () => {
    // Defends against a recursive-template attack: an attacker crafts a
    // webhook payload whose body field is "{{env.SECRET}}" hoping the
    // resolver will helpfully expand it on the way through.
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "passthrough",
        name: "",
        description: "",
        params: { v: { type: "string", visibility: "user-or-llm" } },
        outputs: { result: { type: "string" } },
        async execute(p) { return { result: String(p.v) }; },
      },
      "pass_b",
    );
    const r = await execute({
      workflow: oneBlockWf("p", "pass_b", { v: "{{trigger.body}}" }),
      blockRegistry: blocks,
      toolRegistry: tools,
      trigger: { body: "{{env.SECRET}}" },
      env: { SECRET: "hunter2" },
    });
    expect(r.success).toBe(true);
    // The literal "{{env.SECRET}}" is the value — not "hunter2".
    expect((r.outputs["p"] as { result: string }).result).toBe("{{env.SECRET}}");
  });

  it("`{{trigger}}` (no path) resolves to the whole trigger object intact", async () => {
    const { tools, blocks } = freshRegistries();
    registerCustom(
      tools, blocks,
      {
        id: "pass2",
        name: "",
        description: "",
        params: { v: { type: "object", visibility: "user-or-llm" } },
        outputs: { result: { type: "object" } },
        async execute(p) { return { result: p.v }; },
      },
      "pass2_b",
    );
    const r = await execute({
      workflow: oneBlockWf("p", "pass2_b", { v: "{{trigger}}" }),
      blockRegistry: blocks,
      toolRegistry: tools,
      trigger: { user: { id: 42, name: "Alice" }, count: 7 },
    });
    expect(r.success).toBe(true);
    expect((r.outputs["p"] as { result: any }).result).toEqual({
      user: { id: 42, name: "Alice" },
      count: 7,
    });
  });
});
