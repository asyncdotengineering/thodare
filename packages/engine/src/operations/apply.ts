/**
 * The AI-facing surface. The LLM never writes whole workflow JSON;
 * it emits a list of `EditOp`s. Each op is validated independently
 * and either applied or skipped (with a typed reason).
 *
 * Lifted unchanged from wfkit/src/operations/apply.ts because that's the
 * jewel of the design. Adapted only for the @thodare/engine types module path
 * and a clearer skip-reason name.
 */

import type {
  ApplyOpsResult,
  EditOp,
  SerializedBlock,
  SerializedConnection,
  SerializedWorkflow,
  SkippedItem,
  ValidationError,
} from "../types.js";
import type { BlockRegistry } from "../blocks/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import { VariableResolver } from "../executor/resolver.js";
import { buildDAG } from "../executor/dag.js";

export interface ApplyOpsOptions {
  workflow: SerializedWorkflow;
  ops: EditOp[];
  blockRegistry: BlockRegistry;
  toolRegistry: ToolRegistry;
}

export function applyOperations(opts: ApplyOpsOptions): ApplyOpsResult {
  const { ops, blockRegistry, toolRegistry } = opts;
  // Deep-copy so we never mutate caller state.
  const wf: SerializedWorkflow = JSON.parse(JSON.stringify(opts.workflow));

  const skipped: SkippedItem[] = [];
  const errors: ValidationError[] = [];

  for (const op of ops) {
    switch (op.operation_type) {
      case "add":
        applyAdd(wf, op, blockRegistry, toolRegistry, skipped, errors);
        break;
      case "edit":
        applyEdit(wf, op, blockRegistry, toolRegistry, skipped, errors);
        break;
      case "delete":
        applyDelete(wf, op, skipped);
        break;
      case "connect":
        applyConnect(wf, op, skipped);
        break;
      case "disconnect":
        applyDisconnect(wf, op, skipped);
        break;
    }
  }

  /* Whole-graph validation after all ops applied. */
  try {
    buildDAG(wf);
  } catch (e: any) {
    errors.push({
      block_id: "*",
      block_type: "*",
      error: `Graph invalid after operations: ${e.message}`,
    });
  }

  validateReferences(wf, blockRegistry, errors);

  return {
    ok: errors.length === 0 && skipped.length === 0,
    workflow: wf,
    validation_errors: errors,
    skipped_items: skipped,
    summary: summarize(ops.length, skipped, errors),
  };
}

/* ─────────────  Operation handlers  ───────────── */

function applyAdd(
  wf: SerializedWorkflow,
  op: Extract<EditOp, { operation_type: "add" }>,
  blockReg: BlockRegistry,
  toolReg: ToolRegistry,
  skipped: SkippedItem[],
  errors: ValidationError[],
): void {
  if (wf.blocks.find((b) => b.id === op.block_id)) {
    skipped.push({
      reason_code: "block_already_exists",
      operation_type: "add",
      block_id: op.block_id,
      reason: `Block ${op.block_id} already exists. Use 'edit' instead.`,
    });
    return;
  }
  const blockDef = blockReg.get(op.type);
  if (!blockDef) {
    skipped.push({
      reason_code: "block_type_not_registered",
      operation_type: "add",
      block_id: op.block_id,
      reason: `Block type '${op.type}' is not registered. Available: ${blockReg
        .catalog()
        .map((b) => b.type)
        .join(", ")}.`,
    });
    return;
  }

  const { params, fieldErrors } = filterParams(op.params, blockDef, toolReg);
  for (const fe of fieldErrors)
    errors.push({ block_id: op.block_id, block_type: op.type, ...fe });

  const block: SerializedBlock = {
    id: op.block_id,
    type: op.type,
    name: op.name,
    enabled: true,
    params,
  };
  wf.blocks.push(block);
}

function applyEdit(
  wf: SerializedWorkflow,
  op: Extract<EditOp, { operation_type: "edit" }>,
  blockReg: BlockRegistry,
  toolReg: ToolRegistry,
  skipped: SkippedItem[],
  errors: ValidationError[],
): void {
  const block = wf.blocks.find((b) => b.id === op.block_id);
  if (!block) {
    skipped.push({
      reason_code: "block_not_found",
      operation_type: "edit",
      block_id: op.block_id,
      reason: `Block ${op.block_id} does not exist. Use 'add' to create it first.`,
    });
    return;
  }
  const blockDef = blockReg.get(block.type);
  if (!blockDef) {
    skipped.push({
      reason_code: "block_type_not_registered",
      operation_type: "edit",
      block_id: op.block_id,
      reason: `Block type ${block.type} is not registered.`,
    });
    return;
  }
  if (op.name !== undefined) block.name = op.name;
  if (op.params) {
    const { params, fieldErrors } = filterParams(
      { ...block.params, ...op.params },
      blockDef,
      toolReg,
    );
    for (const fe of fieldErrors)
      errors.push({ block_id: op.block_id, block_type: block.type, ...fe });
    block.params = params;
  }
}

function applyDelete(
  wf: SerializedWorkflow,
  op: Extract<EditOp, { operation_type: "delete" }>,
  skipped: SkippedItem[],
): void {
  const idx = wf.blocks.findIndex((b) => b.id === op.block_id);
  if (idx < 0) {
    skipped.push({
      reason_code: "block_not_found",
      operation_type: "delete",
      block_id: op.block_id,
      reason: `Block ${op.block_id} does not exist.`,
    });
    return;
  }
  wf.blocks.splice(idx, 1);
  wf.connections = wf.connections.filter(
    (c) => c.source !== op.block_id && c.target !== op.block_id,
  );
}

function applyConnect(
  wf: SerializedWorkflow,
  op: Extract<EditOp, { operation_type: "connect" }>,
  skipped: SkippedItem[],
): void {
  if (!wf.blocks.find((b) => b.id === op.block_id)) {
    skipped.push({
      reason_code: "invalid_edge_source",
      operation_type: "connect",
      block_id: op.block_id,
      reason: `Source block ${op.block_id} does not exist.`,
    });
    return;
  }
  if (!wf.blocks.find((b) => b.id === op.target_block_id)) {
    skipped.push({
      reason_code: "invalid_edge_target",
      operation_type: "connect",
      block_id: op.block_id,
      reason: `Target block ${op.target_block_id} does not exist.`,
      details: { target_block_id: op.target_block_id },
    });
    return;
  }
  if (
    wf.connections.find(
      (c) =>
        c.source === op.block_id &&
        c.target === op.target_block_id &&
        (c.sourceHandle ?? null) === (op.source_handle ?? null),
    )
  ) {
    skipped.push({
      reason_code: "duplicate_connection",
      operation_type: "connect",
      block_id: op.block_id,
      reason: "That connection already exists.",
    });
    return;
  }
  const conn: SerializedConnection = { source: op.block_id, target: op.target_block_id };
  if (op.source_handle) conn.sourceHandle = op.source_handle;
  if (op.condition) conn.condition = op.condition;

  const trial: SerializedWorkflow = { ...wf, connections: [...wf.connections, conn] };
  try {
    buildDAG(trial);
  } catch {
    skipped.push({
      reason_code: "cycle_introduced",
      operation_type: "connect",
      block_id: op.block_id,
      reason: `Adding edge ${op.block_id} → ${op.target_block_id} would create a cycle.`,
    });
    return;
  }
  wf.connections.push(conn);
}

function applyDisconnect(
  wf: SerializedWorkflow,
  op: Extract<EditOp, { operation_type: "disconnect" }>,
  skipped: SkippedItem[],
): void {
  const idx = wf.connections.findIndex(
    (c) => c.source === op.block_id && c.target === op.target_block_id,
  );
  if (idx < 0) {
    skipped.push({
      reason_code: "edge_not_found",
      operation_type: "disconnect",
      block_id: op.block_id,
      reason: `No edge from ${op.block_id} to ${op.target_block_id}.`,
    });
    return;
  }
  wf.connections.splice(idx, 1);
}

/* ─────────────  Param filtering: enforces the visibility flag  ───────────── */

function filterParams(
  raw: Record<string, unknown>,
  block: NonNullable<ReturnType<BlockRegistry["get"]>>,
  toolReg: ToolRegistry,
): {
  params: Record<string, unknown>;
  fieldErrors: Array<{ field: string; value: unknown; error: string }>;
} {
  const fieldErrors: Array<{ field: string; value: unknown; error: string }> = [];
  const allowedSubBlockIds = new Set(block.subBlocks.map((s) => s.id));
  const llmAllowedToolParams = new Set<string>();
  for (const tid of block.tools.access) {
    const tool = toolReg.get(tid);
    if (!tool) continue;
    for (const [k, def] of Object.entries(tool.params)) {
      if (def.visibility === "user-or-llm") llmAllowedToolParams.add(k);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (allowedSubBlockIds.has(k) || llmAllowedToolParams.has(k)) {
      out[k] = v;
    } else {
      fieldErrors.push({
        field: k,
        value: v,
        error: `Field '${k}' is not exposed by block '${block.type}'. Allowed: ${[
          ...allowedSubBlockIds,
        ].join(", ")}.`,
      });
    }
  }
  for (const sb of block.subBlocks) {
    if (sb.required && (out[sb.id] === undefined || out[sb.id] === "")) {
      fieldErrors.push({
        field: sb.id,
        value: undefined,
        error: `Required field '${sb.id}' is missing.`,
      });
    }
  }
  return { params: out, fieldErrors };
}

/* ─────────────  Reference validation  ───────────── */

function validateReferences(
  wf: SerializedWorkflow,
  blockReg: BlockRegistry,
  errors: ValidationError[],
): void {
  const blocksById = new Map(wf.blocks.map((b) => [b.id, b]));
  const blocksByName = new Map<string, SerializedBlock>();
  for (const b of wf.blocks) {
    if (b.name) blocksByName.set(b.name, b);
  }

  // Reachability map: for each block, set of upstream block ids.
  const upstream = new Map<string, Set<string>>();
  for (const b of wf.blocks) upstream.set(b.id, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const conn of wf.connections) {
      const ups = upstream.get(conn.target);
      if (!ups) continue;
      const sourceUps = upstream.get(conn.source) ?? new Set();
      const before = ups.size;
      ups.add(conn.source);
      for (const u of sourceUps) ups.add(u);
      if (ups.size !== before) changed = true;
    }
  }

  for (const block of wf.blocks) {
    const refs = VariableResolver.extractRefs(block.params);
    for (const ref of refs) {
      if (
        ref === "trigger" ||
        ref.startsWith("trigger.") ||
        ref.startsWith("env.") ||
        ref.startsWith("vars.")
      ) {
        continue;
      }
      const [head, ...rest] = ref.split(".");
      const target = blocksById.get(head!) ?? blocksByName.get(head!);
      if (!target) {
        errors.push({
          block_id: block.id,
          block_type: block.type,
          field: "*",
          value: `{{${ref}}}`,
          error: `Reference '${head}' does not match any block id or name.`,
        });
        continue;
      }
      const ups = upstream.get(block.id);
      if (!ups || !ups.has(target.id)) {
        errors.push({
          block_id: block.id,
          block_type: block.type,
          field: "*",
          value: `{{${ref}}}`,
          error: `Block '${block.id}' references '${target.id}' but ${target.id} is not upstream — connect them.`,
        });
        continue;
      }
      const blockDef = blockReg.get(target.type);
      if (blockDef && rest.length > 0) {
        const top = rest[0]!;
        if (!Object.prototype.hasOwnProperty.call(blockDef.outputs, top)) {
          errors.push({
            block_id: block.id,
            block_type: block.type,
            field: "*",
            value: `{{${ref}}}`,
            error: `Block '${target.id}' (${target.type}) does not declare output '${top}'. Available: ${Object.keys(
              blockDef.outputs,
            ).join(", ")}.`,
          });
        }
      }
    }
  }
}

function summarize(opCount: number, skipped: SkippedItem[], errors: ValidationError[]): string {
  if (skipped.length === 0 && errors.length === 0)
    return `Applied all ${opCount} operation(s) successfully.`;
  const parts = [`Applied ${opCount} operation(s).`];
  if (skipped.length > 0) {
    parts.push(`${skipped.length} skipped:`);
    for (const s of skipped)
      parts.push(`  • [${s.reason_code}] ${s.operation_type} ${s.block_id}: ${s.reason}`);
  }
  if (errors.length > 0) {
    parts.push(`${errors.length} validation error(s):`);
    for (const e of errors)
      parts.push(
        `  • ${e.block_id} (${e.block_type}): ${e.error}${
          e.value !== undefined ? ` [value: ${JSON.stringify(e.value)}]` : ""
        }`,
      );
  }
  return parts.join("\n");
}
