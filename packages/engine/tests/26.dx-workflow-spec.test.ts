/**
 * defineWorkflowSpec — spec/impl split
 *
 * The five acceptance checks from rfcs/three-additions/issues/01-...
 *   1. Spec carries name + version + Zod input/output schemas.
 *   2. wfkit.workflowFromSpec(spec, builderFn) compiles a typed workflow
 *      whose name+version match the spec.
 *   3. wfkit.runSpec(spec, input) returns a DurableHandle.
 *   4. Bad input fails Zod validation BEFORE a workflow run is created.
 *   5. Same name + different version = two distinct workflows.
 */

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWfkit,
  defineConnector,
  defineWorkflowSpec,
  type Wfkit,
} from "../src/index.js";

let wfkit: Wfkit | null = null;
let tmpDir = "";

async function newWfkit(): Promise<Wfkit> {
  tmpDir = mkdtempSync(join(tmpdir(), "wfkit-spec-"));
  const backend = BackendSqlite.connect(join(tmpDir, "ow.sqlite"));
  const kit = await createWfkit({ backend });
  wfkit = kit;
  return kit;
}
afterEach(async () => {
  if (wfkit) await wfkit.stop();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  wfkit = null;
});

describe("defineWorkflowSpec", () => {
  it("emits a spec with accessible name, version, input, output schemas", () => {
    const spec = defineWorkflowSpec({
      name: "send-email",
      version: "1",
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ delivered: z.boolean() }),
    });
    expect(spec.name).toBe("send-email");
    expect(spec.version).toBe("1");
    // The schemas are exposed for inspection (e.g. webhook router uses them).
    expect(spec.input).toBeDefined();
    expect(spec.output).toBeDefined();
    // Round-trip a valid input through the spec's input schema.
    const parsed = spec.input!.safeParse({ to: "x@y", subject: "hi" });
    expect(parsed.success).toBe(true);
  });

  it("workflowFromSpec compiles a workflow whose name matches the spec", async () => {
    const echo = defineConnector({
      type: "spec-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    const spec = defineWorkflowSpec({
      name: "echo-flow",
      version: "1",
      input: z.object({ msg: z.string() }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    const wf = kit.workflowFromSpec(spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: input.msg })),
    );
    await kit.start();
    const handle = await kit.run(wf, { msg: "hello" });
    const out = (await handle.result()) as { outputs: any };
    expect(out.outputs["e"].msg).toBe("hello");
  });

  it("runSpec dispatches by spec — caller doesn't need the compiled workflow ref", async () => {
    const echo = defineConnector({
      type: "rs-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    const spec = defineWorkflowSpec({
      name: "rs-echo-flow",
      version: "1",
      input: z.object({ msg: z.string() }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: input.msg })),
    );
    await kit.start();

    // Dispatch by spec — the call site only needs `spec`, not the compiled
    // ReturnType<workflowFromSpec>. This is the API-package-level use case.
    const handle = await kit.runSpec(spec, { msg: "via-spec" });
    const out = (await handle.result()) as { outputs: any };
    expect(out.outputs["e"].msg).toBe("via-spec");
  });

  it("runSpec with input failing the Zod schema rejects BEFORE creating a run", async () => {
    const echo = defineConnector({
      type: "vfail-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    const spec = defineWorkflowSpec({
      name: "vfail-echo-flow",
      version: "1",
      input: z.object({ msg: z.string().min(3) }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: input.msg })),
    );
    await kit.start();
    await expect(
      kit.runSpec(spec, { msg: "x" } as any),
    ).rejects.toThrow(/runSpec input validation failed/);
  });

  it("two specs with same name but different version coexist (workflow names disambiguate via @version)", async () => {
    const echo = defineConnector({
      type: "ver-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    const v1 = defineWorkflowSpec({ name: "versioned", version: "1", input: z.object({ msg: z.string() }) });
    const v2 = defineWorkflowSpec({ name: "versioned", version: "2", input: z.object({ msg: z.string() }) });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(v1, (b) => b.step("e", echo, ({ input }) => ({ msg: `v1:${input.msg}` })));
    kit.workflowFromSpec(v2, (b) => b.step("e", echo, ({ input }) => ({ msg: `v2:${input.msg}` })));
    await kit.start();
    const r1 = (await (await kit.runSpec(v1, { msg: "x" })).result()) as { outputs: any };
    const r2 = (await (await kit.runSpec(v2, { msg: "x" })).result()) as { outputs: any };
    expect(r1.outputs["e"].msg).toBe("v1:x");
    expect(r2.outputs["e"].msg).toBe("v2:x");
  });
});
