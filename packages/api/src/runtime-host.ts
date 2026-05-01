/**
 * Wires the @thodare/engine runtime workflow into the API. The control plane
 * registers ONE openworkflow workflow at boot (`wfkit-runtime`) and
 * dispatches every workflow run through it. Workflow JSON is snapshotted
 * into the run's input.
 */

import type { RuntimeWorkflow, Wfkit } from "@thodare/engine";

export interface RuntimeHost {
  runtime: RuntimeWorkflow;
  /** Dispatch a workflow JSON + input via the runtime; returns runId. */
  dispatch: (
    workflowJson: unknown,
    input: unknown,
    opts?: { idempotencyKey?: string },
  ) => Promise<{ runId: string }>;
}

export function createRuntimeHost(opts: { wfkit: Wfkit }): RuntimeHost {
  const runtime = opts.wfkit.runtime();
  return {
    runtime,
    async dispatch(workflowJson, input, runOpts) {
      const handle = await runtime.run(
        { workflow: workflowJson as never, input },
        runOpts,
      );
      return { runId: handle.id };
    },
  };
}
