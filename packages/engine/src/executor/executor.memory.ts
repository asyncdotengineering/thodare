/**
 * In-memory pause-aware executor.
 *
 * What it does:
 *   - Builds the DAG, topo-sorts, walks blocks in order.
 *   - For trigger blocks, output is the trigger payload.
 *   - For compute blocks, resolves params then invokes the chosen tool.
 *   - For wait blocks, calls the wait tool's execute (which returns a
 *     `PauseInfo` sentinel), STOPS the run, and returns a snapshot the
 *     caller can persist for later resume.
 *
 * Why this matters:
 *   - Identical surface to the openworkflow-backed executor — same workflow
 *     JSON, same block/tool registries, same outputs map.
 *   - Lets us unit-test wfkit's apply/visibility/reference-validation/branching
 *     semantics without spinning up a SQLite database every test.
 *   - The `resume(snapshot, payload)` entry-point exercises the same code
 *     path the durable runtime would take after a worker crash.
 */

import type {
  ExecutionLog,
  ExecutionResult,
  ExecutionSnapshot,
  PauseInfo,
  SerializedBlock,
  SerializedWorkflow,
  ToolContext,
} from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { BlockRegistry } from "../blocks/registry.js";
import { buildDAG, topoSort } from "./dag.js";
import {
  BlockResolver,
  EnvResolver,
  TriggerResolver,
  VariableResolver,
  VarsResolver,
} from "./resolver.js";

export interface ExecuteOptions {
  workflow: SerializedWorkflow;
  toolRegistry: ToolRegistry;
  blockRegistry: BlockRegistry;
  trigger?: unknown;
  env?: Record<string, string>;
  /** Pre-existing block outputs (used during resume; same idea as Sim's `seedOutputs`). */
  seedOutputs?: Record<string, unknown>;
  /** Stable run id; the durable runtime threads its own id in here. */
  executionId?: string;
  onEvent?: (e: ExecutionEvent) => void;
}

export type ExecutionEvent =
  | { type: "block_start"; blockId: string; blockType: string }
  | { type: "block_finish"; blockId: string; blockType: string; success: boolean; durationMs: number }
  | { type: "block_skipped"; blockId: string; reason: string }
  | { type: "block_paused"; blockId: string; blockType: string; pause: PauseInfo };

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export async function execute(opts: ExecuteOptions): Promise<ExecutionResult> {
  const { workflow, toolRegistry, blockRegistry } = opts;
  const env = opts.env ?? {};
  const trigger = opts.trigger ?? {};
  const emit = opts.onEvent ?? (() => {});
  const executionId = opts.executionId ?? `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const dag = buildDAG(workflow);
  const order = topoSort(dag);

  const blockIdsByName = new Map<string, string>();
  for (const b of workflow.blocks) {
    if (b.name) {
      blockIdsByName.set(b.name, b.id);
      blockIdsByName.set(slugify(b.name), b.id);
    }
  }

  const resolver = new VariableResolver([
    new TriggerResolver(),
    new EnvResolver(),
    new VarsResolver(),
    new BlockResolver(),
  ]);

  const blockOutputs: Record<string, unknown> = { ...(opts.seedOutputs ?? {}) };
  const completed = new Set<string>(Object.keys(blockOutputs));
  const logs: ExecutionLog[] = [];
  const skipped = new Set<string>();
  const blocksById = new Map(workflow.blocks.map((b) => [b.id, b]));

  for (const blockId of order) {
    if (completed.has(blockId)) continue;
    if (skipped.has(blockId)) {
      emit({ type: "block_skipped", blockId, reason: "upstream_branch_not_taken" });
      continue;
    }
    const block = blocksById.get(blockId);
    if (!block) continue;

    const blockDef = blockRegistry.get(block.type);
    if (!blockDef) {
      const log = makeFailLog(block, `Unknown block type: ${block.type}`);
      logs.push(log);
      return { success: false, outputs: blockOutputs, logs, error: log.error };
    }

    emit({ type: "block_start", blockId, blockType: block.type });

    if (blockDef.kind === "trigger") {
      blockOutputs[blockId] = trigger;
      completed.add(blockId);
      logs.push(makeOkLog(block, null, trigger, 0));
      emit({ type: "block_finish", blockId, blockType: block.type, success: true, durationMs: 0 });
      continue;
    }

    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    let resolvedParams: Record<string, unknown>;
    try {
      resolvedParams = resolver.resolveValue(block.params, {
        blockOutputs,
        trigger,
        env,
        workflowVars: workflow.variables ?? {},
        blockIdsByName,
        currentBlockId: blockId,
      }) as Record<string, unknown>;
    } catch (e: any) {
      const log = makeFailLog(block, `Param resolution failed: ${e.message}`);
      logs.push(log);
      return { success: false, outputs: blockOutputs, logs, error: log.error };
    }

    const toolId = blockDef.tools.config.tool(resolvedParams);
    if (!blockDef.tools.access.includes(toolId)) {
      const log = makeFailLog(block, `Block ${block.type} not allowed to call tool ${toolId}`);
      logs.push(log);
      return { success: false, outputs: blockOutputs, logs, error: log.error };
    }

    const tool = toolRegistry.get(toolId);
    if (!tool) {
      const log = makeFailLog(block, `Tool not found: ${toolId}`);
      logs.push(log);
      return { success: false, outputs: blockOutputs, logs, error: log.error };
    }

    const toolParams = blockDef.tools.config.params
      ? blockDef.tools.config.params(resolvedParams)
      : resolvedParams;

    const ctx: ToolContext = {
      env,
      executionId,
      blockId,
      log: () => {},
    };

    let output: unknown;
    try {
      output = await tool.execute(toolParams, ctx);
    } catch (e: any) {
      const dur = performance.now() - t0;
      const log: ExecutionLog & { error: string } = {
        blockId,
        blockType: block.type,
        ...(block.name !== undefined ? { blockName: block.name } : {}),
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: dur,
        success: false,
        input: toolParams,
        error: e?.message ?? String(e),
      };
      logs.push(log);
      emit({ type: "block_finish", blockId, blockType: block.type, success: false, durationMs: dur });
      const hasErrorPath = takeBranch(dag, blockId, "error", skipped);
      if (!hasErrorPath) return { success: false, outputs: blockOutputs, logs, error: log.error };
      continue;
    }

    /* Pause sentinel? Stop here and snapshot. */
    if (isPause(output)) {
      const pause = output;
      emit({ type: "block_paused", blockId, blockType: block.type, pause });
      const dur = performance.now() - t0;
      logs.push({
        blockId,
        blockType: block.type,
        ...(block.name !== undefined ? { blockName: block.name } : {}),
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: dur,
        success: true,
        input: toolParams,
        output: pause,
      });
      const snapshot: ExecutionSnapshot = {
        workflowVersion: workflow.version,
        workflow,
        blockOutputs,
        completedBlockIds: [...completed],
        pausedAtBlockId: blockId,
        pause,
        triggerData: trigger,
        pinnedAt: new Date().toISOString(),
      };
      return { success: false, paused: true, snapshot, outputs: blockOutputs, logs };
    }

    /* Compute output recorded as the block's output. */
    blockOutputs[blockId] = output;
    completed.add(blockId);
    const dur = performance.now() - t0;
    logs.push({
      blockId,
      blockType: block.type,
      ...(block.name !== undefined ? { blockName: block.name } : {}),
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: dur,
      success: true,
      input: toolParams,
      output,
    });
    emit({ type: "block_finish", blockId, blockType: block.type, success: true, durationMs: dur });

    selectBranches(dag, blockId, output, skipped);
  }

  return { success: true, outputs: blockOutputs, logs };
}

/**
 * Resume a previously-paused run with the value the wait block "produces"
 * (the resolved event payload, the "approved" object, etc).
 */
export async function resume(
  snapshot: ExecutionSnapshot,
  resumeOutput: unknown,
  ctx: {
    toolRegistry: ToolRegistry;
    blockRegistry: BlockRegistry;
    env?: Record<string, string>;
    onEvent?: (e: ExecutionEvent) => void;
    executionId?: string;
  },
): Promise<ExecutionResult> {
  const seedOutputs = {
    ...snapshot.blockOutputs,
    [snapshot.pausedAtBlockId]: resumeOutput,
  };
  return execute({
    workflow: snapshot.workflow,
    toolRegistry: ctx.toolRegistry,
    blockRegistry: ctx.blockRegistry,
    trigger: snapshot.triggerData,
    seedOutputs,
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx.onEvent !== undefined ? { onEvent: ctx.onEvent } : {}),
    ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}),
  });
}

/* ───────────  Branching  ─────────── */

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

function takeBranch(
  dag: ReturnType<typeof buildDAG>,
  blockId: string,
  handle: string,
  skipped: Set<string>,
): boolean {
  const node = dag.nodes.get(blockId);
  if (!node) return false;
  let any = false;
  for (const [target, edge] of node.outgoing) {
    const h = edge.sourceHandle ?? "__default__";
    if (h === handle) any = true;
    else markDownstreamSkipped(dag, target, skipped);
  }
  return any;
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

/* ───────────  Helpers  ─────────── */

function isPause(v: unknown): v is PauseInfo {
  return !!v && typeof v === "object" && (v as PauseInfo).__paused === true;
}

function makeOkLog(b: SerializedBlock, input: unknown, output: unknown, durMs: number): ExecutionLog {
  const now = new Date().toISOString();
  return {
    blockId: b.id,
    blockType: b.type,
    ...(b.name !== undefined ? { blockName: b.name } : {}),
    startedAt: now,
    endedAt: now,
    durationMs: durMs,
    success: true,
    input,
    output,
  };
}

function makeFailLog(b: SerializedBlock, error: string): ExecutionLog & { error: string } {
  const now = new Date().toISOString();
  return {
    blockId: b.id,
    blockType: b.type,
    ...(b.name !== undefined ? { blockName: b.name } : {}),
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    success: false,
    error,
  };
}
