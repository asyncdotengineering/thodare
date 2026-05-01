/**
 * Shared workflow walker. Used by both:
 *   - buildDurableWorkflow (one openworkflow workflow per SerializedWorkflow)
 *   - buildRuntimeWorkflow (ONE openworkflow workflow that takes the JSON in input)
 *
 * Walk a SerializedWorkflow against an openworkflow `step` API. Returns
 * the per-block outputs map. Throws on:
 *   - unknown block type at runtime
 *   - block not allowed to call its tool
 *   - tool not found in registry
 *   - compute block returns __paused (only kind:'wait' blocks may suspend)
 */

import type { BlockRegistry } from "../blocks/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  BlockResolver,
  EnvResolver,
  TriggerResolver,
  VariableResolver,
  VarsResolver,
} from "../executor/resolver.js";
import { buildDAG, topoSort } from "../executor/dag.js";
import type {
  PauseInfo,
  SerializedBlock,
  SerializedWorkflow,
  ToolContext,
} from "../types.js";

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export interface WalkOptions {
  workflow: SerializedWorkflow;
  trigger: unknown;
  step: any;
  blockRegistry: BlockRegistry;
  toolRegistry: ToolRegistry;
  env: Record<string, string>;
}

export async function walkWorkflow(
  opts: WalkOptions,
): Promise<{ outputs: Record<string, unknown> }> {
  const { workflow, trigger, step, blockRegistry, toolRegistry, env } = opts;
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
      const out = await runWaitBlock(step, block, resolvedParams);
      blockOutputs[blockId] = out;
      continue;
    }

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
      executionId: blockId,
      blockId,
      log: () => {},
    };

    const out = await step.run({ name: stepName(block, "run") }, async () =>
      tool.execute(toolParams, ctx),
    );

    if (isPause(out)) {
      throw new Error(
        `Compute block '${block.id}' (${block.type}) returned __paused. Only kind: 'wait' blocks may suspend on the durable runtime.`,
      );
    }
    blockOutputs[blockId] = out;
    selectBranches(dag, blockId, out, skipped);
  }

  return { outputs: blockOutputs };
}

/* ──────────  Wait block dispatch  ────────── */

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
      return { data: sig?.data ?? null, timedOut: sig === null };
    }
    case "human_approval": {
      const token = String(resolvedParams["resumeToken"] ?? `tok_${block.id}`);
      const timeoutHours = (resolvedParams["timeoutHours"] as number | undefined) ?? 24 * 7;
      const sig = await step.waitForSignal({
        name: stepName(block, "wait"),
        signal: `human_approval:${token}`,
        timeout: `${Math.ceil(timeoutHours * 3600)}s`,
      });
      return { ...((sig?.data as object) ?? {}), _timedOut: sig === null };
    }
    default:
      throw new Error(`unsupported wait block type: ${block.type}`);
  }
}

/* ──────────  Helpers  ────────── */

export function stepName(block: SerializedBlock, suffix: string): string {
  return `block.${block.id}.${suffix}`;
}

export function isPause(v: unknown): v is PauseInfo {
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
    case "milliseconds": return duration;
    case "s":
    case "seconds": return duration * 1000;
    case "m":
    case "minutes": return duration * 60_000;
    case "h":
    case "hours": return duration * 3_600_000;
    case "d":
    case "days": return duration * 86_400_000;
    case "w":
    case "weeks": return duration * 7 * 86_400_000;
    default: throw new Error(`unsupported duration unit: ${unit}`);
  }
}
