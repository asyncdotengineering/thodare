import {
  DynamicWorkflowBinding,
  createDynamicWorkflowEntrypoint,
  type LoadWorkflowRunner,
  type LoadWorkflowRunnerContext,
} from "@cloudflare/dynamic-workflows";

import type { CFEnv, CloudflareDispatcherOptions } from "./types.js";
import { isThodareMetadata } from "./types.js";

export { DynamicWorkflowBinding };

export interface CloudflareDispatcherFactory<Env extends CFEnv = CFEnv> {
  DynamicWorkflowBinding: typeof DynamicWorkflowBinding;
  ThodareWorkflow: ReturnType<typeof createDynamicWorkflowEntrypoint<Env>>;
}

/**
 * Create a Cloudflare dispatcher surface for a Thodare deployment.
 *
 * The returned factory provides two pieces:
 * 1. `DynamicWorkflowBinding` — must be re-exported from the dispatcher's
 *    main module so `wrapWorkflowBinding` can find it on `cloudflare:workers`.
 * 2. `ThodareWorkflow` — register as `class_name` in `[[workflows]]` in
 *    `wrangler.jsonc`. This is the single WorkflowEntrypoint that dispatches
 *    every Thodare workflow run.
 *
 * The runtime walker bundle is NOT in scope for Phase 4. The loader callback
 * throws `not_implemented` with a clear message after fetching the workflow
 * JSON from D1. A Phase 4.x follow-up will ship the `THODARE_RUNTIME_BUNDLE`
 * and wire it here.
 */
export function createCloudflareDispatcher<Env extends CFEnv = CFEnv>(
  opts: CloudflareDispatcherOptions = {},
): CloudflareDispatcherFactory<Env> {
  const d1BindingName = opts.d1BindingName ?? "THODARE_DB";

  const loadRunner: LoadWorkflowRunner<Env> = async (
    ctx: LoadWorkflowRunnerContext<Env>,
  ) => {
    const { metadata, env } = ctx;

    if (!isThodareMetadata(metadata)) {
      throw new Error(
        `backend-cloudflare-dynamic: invalid dispatcher metadata — ` +
          `expected { workflowId, organizationId, workflowVersion }, got ${JSON.stringify(metadata)}`,
      );
    }

    const d1 = (env as unknown as Record<string, unknown>)[d1BindingName] as D1Database | undefined;
    if (!d1) {
      throw new Error(
        `backend-cloudflare-dynamic: D1 binding "${d1BindingName}" not found on env`,
      );
    }

    const row = await d1
      .prepare(
        `SELECT definition FROM workflows
         WHERE organization_id = ?1 AND id = ?2 AND version = ?3
         LIMIT 1`,
      )
      .bind(
        metadata.organizationId,
        metadata.workflowId,
        Number(metadata.workflowVersion),
      )
      .first<{ definition: string }>();

    if (!row) {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${metadata.workflowId}" ` +
          `(org ${metadata.organizationId}, v${metadata.workflowVersion}) not found in D1`,
      );
    }

    throw new Error(
      "backend-cloudflare-dynamic: runtime walker bundle is not yet available. " +
        "This is a Phase 4.x follow-up (queued). The workflow JSON was fetched " +
        `successfully from D1 (${metadata.workflowId}@${metadata.workflowVersion}).`,
    );
  };

  const ThodareWorkflow = createDynamicWorkflowEntrypoint<Env>(loadRunner);

  return {
    DynamicWorkflowBinding,
    ThodareWorkflow,
  };
}
