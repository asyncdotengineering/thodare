/**
 * Types for @thodare/engine: wfkit's connector-shaped DSL + LLM-facing surface,
 * extended with a uniform pause/resume sentinel so the same workflow JSON runs
 * on both the in-memory dev executor and the openworkflow durable runtime.
 *
 * Inheritance map (vs. wfkit @ workflow-engine-research/wfkit/src/types.ts):
 *   - ParamVisibility, ToolParamDef, Tool, Block, SubBlock, SerializedWorkflow,
 *     EditOp, SkipReason, SkippedItem, ValidationError, ApplyOpsResult — same
 *     shape as wfkit (this is the DSL we agreed to keep).
 *   - PauseInfo, BlockKind — added here to formalize wfkit conv-08's `__paused`
 *     sentinel and let the durable executor recognize "this is a wait, not
 *     compute" before invoking step.run.
 */

import { z } from "zod";
import type { ResolvedCredential, ToolCredentialBinding } from "./credentials/types.js";

/* ───────────────────────  Visibility & primitives  ─────────────────────── */

export const ParamVisibility = z.enum(["user-or-llm", "user-only", "hidden"]);
export type ParamVisibility = z.infer<typeof ParamVisibility>;

export const ParamType = z.enum(["string", "number", "boolean", "object", "array"]);
export type ParamType = z.infer<typeof ParamType>;

/* ─────────────────────────────  Tool layer  ────────────────────────────── */

export interface ToolParamDef {
  type: ParamType;
  required?: boolean;
  visibility: ParamVisibility;
  description?: string;
}

export interface ToolOutputDef {
  type: ParamType;
  description?: string;
}

export interface ToolContext {
  env: Record<string, string>;
  /** Stable run identifier; the durable runtime threads this into ctx so wait
   * tools can construct resume URLs / signal names that survive replays. */
  executionId: string;
  /** Logical block id this tool was invoked from; useful for log scoping and
   * for waits to derive a stable durable-step name. */
  blockId: string;
  log: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
  /** Resolved credential, present only when the connector declares credential.required: true
   * and a credentialId was in the block params at dispatch time. */
  credential?: ResolvedCredential;
}

export interface Tool<TParams = any, TOut = any> {
  id: string;
  name: string;
  description: string;
  params: Record<string, ToolParamDef>;
  outputs: Record<string, ToolOutputDef>;
  credential?: ToolCredentialBinding;
  execute: (params: TParams, ctx: ToolContext) => Promise<TOut>;
}

/* ──────────────────────────────  Block layer  ──────────────────────────── */

export interface SubBlock {
  id: string;
  title: string;
  type: "short-input" | "long-input" | "dropdown" | "json" | "oauth-input";
  required?: boolean;
  options?: Array<{ id: string; label: string }>;
  condition?: { field: string; value: string | string[]; not?: boolean };
  description?: string;
}

/**
 * "compute" — runs once via step.run.
 * "wait"    — declarative wait. The durable executor maps it to step.sleep
 *             or step.waitForSignal directly; the in-memory executor returns
 *             a pause snapshot. Either way the block's tool's execute()
 *             returns a `PauseInfo` describing the wait shape.
 * "trigger" — entrypoint; output is the trigger payload, never invokes a tool.
 */
export type BlockKind = "compute" | "wait" | "trigger";

export interface Block {
  type: string;
  name: string;
  description: string;
  category: "trigger" | "action" | "logic" | "tools" | "wait";
  kind: BlockKind;
  subBlocks: SubBlock[];
  outputs: Record<string, ToolOutputDef>;
  tools: {
    access: string[];
    config: {
      tool: (params: any) => string;
      params?: (params: any) => any;
    };
  };
}

/* ─────────────────────────  Workflow JSON schema  ──────────────────────── */

export const PositionSchema = z.object({ x: z.number(), y: z.number() }).optional();

export const SerializedBlockSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  position: PositionSchema,
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.any()).default({}),
});

export const SerializedConnectionSchema = z.object({
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  condition: z.string().optional(),
});

export const SerializedWorkflowSchema = z.object({
  version: z.string().default("1.0.0"),
  metadata: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  blocks: z.array(SerializedBlockSchema),
  connections: z.array(SerializedConnectionSchema),
  variables: z.record(z.string(), z.any()).optional(),
});

export type SerializedBlock = z.infer<typeof SerializedBlockSchema>;
export type SerializedConnection = z.infer<typeof SerializedConnectionSchema>;
export type SerializedWorkflow = z.infer<typeof SerializedWorkflowSchema>;

/* ────────────────────────  Pause / resume sentinel  ──────────────────────
 * Per wfkit conversation 08: every wait shape returns the same shape from
 * its tool. The executor (in-memory or durable) inspects it and translates
 * to the right primitive.
 *
 * `reason`:
 *   - "wait_duration"  — relative pause (resumeAt = now + duration)
 *   - "wait_until"     — absolute timestamp pause
 *   - "wait_for_event" — event-driven pause (resumeOnEvent + correlationKey)
 *   - "human_approval" — token-driven pause; resumeUrl is built from token
 *
 * `resumeToken` is the single-use idempotency key. `resumeAt` and
 * `resumeOnEvent` are mutually exclusive in practice, but both are allowed
 * (an event with a timeout = race between the two).
 * ────────────────────────────────────────────────────────────────────────── */

export type PauseReason =
  | "wait_duration"
  | "wait_until"
  | "wait_for_event"
  | "human_approval";

export interface PauseInfo {
  __paused: true;
  reason: PauseReason;
  /** Wall-clock ISO timestamp the run should wake at (time-based pauses). */
  resumeAt?: string;
  /** Event name the run should wake on (event-based pauses). */
  resumeOnEvent?: string;
  /** Optional event-payload field used to correlate signals to specific runs. */
  correlationKey?: string;
  /** Single-use UUID used by the resume URL / signal payload. */
  resumeToken: string;
  /** Free-form metadata: approval prompts, downstream URL, etc. */
  metadata?: Record<string, unknown>;
}

/* ─────────────────────────────  Execution  ─────────────────────────────── */

export interface ExecutionLog {
  blockId: string;
  blockType: string;
  blockName?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  success: boolean;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface ExecutionSnapshot {
  workflowVersion: string;
  workflow: SerializedWorkflow;
  blockOutputs: Record<string, unknown>;
  completedBlockIds: string[];
  pausedAtBlockId: string;
  pause: PauseInfo;
  triggerData: unknown;
  /** Frozen at run-start (wfkit conv 08, "Workflow versioning during long waits"). */
  pinnedAt: string;
}

export interface ExecutionResult {
  success: boolean;
  paused?: boolean;
  /** Set when paused === true. The caller persists this for resume. */
  snapshot?: ExecutionSnapshot;
  outputs: Record<string, unknown>;
  logs: ExecutionLog[];
  error?: string;
}

/* ────────────────────────  Edit operations (AI-facing)  ────────────────── */

export const EditOpSchema = z.discriminatedUnion("operation_type", [
  z.object({
    operation_type: z.literal("add"),
    block_id: z.string(),
    type: z.string(),
    name: z.string().optional(),
    params: z.record(z.string(), z.any()).default({}),
  }),
  z.object({
    operation_type: z.literal("edit"),
    block_id: z.string(),
    name: z.string().optional(),
    params: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    operation_type: z.literal("delete"),
    block_id: z.string(),
  }),
  z.object({
    operation_type: z.literal("connect"),
    block_id: z.string(),
    target_block_id: z.string(),
    source_handle: z.string().optional(),
    condition: z.string().optional(),
  }),
  z.object({
    operation_type: z.literal("disconnect"),
    block_id: z.string(),
    target_block_id: z.string(),
  }),
]);

export type EditOp = z.infer<typeof EditOpSchema>;

export type SkipReason =
  | "block_not_found"
  | "block_already_exists"
  | "block_type_not_registered"
  | "tool_not_allowed"
  | "invalid_edge_target"
  | "invalid_edge_source"
  | "duplicate_connection"
  | "edge_not_found"
  | "cycle_introduced";

export interface SkippedItem {
  reason_code: SkipReason;
  operation_type: EditOp["operation_type"];
  block_id: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface ValidationError {
  block_id: string;
  block_type: string;
  field?: string;
  value?: unknown;
  error: string;
}

export interface ApplyOpsResult {
  ok: boolean;
  workflow: SerializedWorkflow;
  validation_errors: ValidationError[];
  skipped_items: SkippedItem[];
  summary: string;
}
