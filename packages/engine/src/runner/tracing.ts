/**
 * `withTracing(backend, hooks)` — wraps an openworkflow Backend in a Proxy
 * that fires user-supplied hooks at each significant lifecycle point. The
 * underlying backend is unchanged; uncovered methods pass through with
 * `this`-binding preserved.
 *
 * Backend wrapped in a Proxy that fires user hooks on lifecycle ops,
 * but generalized: hooks are user-supplied (no @opentelemetry dep here).
 *
 * Wire your OTel SDK from inside the hooks:
 *
 *     const tracer = trace.getTracer("wfkit");
 *     const traced = withTracing(backend, {
 *       onWorkflowRunCreate: (params, run) => {
 *         const ctx = propagation.extract(context.active(), params.context ?? {});
 *         // attach run.id span etc.
 *       },
 *     });
 *
 * Hook contract:
 *   - Sync hooks return void; async hooks return Promise<void>; the Proxy
 *     awaits async hooks BEFORE returning the underlying op's result.
 *   - If a hook throws, the error is forwarded to `onError` (if supplied)
 *     and the underlying op result is still returned. Tracing must never
 *     break the workflow.
 */

import type { Backend } from "@thodare/openworkflow/internal";

type WorkflowRun = Awaited<ReturnType<Backend["getWorkflowRun"]>>;
type CreateParams = Parameters<Backend["createWorkflowRun"]>[0];

export interface TracingHooks {
  /** Fires after `createWorkflowRun` resolves with the new run. */
  onWorkflowRunCreate?: (
    params: Readonly<CreateParams>,
    run: NonNullable<WorkflowRun>,
  ) => void | Promise<void>;
  /** Fires after `getWorkflowRun` resolves (run may be null on miss). */
  onWorkflowRunGet?: (run: WorkflowRun) => void | Promise<void>;
  /** Fires after `cancelWorkflowRun` resolves. */
  onWorkflowRunCancel?: (run: NonNullable<WorkflowRun>) => void | Promise<void>;
  /** Receives any error a hook throws. Defaults to `console.warn`. */
  onError?: (err: unknown, hookName: string) => void;
}

const HOOKED_METHODS = new Set([
  "createWorkflowRun",
  "getWorkflowRun",
  "cancelWorkflowRun",
]);

const HOOK_FOR_METHOD: Record<string, keyof TracingHooks> = {
  createWorkflowRun: "onWorkflowRunCreate",
  getWorkflowRun: "onWorkflowRunGet",
  cancelWorkflowRun: "onWorkflowRunCancel",
};

/**
 * Wrap a Backend so user-supplied tracing hooks fire at lifecycle boundaries.
 *
 * but with hooks instead of inline trace context injection — keeps wfkit
 * decoupled from any specific tracing SDK.
 */
export function withTracing(backend: Backend, hooks: TracingHooks): Backend {
  const onError =
    hooks.onError ??
    ((err, name) => {
      // eslint-disable-next-line no-console
      console.warn(`[wfkit:tracing] hook '${name}' threw:`, err);
    });

  return new Proxy(backend, {
    get(target, prop: string | symbol, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !HOOKED_METHODS.has(prop)) {
        // Passthrough — must rebind `this` so internal state access works.
        return (value as Function).bind(target);
      }
      // Hooked method: call underlying op, then fire the hook (best-effort).
      return async (...args: unknown[]) => {
        const result = await (value as Function).apply(target, args);
        const hookName = HOOK_FOR_METHOD[prop]!;
        const hook = hooks[hookName] as
          | ((...a: unknown[]) => void | Promise<void>)
          | undefined;
        if (hook) {
          try {
            // Pass arguments matching each hook's contract.
            if (prop === "createWorkflowRun") {
              await hook(args[0], result);
            } else {
              await hook(result);
            }
          } catch (err) {
            try { onError(err, hookName); } catch { /* swallow */ }
          }
        }
        return result;
      };
    },
  }) as Backend;
}
