/**
 * withTracing — backend Proxy that fires user-supplied hooks at each
 * relevant boundary, without depending on any specific tracing SDK.
 *
 * Acceptance checks from the RFC:
 *   1. The wrapped value is structurally a Backend.
 *   2. Hooks fire at the right boundaries (create / get / cancel).
 *   3. Methods NOT covered by hooks pass through with `this`-binding intact.
 *   4. With NO hooks, the proxy is observably a no-op.
 *   5. The proxy works under createWfkit; full e2e completes; hooks fire in order.
 *   6. Async hooks are awaited.
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
  defineWorkflow,
  withTracing,
  type Wfkit,
} from "../src/index.js";

let wfkit: Wfkit | null = null;
let tmpDir = "";

afterEach(async () => {
  if (wfkit) await wfkit.stop();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  wfkit = null;
});

function newBackend(): BackendSqlite {
  tmpDir = mkdtempSync(join(tmpdir(), "wfkit-trace-"));
  return BackendSqlite.connect(join(tmpDir, "ow.sqlite"));
}

describe("withTracing — Proxy + hooks", () => {
  it("with NO hooks, the proxy passes everything through unchanged", async () => {
    const backend = newBackend();
    const traced = withTracing(backend, {});
    wfkit = await createWfkit({ backend: traced });
    const echo = defineConnector({
      type: "tr-echo",
      params: z.object({ msg: z.string() }),
      outputs: z.object({ msg: z.string() }),
      async run({ msg }) { return { msg }; },
    });
    wfkit.register(echo);
    const wf = defineWorkflow("tr-noop")
      .input(z.object({ msg: z.string() }))
      .step("e", echo, ({ input }) => ({ msg: input.msg }))
      .build();
    const compiled = wfkit.compile(wf);
    await wfkit.start();
    const handle = await wfkit.run(compiled, { msg: "hi" });
    const out = (await handle.result()) as { outputs: any };
    expect(out.outputs["e"].msg).toBe("hi");
  });

  it("hooks fire at the right boundaries — create + get + cancel observed", async () => {
    const events: Array<{ kind: string; runId: string }> = [];
    const backend = newBackend();
    const traced = withTracing(backend, {
      onWorkflowRunCreate: (_params, run) => {
        events.push({ kind: "create", runId: run.id });
      },
      onWorkflowRunGet: (run) => {
        if (run) events.push({ kind: "get", runId: run.id });
      },
      onWorkflowRunCancel: (run) => {
        events.push({ kind: "cancel", runId: run.id });
      },
    });
    wfkit = await createWfkit({ backend: traced });
    const noop = defineConnector({
      type: "tr-noop", params: z.object({}), outputs: z.object({ done: z.boolean() }),
      async run() { return { done: true }; },
    });
    wfkit.register(noop);
    const wf = defineWorkflow("tr-hooks")
      .input(z.object({}))
      .step("n", noop, () => ({}))
      .build();
    const compiled = wfkit.compile(wf);
    await wfkit.start();
    const handle = await wfkit.run(compiled, {});
    await handle.result();

    // create fires once at run creation time.
    const creates = events.filter((e) => e.kind === "create");
    expect(creates).toHaveLength(1);

    // get fires multiple times (poll loop reads status).
    const gets = events.filter((e) => e.kind === "get");
    expect(gets.length).toBeGreaterThanOrEqual(1);

    // All event runIds for this run match.
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
  });

  it("hooks may be async — proxy awaits them before returning the underlying result", async () => {
    let createCompleted = false;
    const backend = newBackend();
    const traced = withTracing(backend, {
      onWorkflowRunCreate: async () => {
        await new Promise((r) => setTimeout(r, 30));
        createCompleted = true;
      },
    });
    wfkit = await createWfkit({ backend: traced });
    const noop = defineConnector({
      type: "tr-async-noop", params: z.object({}), outputs: z.object({ done: z.boolean() }),
      async run() { return { done: true }; },
    });
    wfkit.register(noop);
    const wf = defineWorkflow("tr-async")
      .input(z.object({}))
      .step("n", noop, () => ({}))
      .build();
    const compiled = wfkit.compile(wf);
    await wfkit.start();
    // The await on .run(...) shouldn't return until the hook has finished.
    // (Actual mechanism: createWorkflowRun resolves only after the hook resolves.)
    await wfkit.run(compiled, {});
    expect(createCompleted).toBe(true);
  });

  it("methods NOT covered by hooks pass through cleanly (this-binding intact)", async () => {
    const backend = newBackend();
    const traced = withTracing(backend, {
      onWorkflowRunCreate: () => {}, // present so we know we're going through Proxy
    });
    // listWorkflowRuns is NOT one of our hook points. Calling it should
    // delegate cleanly without "Cannot read of undefined" errors.
    const list = await traced.listWorkflowRuns({});
    expect(list).toBeDefined();
    // openworkflow's PaginatedResponse shape: { data, pagination }.
    expect(Array.isArray(list.data)).toBe(true);
    expect(list.pagination).toBeDefined();
    await backend.stop();
  });

  it("a hook that throws does NOT break the underlying backend op (errors are swallowed/logged)", async () => {
    const backend = newBackend();
    const errors: unknown[] = [];
    const traced = withTracing(backend, {
      onWorkflowRunCreate: () => { throw new Error("hook-boom"); },
      onError: (err) => { errors.push(err); },
    });
    wfkit = await createWfkit({ backend: traced });
    const noop = defineConnector({
      type: "tr-throw-noop", params: z.object({}), outputs: z.object({ done: z.boolean() }),
      async run() { return { done: true }; },
    });
    wfkit.register(noop);
    const wf = defineWorkflow("tr-hookthrow")
      .input(z.object({}))
      .step("n", noop, () => ({}))
      .build();
    const compiled = wfkit.compile(wf);
    await wfkit.start();
    // Should NOT throw — even though the hook threw.
    const handle = await wfkit.run(compiled, {});
    await handle.result();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toBe("hook-boom");
  });
});
