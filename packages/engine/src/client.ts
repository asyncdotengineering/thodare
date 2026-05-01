/**
 * `createWfkit` — the high-level façade. Bundles backend + ow + registries +
 * worker lifecycle into a single object so the typical setup is one call:
 *
 *     const wfkit = await createWfkit({ backend });
 *     wfkit.register(slack, http, transform);
 *     await wfkit.start();
 *     const compiled = wfkit.compile(workflow);
 *     const handle = await wfkit.run(compiled, { topic: "x" });
 *
 * Why a class-shaped façade instead of free functions: registry ordering,
 * worker lifecycle, and backend ownership are coupled — having one object
 * own all three eliminates an entire class of "wrong order" bugs that the
 * old API exposed (define-before-newWorker, etc.).
 *
 * The lower-level API (buildDurableWorkflow / applyOperations / new ToolRegistry)
 * still exists and the existing tests still use it. createWfkit is the
 * recommended entry point for new code.
 */

import { OpenWorkflow } from "@thodare/openworkflow";
import type { Backend } from "@thodare/openworkflow/internal";
import { applyOperations } from "./operations/apply.js";
import type { ApplyOpsResult } from "./types.js";
import { BlockRegistry } from "./blocks/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerBuiltinBlocks } from "./blocks/builtin.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { registerWaitTools } from "./tools/waits.js";
import { buildDurableWorkflow, type DurableWorkflow } from "./runner/openworkflow.js";
import { buildRuntimeWorkflow, type RuntimeWorkflow } from "./runner/runtime-workflow.js";
import type { ConnectorDef } from "./define/connector.js";
import type { DurableHandle } from "./runner/handle.js";
import type { EditOp, SerializedWorkflow } from "./types.js";
import { defineWorkflow, type WorkflowBuilder } from "./define/workflow.js";
import { specRuntimeName, type WorkflowSpec } from "./define/spec.js";

export interface CreateWfkitOptions {
  /** Pass `BackendSqlite` or `BackendPostgres` (or any Backend impl). */
  backend: Backend;
  /** Worker concurrency. Default: 4. */
  concurrency?: number;
  /** Env values made available to every connector via `ctx.env`. */
  env?: Record<string, string>;
  /** If false, builtin connectors (http / slack / transform / wait_*) are NOT registered. Default: true. */
  registerBuiltins?: boolean;
}

export interface Wfkit {
  /** Underlying OpenWorkflow instance — escape hatch for advanced use. */
  readonly ow: OpenWorkflow;
  readonly backend: Backend;

  /**
   * Register one or more connectors. Both the underlying Tool and Block are
   * added to the kit's registries.
   */
  register: (...connectors: ConnectorDef[]) => Wfkit;

  /**
   * Apply an LLM-emitted patch (EditOp[]) against a workflow. Returns
   * `{ ok, workflow, validation_errors, skipped_items, summary }` exactly
   * like the lower-level `applyOperations` — the LLM-facing semantic is
   * unchanged.
   */
  applyOps: (workflow: SerializedWorkflow, ops: EditOp[]) => ApplyOpsResult;

  /**
   * Compile a `SerializedWorkflow` (whether from the builder or from JSON)
   * into a runnable durable workflow. Must be called BEFORE `start()`.
   */
  compile: (workflow: SerializedWorkflow) => DurableWorkflow;

  /**
   * Convenience: compile + run in one call. Equivalent to
   *   `(await wfkit.compile(wf).runDurable(input))`.
   */
  run: (compiled: DurableWorkflow, input: unknown, opts?: { idempotencyKey?: string }) => Promise<DurableHandle>;

  /** Start the worker. Workflows must already be `compile`d. */
  start: (concurrency?: number) => Promise<void>;
  /** Restart the worker (re-snapshots the registry). */
  restart: (concurrency?: number) => Promise<void>;
  /** Stop the worker AND close the backend. */
  stop: () => Promise<void>;
  /** Stop the worker only — leaves the backend open. */
  stopWorker: () => Promise<void>;

  /** Reattach to an existing run by id. Returns a `DurableHandle`. */
  getHandle: (compiled: DurableWorkflow, runId: string) => DurableHandle;

  /**
   * Compile a workflow defined as a `WorkflowSpec`. The spec carries the
   * workflow's name + version + Zod schemas; the impl is the second arg
   * (a function that takes a typed builder and returns the built workflow).
   *
   * Mistle's pattern: the spec lives in a shared package; the impl lives
   * in the worker. Both reference the same constant.
   */
  workflowFromSpec: <
    SpecT extends WorkflowSpec<any, any, any, any>,
  >(
    spec: SpecT,
    builderFn: (
      b: WorkflowBuilder<SpecInputType<SpecT>, {}>,
    ) => WorkflowBuilder<SpecInputType<SpecT>, any>,
  ) => DurableWorkflow;

  /**
   * Run a workflow by spec. Validates the input against `spec.input` (if
   * present) BEFORE creating a run, so bad inputs fail fast and don't
   * pollute the workflow_runs table.
   *
   * The caller doesn't need the compiled DurableWorkflow ref — only the
   * spec. Useful in API services that share specs with workers.
   */
  runSpec: <SpecT extends WorkflowSpec<any, any, any, any>>(
    spec: SpecT,
    input: SpecInputType<SpecT>,
    opts?: { idempotencyKey?: string },
  ) => Promise<DurableHandle>;

  /**
   * LLM-facing block catalog. Each entry is the small projection (type,
   * name, description, category, kind) suitable for inclusion in a system
   * prompt. For full block metadata fetch one with `connector(type)`.
   */
  catalog: () => Array<{ type: string; name: string; description: string; category: string; kind: string }>;

  /** Fetch one block's full metadata (subBlocks, outputs, allowed tools). null on unknown type. */
  connector: (type: string) => {
    type: string;
    name: string;
    description: string;
    category: string;
    kind: string;
    subBlocks: ReadonlyArray<{ id: string; title: string; type: string; required?: boolean; description?: string }>;
    outputs: Record<string, { type: string; description?: string }>;
  } | null;

  /**
   * The @thodare/engine runtime workflow — ONE openworkflow workflow that
   * accepts `{ workflow, input }` and walks it dynamically. Lazy: first
   * call registers it on the underlying OpenWorkflow client; subsequent
   * calls return the same instance.
   *
   * Use this when your application creates new workflows AFTER worker
   * start (the typical control-panel pattern) — workers don't need to
   * restart per workflow create because every run goes through the
   * runtime workflow.
   */
  runtime: () => RuntimeWorkflow;
}

/** Helper: extract the input type from a WorkflowSpec. */
type SpecInputType<S> = S extends WorkflowSpec<infer I, any, any, any> ? I : never;

export async function createWfkit(opts: CreateWfkitOptions): Promise<Wfkit> {
  const { backend } = opts;
  const ow = new OpenWorkflow({ backend });
  const tools = new ToolRegistry();
  const blocks = new BlockRegistry();
  const env = opts.env ?? {};

  if (opts.registerBuiltins !== false) {
    registerBuiltinTools(tools);
    registerWaitTools(tools);
    registerBuiltinBlocks(blocks);
  }

  let worker: { start(): Promise<void>; stop(): Promise<void> } | null = null;

  // runtime-name → compiled DurableWorkflow, populated by workflowFromSpec
  // so runSpec can dispatch by spec without holding the compiled ref.
  const specRegistry = new Map<string, DurableWorkflow>();
  // Lazy-registered wfkit runtime workflow.
  let runtimeRef: RuntimeWorkflow | null = null;

  const ensureNotStarted = (op: string): void => {
    if (worker) throw new Error(`wfkit.${op} cannot be called after start() — define and register everything BEFORE starting the worker (openworkflow snapshots its registry at start). Use restart() to apply changes.`);
  };

  const wfkit: Wfkit = {
    ow,
    backend,
    register(...connectors) {
      ensureNotStarted("register");
      for (const c of connectors) {
        if (!tools.has(c.tool.id)) tools.register(c.tool);
        if (!blocks.has(c.block.type)) blocks.register(c.block);
      }
      return wfkit;
    },
    applyOps(workflow, ops) {
      return applyOperations({ workflow, ops, blockRegistry: blocks, toolRegistry: tools });
    },
    compile(workflow) {
      ensureNotStarted("compile");
      return buildDurableWorkflow({
        ow,
        backend,
        blockRegistry: blocks,
        toolRegistry: tools,
        workflow,
        env,
      });
    },
    async run(compiled, input, runOpts) {
      return compiled.runDurable(input, runOpts);
    },
    async start(concurrency) {
      if (worker) throw new Error("worker already started");
      worker = ow.newWorker({ concurrency: concurrency ?? opts.concurrency ?? 4 });
      await worker.start();
    },
    async restart(concurrency) {
      if (worker) {
        try { await worker.stop(); } catch {}
      }
      worker = ow.newWorker({ concurrency: concurrency ?? opts.concurrency ?? 4 });
      await worker.start();
    },
    async stopWorker() {
      if (worker) {
        try { await worker.stop(); } finally { worker = null; }
      }
    },
    async stop() {
      try { if (worker) await worker.stop(); } catch {}
      worker = null;
      try { await backend.stop(); } catch {}
    },
    getHandle(compiled, runId) {
      return compiled.getHandle(runId);
    },
    workflowFromSpec(spec, builderFn) {
      ensureNotStarted("workflowFromSpec");
      // Build the workflow JSON via the typed builder; the builder's name
      // gets the `${name}@${version}` form so two specs with the same name
      // and different versions don't collide.
      const runtimeName = specRuntimeName(spec);
      const builder = defineWorkflow(runtimeName);
      const finalBuilder = builderFn(builder as any);
      const workflowJson = finalBuilder.build();
      // Track the spec → compiled mapping so runSpec can dispatch later.
      const compiled = buildDurableWorkflow({
        ow, backend, blockRegistry: blocks, toolRegistry: tools, workflow: workflowJson, env,
      });
      specRegistry.set(runtimeName, compiled);
      return compiled;
    },
    async runSpec(spec, input, runOpts) {
      const runtimeName = specRuntimeName(spec);
      const compiled = specRegistry.get(runtimeName);
      if (!compiled) {
        throw new Error(
          `runSpec: no workflow registered for ${runtimeName}. Did you call workflowFromSpec(${spec.name}@${spec.version}, ...) before start()?`,
        );
      }
      // Validate at the boundary BEFORE creating a run.
      if (spec.input) {
        const parsed = spec.input.safeParse(input);
        if (!parsed.success) {
          throw new Error(
            `runSpec input validation failed for ${runtimeName}: ${parsed.error.errors
              .map((e: { path: (string | number)[]; message: string }) => `${e.path.join(".")} — ${e.message}`)
              .join("; ")}`,
          );
        }
      }
      return compiled.runDurable(input, runOpts);
    },
    runtime() {
      if (runtimeRef) return runtimeRef;
      ensureNotStarted("runtime");
      runtimeRef = buildRuntimeWorkflow({
        ow, backend, blockRegistry: blocks, toolRegistry: tools, env,
      });
      return runtimeRef;
    },
    catalog() {
      return blocks.catalog();
    },
    connector(type) {
      const b = blocks.get(type);
      if (!b) return null;
      return {
        type: b.type,
        name: b.name,
        description: b.description,
        category: b.category,
        kind: b.kind,
        subBlocks: b.subBlocks,
        outputs: b.outputs,
      };
    },
  };

  return wfkit;
}
