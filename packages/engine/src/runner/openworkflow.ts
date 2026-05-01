/**
 * The durable runtime: walks the same wfkit DAG, but each compute block runs
 * inside `step.run` (so its result is memoized across replays), and each
 * `kind: 'wait'` block maps directly to openworkflow's native primitive:
 *
 *   wait_duration   ⇒ step.sleep
 *   wait_for_event  ⇒ step.waitForSignal
 *   human_approval  ⇒ step.waitForSignal (token-scoped signal)
 *
 * The wfkit `__paused` sentinel is intercepted INSIDE the workflow function,
 * not exposed to the user. The workflow function itself never returns
 * "paused" — it just blocks on the openworkflow primitive and resumes when
 * the runtime hands the result back.
 *
 * Why this pattern matters:
 *   - openworkflow's backend (Postgres / SQLite) is the durability boundary,
 *     so we don't need a `pauseSnapshots` table or a cron reconciler.
 *   - Step keys are derived from stable block IDs, so replays after a worker
 *     crash dispatch correctly.
 *   - The wfkit DSL stays identical to the dev-mode in-memory executor.
 */

import type { OpenWorkflow } from "@thodare/openworkflow";
import type { Backend } from "@thodare/openworkflow/internal";
import type {
  PauseInfo,
  SerializedBlock,
  SerializedWorkflow,
  ToolContext,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { BlockRegistry } from "../blocks/registry.js";
import { buildDAG, topoSort } from "../executor/dag.js";
import {
  BlockResolver,
  EnvResolver,
  TriggerResolver,
  VariableResolver,
  VarsResolver,
} from "../executor/resolver.js";
import { createDurableHandle, type DurableHandle } from "./handle.js";

export interface BuildDurableOptions {
  /** OpenWorkflow client — workflows must be defined BEFORE `newWorker()`. */
  ow: OpenWorkflow;
  /** The backend the OpenWorkflow client was constructed with. Required so
   * the returned handle can offer describe / result / cancel via the backend
   * directly — sidestepping openworkflow's 5-minute hardcoded `result()`
   * timeout. The OpenWorkflow class does not re-expose its backend, so it
   * must be passed in explicitly. */
  backend: Backend;
  blockRegistry: BlockRegistry;
  toolRegistry: ToolRegistry;
  workflow: SerializedWorkflow;
  /** Stable name for openworkflow registration. Defaults to workflow.metadata.name. */
  name?: string;
  /** Env injected into ToolContext.env at run time. */
  env?: Record<string, string>;
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * Translate a wfkit workflow into an openworkflow workflow definition.
 * Returns the same handle openworkflow's `defineWorkflow` returns — call
 * `.run(input)` on it.
 */
/** Structural alias for openworkflow's internal WorkflowRunHandle. We can't
 * import it directly (the class isn't exported); this captures the public
 * surface — `workflowRun.id`, `result(opts?)`, `cancel()`. New code should
 * prefer `runDurable` below for sensible defaults. */
export type RawRunHandle = Awaited<
  ReturnType<ReturnType<OpenWorkflow["defineWorkflow"]>["run"]>
>;

export interface DurableWorkflow {
  /** The raw openworkflow handle's `run`. Returns openworkflow's native
   * WorkflowRunHandle (which has the 5-minute hardcoded `result()` timeout —
   * pass `{ timeoutMs }` if you need longer, or use `runDurable` instead). */
  run: (input: unknown, options?: { idempotencyKey?: string }) => Promise<RawRunHandle>;
  /** Start a run AND get back the friendly handle (id, describe, result, cancel). */
  runDurable: (
    input: unknown,
    options?: { idempotencyKey?: string; defaultTimeoutMs?: number; pollIntervalMs?: number },
  ) => Promise<DurableHandle>;
  /** Reattach to an existing run by id. */
  getHandle: (
    runId: string,
    options?: { defaultTimeoutMs?: number; pollIntervalMs?: number },
  ) => DurableHandle;
}

export function buildDurableWorkflow(opts: BuildDurableOptions): DurableWorkflow {
  const { ow, backend, blockRegistry, toolRegistry, workflow } = opts;
  const wfName = opts.name ?? workflow.metadata?.name ?? `wfkit-${Date.now()}`;
  const env = opts.env ?? {};

  const compiled = ow.defineWorkflow(
    { name: slugify(wfName) },
    async ({ input, step }) => {
      const dag = buildDAG(workflow);
      const order = topoSort(dag);

      const blocksById = new Map(workflow.blocks.map((b) => [b.id, b]));
      const blockIdsByName = new Map<string, string>();
      for (const b of workflow.blocks) {
        if (b.name) {
          blockIdsByName.set(b.name, b.id);
          blockIdsByName.set(slugify(b.name), b.id);
        }
      }

      const blockOutputs: Record<string, unknown> = {};
      const skipped = new Set<string>();
      const trigger = input ?? {};

      const resolver = new VariableResolver([
        new TriggerResolver(),
        new EnvResolver(),
        new VarsResolver(),
        new BlockResolver(),
      ]);

      for (const blockId of order) {
        if (skipped.has(blockId)) continue;
        const block = blocksById.get(blockId)!;
        const def = blockRegistry.get(block.type);
        if (!def) throw new Error(`unknown block type at runtime: ${block.type}`);

        if (def.kind === "trigger") {
          blockOutputs[blockId] = trigger;
          continue;
        }

        const resolvedParams = resolver.resolveValue(block.params, {
          blockOutputs,
          trigger,
          env,
          workflowVars: workflow.variables ?? {},
          blockIdsByName,
          currentBlockId: blockId,
        }) as Record<string, unknown>;

        if (def.kind === "wait") {
          /* Map declarative wait → native openworkflow primitive. */
          const out = await runWaitBlock(step, block, resolvedParams);
          blockOutputs[blockId] = out;
          continue;
        }

        /* Compute block: run inside step.run so the result is cached on replay. */
        const toolId = def.tools.config.tool(resolvedParams);
        if (!def.tools.access.includes(toolId)) {
          throw new Error(`block ${block.type} not allowed to call tool ${toolId}`);
        }
        const tool = toolRegistry.get(toolId);
        if (!tool) throw new Error(`tool not found: ${toolId}`);
        const toolParams = def.tools.config.params
          ? def.tools.config.params(resolvedParams)
          : resolvedParams;

        const ctx: ToolContext = {
          env,
          executionId: blockId, // openworkflow exposes its own run id internally; we tag the step name with blockId.
          blockId,
          log: () => {},
        };

        const out = await step.run({ name: stepName(block, "run") }, async () =>
          tool.execute(toolParams, ctx),
        );

        if (isPause(out)) {
          // Compute blocks aren't allowed to pause durably — only declared
          // wait-kind blocks are. Surface a clear error to the workflow author.
          throw new Error(
            `Compute block '${block.id}' (${block.type}) returned __paused. Only kind: 'wait' blocks may suspend on the durable runtime.`,
          );
        }
        blockOutputs[blockId] = out;
        selectBranches(dag, blockId, out, skipped);
      }

      return { outputs: blockOutputs };
    },
  );

  return {
    run: (input, options) => compiled.run(input as never, options),
    runDurable: async (input, options) => {
      const handle = await compiled.run(
        input as never,
        options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : undefined,
      );
      return createDurableHandle(backend, handle.workflowRun.id, {
        ...(options?.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}),
        ...(options?.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      });
    },
    getHandle: (runId, options) =>
      createDurableHandle(backend, runId, {
        ...(options?.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}),
        ...(options?.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      }),
  };
}

/* ──────────────────  Wait block dispatch  ────────────────── */

async function runWaitBlock(
  step: any,
  block: SerializedBlock,
  resolvedParams: Record<string, unknown>,
): Promise<unknown> {
  switch (block.type) {
    case "wait_duration": {
      const ms = toMs(Number(resolvedParams["duration"]), String(resolvedParams["unit"]));
      const seconds = Math.max(1, Math.ceil(ms / 1000));
      await step.sleep(stepName(block, "sleep"), `${seconds}s`);
      return { resumedAt: new Date().toISOString() };
    }
    case "wait_for_event": {
      const eventName = String(resolvedParams["eventName"]);
      const timeoutHours = resolvedParams["timeoutHours"] as number | undefined;
      const timeout = timeoutHours ? `${Math.ceil(timeoutHours * 3600)}s` : undefined;
      const sig = await step.waitForSignal({
        name: stepName(block, "wait"),
        signal: eventName,
        ...(timeout ? { timeout } : {}),
      });
      // openworkflow returns `{ data }` on delivery, `null` on timeout.
      return { data: sig?.data ?? null, timedOut: sig === null };
    }
    case "human_approval": {
      // The token is part of the wait block's params after substitution if
      // the workflow author wires it through; otherwise we generate one
      // deterministically from the block id so replays match.
      const token = String(resolvedParams["resumeToken"] ?? `tok_${block.id}`);
      const timeoutHours = (resolvedParams["timeoutHours"] as number | undefined) ?? 24 * 7;
      const sig = await step.waitForSignal({
        name: stepName(block, "wait"),
        signal: `human_approval:${token}`,
        timeout: `${Math.ceil(timeoutHours * 3600)}s`,
      });
      return { ...(sig?.data as object ?? {}), _timedOut: sig === null };
    }
    default:
      throw new Error(`unsupported wait block type: ${block.type}`);
  }
}

/* ──────────────────  Helpers  ────────────────── */

function stepName(block: SerializedBlock, suffix: string): string {
  return `block.${block.id}.${suffix}`;
}

function isPause(v: unknown): v is PauseInfo {
  return !!v && typeof v === "object" && (v as PauseInfo).__paused === true;
}

function selectBranches(
  dag: ReturnType<typeof buildDAG>,
  blockId: string,
  output: unknown,
  skipped: Set<string>,
): void {
  const node = dag.nodes.get(blockId);
  if (!node) return;
  const groups = new Map<string, string[]>();
  for (const [target, edge] of node.outgoing) {
    const handle = edge.sourceHandle ?? "__default__";
    const arr = groups.get(handle) ?? [];
    arr.push(target);
    groups.set(handle, arr);
  }
  if (groups.size <= 1) return;
  const taken = new Set<string>();
  if (groups.has("success")) taken.add("success");
  const out = output as { branch?: string; result?: boolean } | null | undefined;
  if (out && typeof out.branch === "string" && groups.has(out.branch)) taken.add(out.branch);
  if (out && typeof out.result === "boolean") taken.add(out.result ? "true" : "false");
  if (taken.size === 0 && groups.has("__default__")) taken.add("__default__");
  for (const [handle, targets] of groups) {
    if (taken.has(handle)) continue;
    for (const t of targets) markDownstreamSkipped(dag, t, skipped);
  }
}

function markDownstreamSkipped(
  dag: ReturnType<typeof buildDAG>,
  blockId: string,
  skipped: Set<string>,
): void {
  if (skipped.has(blockId)) return;
  skipped.add(blockId);
  const node = dag.nodes.get(blockId);
  if (!node) return;
  for (const t of node.outgoing.keys()) markDownstreamSkipped(dag, t, skipped);
}

function toMs(duration: number, unit: string): number {
  switch (unit) {
    case "ms":
    case "milliseconds":
      return duration;
    case "s":
    case "seconds":
      return duration * 1000;
    case "m":
    case "minutes":
      return duration * 60_000;
    case "h":
    case "hours":
      return duration * 3_600_000;
    case "d":
    case "days":
      return duration * 86_400_000;
    case "w":
    case "weeks":
      return duration * 7 * 86_400_000;
    default:
      throw new Error(`unsupported duration unit: ${unit}`);
  }
}
