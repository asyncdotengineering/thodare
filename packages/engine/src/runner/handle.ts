/**
 * A friendlier handle around `WorkflowRunHandle` that:
 *   - exposes the runId so callers can persist it and reattach later;
 *   - provides a non-blocking `describe()` (single backend read);
 *   - provides a `result()` that polls forever by default — NOT openworkflow's
 *     5-minute hardcoded ceiling — with an optional explicit timeout;
 *   - exposes `cancel()`.
 *
 * Pattern lifted from `Chigala/durable-agent` after gh-cli research showed
 * that real users of openworkflow consistently roll their own polling rather
 * than rely on `WorkflowRunHandle.result()`'s short default. This is the
 * "sensible defaults" layer — call `runDurable(compiled, input)` and you
 * get behavior that's correct for multi-day workflows out of the box.
 */

import type { Backend } from "@thodare/openworkflow/internal";

export type DurableRunState =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "canceled";

export interface DurableRunDescription {
  id: string;
  state: DurableRunState;
  output?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  attempts: number;
}

export interface DurableHandleOptions {
  /** Default `result()` poll interval. */
  pollIntervalMs?: number;
  /** Default `result()` timeout. Undefined = poll forever. */
  defaultTimeoutMs?: number;
}

export interface DurableHandle {
  id: string;
  describe(): Promise<DurableRunDescription>;
  result(opts?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<unknown>;
  cancel(): Promise<void>;
}

const DEFAULT_POLL_MS = 1000;

export function createDurableHandle(
  backend: Backend,
  runId: string,
  opts: DurableHandleOptions = {},
): DurableHandle {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  return {
    id: runId,
    describe: () => describeRun(backend, runId),
    result: (o) =>
      pollUntilDone(
        backend,
        runId,
        o?.pollIntervalMs ?? pollMs,
        o?.timeoutMs ?? opts.defaultTimeoutMs,
      ),
    cancel: async () => {
      await backend.cancelWorkflowRun({ workflowRunId: runId });
    },
  };
}

async function describeRun(backend: Backend, runId: string): Promise<DurableRunDescription> {
  const run = await backend.getWorkflowRun({ workflowRunId: runId });
  if (!run) throw new Error(`workflow run not found: ${runId}`);
  const startedAtIso = run.startedAt?.toISOString();
  // openworkflow's WorkflowRun uses `finishedAt`, not `endedAt`.
  const endedAtIso = run.finishedAt?.toISOString();
  return {
    id: run.id,
    state: mapState(run.status),
    ...(run.output != null ? { output: run.output } : {}),
    ...(run.error ? { error: errorToString(run.error) } : {}),
    ...(startedAtIso !== undefined ? { startedAt: startedAtIso } : {}),
    ...(endedAtIso !== undefined ? { endedAt: endedAtIso } : {}),
    attempts: run.attempts ?? 0,
  };
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function pollUntilDone(
  backend: Backend,
  runId: string,
  pollMs: number,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const deadline = timeoutMs == null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (true) {
    const run = await backend.getWorkflowRun({ workflowRunId: runId });
    if (!run) throw new Error(`workflow run no longer exists: ${runId}`);
    const state = mapState(run.status);
    if (state === "completed") return run.output;
    if (state === "failed" || state === "canceled") {
      throw new Error(`run ${runId} ${state}: ${run.error ? errorToString(run.error) : "(no error message)"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `runDurable.result() timed out after ${timeoutMs}ms — run is still ${state}. ` +
          `Either pass a longer timeoutMs, or use describe() for non-blocking status checks.`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function mapState(status: string): DurableRunState {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "sleeping":
      return "sleeping";
    case "completed":
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "running";
  }
}
