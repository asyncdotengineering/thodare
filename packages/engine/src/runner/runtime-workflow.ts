/**
 * `buildRuntimeWorkflow` — ONE generic openworkflow workflow that takes a
 * SerializedWorkflow as input and walks it. The @thodare/api uses
 * this so it can register new workflows AFTER `worker.start()` without
 * needing a worker restart per workflow create.
 *
 * The workflow JSON is snapshotted into the run's input. Edits made
 * AFTER `runtime.run()` don't affect in-flight runs (Sim's pin-at-run-start
 * pattern). The next run picks up the new version.
 *
 * Step keys are derived from `block.id`, same as `buildDurableWorkflow`.
 * Replays of a single run reach the same step keys because the workflow
 * JSON is fixed in the run's input.
 */

import type { OpenWorkflow } from "@thodare/openworkflow";
import type { Backend } from "@thodare/openworkflow/internal";
import type { BlockRegistry } from "../blocks/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SerializedWorkflow } from "../types.js";
import { walkWorkflow } from "./walk.js";
import { createDurableHandle, type DurableHandle } from "./handle.js";

export interface BuildRuntimeWorkflowOptions {
  ow: OpenWorkflow;
  backend: Backend;
  blockRegistry: BlockRegistry;
  toolRegistry: ToolRegistry;
  env?: Record<string, string>;
  /** Override the workflow name. Default: "wfkit-runtime". */
  name?: string;
}

export interface RuntimeWorkflow {
  /** Run the runtime against a workflow JSON + input. Returns DurableHandle. */
  run: (
    args: { workflow: SerializedWorkflow; input?: unknown },
    options?: { idempotencyKey?: string; defaultTimeoutMs?: number; pollIntervalMs?: number },
  ) => Promise<DurableHandle>;
  /** Reattach to an existing run by id. */
  getHandle: (
    runId: string,
    options?: { defaultTimeoutMs?: number; pollIntervalMs?: number },
  ) => DurableHandle;
  /** Underlying openworkflow workflow (for advanced use; rarely needed). */
  readonly raw: ReturnType<OpenWorkflow["defineWorkflow"]>;
}

const DEFAULT_RUNTIME_NAME = "wfkit-runtime";

export function buildRuntimeWorkflow(opts: BuildRuntimeWorkflowOptions): RuntimeWorkflow {
  const env = opts.env ?? {};
  const compiled = opts.ow.defineWorkflow(
    { name: opts.name ?? DEFAULT_RUNTIME_NAME },
    async ({ input, step }) => {
      const { workflow, input: trigger } = (input as {
        workflow: SerializedWorkflow;
        input?: unknown;
      });
      if (!workflow) {
        throw new Error("wfkit-runtime: input.workflow is required");
      }
      return walkWorkflow({
        workflow,
        trigger: trigger ?? {},
        step,
        blockRegistry: opts.blockRegistry,
        toolRegistry: opts.toolRegistry,
        env,
      });
    },
  );

  return {
    raw: compiled,
    async run(args, runOpts) {
      const handle = await compiled.run(args as never, runOpts?.idempotencyKey !== undefined ? { idempotencyKey: runOpts.idempotencyKey } : undefined);
      return createDurableHandle(opts.backend, handle.workflowRun.id, {
        ...(runOpts?.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: runOpts.defaultTimeoutMs } : {}),
        ...(runOpts?.pollIntervalMs !== undefined ? { pollIntervalMs: runOpts.pollIntervalMs } : {}),
      });
    },
    getHandle(runId, runOpts) {
      return createDurableHandle(opts.backend, runId, {
        ...(runOpts?.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: runOpts.defaultTimeoutMs } : {}),
        ...(runOpts?.pollIntervalMs !== undefined ? { pollIntervalMs: runOpts.pollIntervalMs } : {}),
      });
    },
  };
}
