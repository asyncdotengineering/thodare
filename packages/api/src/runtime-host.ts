/**
 * Wires the @thodare/engine runtime workflow into the API. The control plane
 * registers ONE openworkflow workflow at boot (`wfkit-runtime`) and
 * dispatches every workflow run through it. Workflow JSON is snapshotted
 * into the run's input.
 */

import type { RuntimeWorkflow, Wfkit } from "@thodare/engine";
import type { CredentialStore } from "./store/credentials.js";

export interface RuntimeHost {
  runtime: RuntimeWorkflow;
  /** Dispatch a workflow JSON + input via the runtime; returns runId. */
  dispatch: (
    workflowJson: unknown,
    input: unknown,
    opts?: { idempotencyKey?: string; organizationId?: string },
  ) => Promise<{ runId: string }>;
}

export function createRuntimeHost(opts: {
  wfkit: Wfkit;
  credentialStore?: CredentialStore;
  masterKey?: Uint8Array;
}): RuntimeHost {
  const resolveCredential =
    opts.credentialStore && opts.masterKey
      ? async (credentialId: string, organizationId: string) => {
          const result = await opts.credentialStore!.getDecrypted(
            organizationId,
            credentialId,
            opts.masterKey!,
          );
          if (!result) return null;
          // Fire-and-forget update last_used_at
          opts.credentialStore!.updateLastUsedAt(organizationId, credentialId).catch(() => {});
          return { id: result.id, type: result.type, secret: result.secret, displayName: result.displayName, ...(result.scopes ? { scopes: result.scopes } : {}) };
        }
      : undefined;

  const runtime = opts.wfkit.runtime(
    resolveCredential ? { resolveCredential } : undefined,
  );
  return {
    runtime,
    async dispatch(workflowJson, input, runOpts) {
      const handle = await runtime.run(
        {
          workflow: workflowJson as never,
          input,
          ...(runOpts?.organizationId ? { organizationId: runOpts.organizationId } : {}),
        },
        runOpts,
      );
      return { runId: handle.id };
    },
  };
}
