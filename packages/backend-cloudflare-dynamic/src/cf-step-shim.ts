/**
 * Wraps a Cloudflare Workflows `step` object to match the shape
 * `@thodare/engine`'s `walkWorkflow` expects. The engine calls:
 *   - step.run({ name }, fn)
 *   - step.sleep(name, "Xs")
 *   - step.waitForSignal({ name, signal, timeout })
 *
 * While running, this shim writes step rows + lifecycle events to D1
 * so `supportsStepIOInspection` is honestly backed.
 *
 * Ref: packages/engine/src/runner/walk.ts:141,168,175
 * Ref: packages/backend-openworkflow-shared/src/step-impl.ts:84-95 (SleepSignal guard)
 */

function isoNow(): string {
  return new Date().toISOString();
}

/** Mirrors the structural shape of CF Workflows' step object. */
export interface CfWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
  waitForEvent(
    name: string,
    eventType: string,
    opts?: { timeout?: string },
  ): Promise<{ type: string; payload?: unknown } | undefined>;
}

export interface CfStepShimCtx {
  runId: string;
  organizationId: string;
  db: D1Database;
}

export interface EngineStep {
  run<T>(opts: { name: string }, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
  waitForSignal<T>(opts: {
    name: string;
    signal: string;
    timeout?: string;
  }): Promise<{ data: T } | null>;
}

export function cfStepToEngineStep(
  cfStep: CfWorkflowStep,
  ctx: CfStepShimCtx,
): EngineStep {
  return {
    async run<T>(opts: { name: string }, fn: () => Promise<T>): Promise<T> {
      const { name } = opts;
      const stepId = crypto.randomUUID();
      const startedAt = isoNow();

      // Emit step_started event
      await insertEvent(ctx.db, {
        type: "step_started",
        runId: ctx.runId,
        stepId,
        organizationId: ctx.organizationId,
        payload: {
          type: "step_started" as const,
          runId: ctx.runId,
          stepId,
          name,
          startedAt,
        },
      });

      // Insert step row pre-execution
      await insertStepRow(ctx.db, {
        id: stepId,
        runId: ctx.runId,
        organizationId: ctx.organizationId,
        name,
        status: "running",
        startedAt,
      });

      try {
        const out = await cfStep.do(name, async () => fn());

        const completedAt = isoNow();
        await insertEvent(ctx.db, {
          type: "step_completed",
          runId: ctx.runId,
          stepId,
          organizationId: ctx.organizationId,
          payload: {
            type: "step_completed" as const,
            runId: ctx.runId,
            stepId,
            name,
            output: out,
            completedAt,
          },
        });

        await updateStepRow(ctx.db, stepId, ctx.organizationId, {
          status: "completed",
          output: out,
          completedAt,
        });

        return out as T;
      } catch (error) {
        // CF Workflows uses control-flow exceptions for sleep/waitForEvent
        // parking. The engine's step.do() does not surface these to user
        // code per CF docs. If an error reaches here, it's a genuine
        // failure — not a sleep-park signal.
        const msg = error instanceof Error ? error.message : String(error);
        const failedAt = isoNow();
        await insertEvent(ctx.db, {
          type: "step_failed",
          runId: ctx.runId,
          stepId,
          organizationId: ctx.organizationId,
          payload: {
            type: "step_failed" as const,
            runId: ctx.runId,
            stepId,
            name,
            error: msg,
            failedAt,
          },
        });

        await updateStepRow(ctx.db, stepId, ctx.organizationId, {
          status: "failed",
          error: msg,
          failedAt,
        });
        throw error;
      }
    },

    async sleep(name: string, duration: string): Promise<void> {
      await cfStep.sleep(name, duration);
    },

    async waitForSignal<T>(opts: {
      name: string;
      signal: string;
      timeout?: string;
    }): Promise<{ data: T } | null> {
      const event = await cfStep.waitForEvent(
        opts.name,
        opts.signal,
        opts.timeout !== undefined ? { timeout: opts.timeout } : undefined,
      );
      if (event === null || event === undefined) return null;
      const payload = (event as { payload?: T }).payload;
      // No-payload signal — engine contract returns { data: null } per
      // walk.ts:180. Unsigned cast on null avoids `as unknown as`.
      return { data: (payload ?? null) as T };
    },
  };
}

// ── D1 helpers (inline — no import from d1-storage to keep shim self-contained) ──

async function insertEvent(
  db: D1Database,
  input: {
    type: string;
    runId: string;
    stepId: string;
    organizationId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = isoNow();
  await db
    .prepare(
      `INSERT INTO events (id, type, run_id, step_id, payload, correlation_id, organization_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      id,
      input.type,
      input.runId,
      input.stepId,
      JSON.stringify(input.payload),
      null,
      input.organizationId,
      createdAt,
    )
    .run();
}

async function insertStepRow(
  db: D1Database,
  row: {
    id: string;
    runId: string;
    organizationId: string;
    name: string;
    status: string;
    startedAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO steps (id, run_id, organization_id, name, input, output, error, status, started_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      row.id,
      row.runId,
      row.organizationId,
      row.name,
      null,
      null,
      null,
      row.status,
      row.startedAt,
    )
    .run();
}

async function updateStepRow(
  db: D1Database,
  stepId: string,
  organizationId: string,
  update: {
    status: string;
    output?: unknown;
    error?: string;
    completedAt?: string;
    failedAt?: string;
  },
): Promise<void> {
  const sets: string[] = ["status = ?1"];
  const params: unknown[] = [update.status];
  let idx = 2;
  if (update.output !== undefined) {
    sets.push(`output = ?${idx}`);
    params.push(JSON.stringify(update.output));
    idx++;
  }
  if (update.error !== undefined) {
    sets.push(`error = ?${idx}`);
    params.push(update.error);
    idx++;
  }
  if (update.completedAt !== undefined) {
    sets.push(`completed_at = ?${idx}`);
    params.push(update.completedAt);
    idx++;
  }
  if (update.failedAt !== undefined) {
    sets.push(`failed_at = ?${idx}`);
    params.push(update.failedAt);
    idx++;
  }
  params.push(organizationId, stepId);
  await db
    .prepare(
      `UPDATE steps SET ${sets.join(", ")} WHERE organization_id = ?${idx} AND id = ?${idx + 1}`,
    )
    .bind(...params)
    .run();
}
