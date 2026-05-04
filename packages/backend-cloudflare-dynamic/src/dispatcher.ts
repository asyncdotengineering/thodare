import {
  DynamicWorkflowBinding,
  createDynamicWorkflowEntrypoint,
  type LoadWorkflowRunner,
  type LoadWorkflowRunnerContext,
} from "@cloudflare/dynamic-workflows";

import type { CFEnv, CloudflareDispatcherOptions } from "./types.js";
import { isThodareMetadata } from "./types.js";
import { cfStepToEngineStep, type CfWorkflowStep } from "./cf-step-shim.js";
import type { SerializedWorkflow } from "@thodare/engine/walk";
import { walkWorkflow } from "@thodare/engine/walk";

export { DynamicWorkflowBinding };

export interface CloudflareDispatcherFactory<Env extends CFEnv = CFEnv> {
  DynamicWorkflowBinding: typeof DynamicWorkflowBinding;
  ThodareWorkflow: ReturnType<typeof createDynamicWorkflowEntrypoint<Env>>;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Build the dispatcher's `loadRunner` callback. Exported as `_buildLoadRunner`
 * so tests can exercise the same closure that ships in production
 * (avoids the inline-replication test pattern that hides dispatcher-
 * integration bugs). The underscore prefix marks it as test-internal —
 * not a stable public API.
 */
export function _buildLoadRunner<Env extends CFEnv = CFEnv>(
  opts: CloudflareDispatcherOptions,
): LoadWorkflowRunner<Env> {
  const d1BindingName = opts.d1BindingName ?? "THODARE_DB";
  const blockRegistry = opts.blockRegistry;
  const toolRegistry = opts.toolRegistry;
  const envVars = opts.envVars ?? {};

  return async (ctx: LoadWorkflowRunnerContext<Env>) => {
    const { metadata, env } = ctx;

    if (!isThodareMetadata(metadata)) {
      throw new Error(
        `backend-cloudflare-dynamic: invalid dispatcher metadata — ` +
          `expected { workflowId, organizationId, workflowVersion }, got ${JSON.stringify(metadata)}`,
      );
    }

    const envRecord = env as unknown as Record<string, unknown>;
    const d1 = envRecord[d1BindingName] as D1Database | undefined;
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

    if (row.definition === null) {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${metadata.workflowId}"@${metadata.workflowVersion} ` +
          `has no SerializedWorkflow attached. Call setWorkflowDefinition() before runWorkflow.`,
      );
    }

    let workflowJson: unknown;
    try {
      workflowJson = JSON.parse(row.definition) as unknown;
    } catch {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${metadata.workflowId}" definition is not valid JSON`,
      );
    }

    if (
      typeof workflowJson !== "object" ||
      workflowJson === null ||
      !("blocks" in workflowJson) ||
      !Array.isArray((workflowJson as Record<string, unknown>)["blocks"]) ||
      !("connections" in workflowJson) ||
      !Array.isArray((workflowJson as Record<string, unknown>)["connections"])
    ) {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${metadata.workflowId}" definition is not a SerializedWorkflow`,
      );
    }

    // runId is validated by isThodareMetadata above — it is a required
    // field. No fallback: a missing runId is data corruption that must
    // surface rather than silently diverge from the adapter's event store.
    const runId = metadata.runId;

    return {
      async run(event: { payload?: unknown }, cfStep: object) {
        const engineStep = cfStepToEngineStep(cfStep as CfWorkflowStep, {
          runId,
          organizationId: metadata.organizationId,
          db: d1,
        }) as unknown as Record<string, unknown>;

        let result: { outputs: Record<string, unknown> };
        try {
          result = await walkWorkflow({
            workflow: workflowJson as SerializedWorkflow,
            trigger: event.payload ?? {},
            step: engineStep,
            blockRegistry,
            toolRegistry,
            env: envVars,
            organizationId: metadata.organizationId,
          });
        } catch (error) {
          const failedAt = isoNow();
          const message = error instanceof Error ? error.message : String(error);
          try {
            await d1
              .prepare(
                `INSERT INTO events (id, type, run_id, step_id, payload, correlation_id, organization_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
              )
              .bind(
                crypto.randomUUID(),
                "run_failed",
                runId,
                null,
                JSON.stringify({
                  type: "run_failed",
                  runId,
                  error: message,
                  failedAt,
                }),
                null,
                metadata.organizationId,
                failedAt,
              )
              .run();

            await d1
              .prepare(
                `UPDATE runs SET status = ?1, error = ?2, failed_at = ?3
                 WHERE organization_id = ?4 AND id = ?5`,
              )
              .bind("failed", message, failedAt, metadata.organizationId, runId)
              .run();
          } catch {
            // Best-effort — the original walker error takes precedence.
          }
          throw error;
        }

        const completedAt = isoNow();
        try {
          await d1
            .prepare(
              `INSERT INTO events (id, type, run_id, step_id, payload, correlation_id, organization_id, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
            )
            .bind(
              crypto.randomUUID(),
              "run_completed",
              runId,
              null,
              JSON.stringify({
                type: "run_completed",
                runId,
                output: result.outputs,
                completedAt,
              }),
              null,
              metadata.organizationId,
              completedAt,
            )
            .run();

          await d1
            .prepare(
              `UPDATE runs SET status = ?1, output = ?2, completed_at = ?3
               WHERE organization_id = ?4 AND id = ?5`,
            )
            .bind(
              "completed",
              JSON.stringify(result.outputs),
              completedAt,
              metadata.organizationId,
              runId,
            )
            .run();
        } catch {
          // Best-effort — the run completed but persistence of the terminal
          // event failed. Step rows + events are already in D1.
        }

        return result.outputs;
      },
    };
  };
}

export function createCloudflareDispatcher<Env extends CFEnv = CFEnv>(
  opts: CloudflareDispatcherOptions,
): CloudflareDispatcherFactory<Env> {
  const ThodareWorkflow = createDynamicWorkflowEntrypoint<Env>(
    _buildLoadRunner<Env>(opts),
  );

  return {
    DynamicWorkflowBinding,
    ThodareWorkflow,
  };
}
