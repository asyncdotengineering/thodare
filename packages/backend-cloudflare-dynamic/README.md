# @thodare/backend-cloudflare-dynamic

Cloudflare Workflows GA ThodareBackend adapter using
[`@cloudflare/dynamic-workflows`](https://github.com/cloudflare/dynamic-workflows)
(v0.1.1). Third concrete adapter in the v1 backend abstraction; first that
does not extend openworkflow.

**Version:** `1.0.0-alpha.1` — `pnpm install @thodare/backend-cloudflare-dynamic@alpha`.

## Status (v1 alpha)

- ✅ **Storage layer** — events, runs, steps, hooks tables on D1; idempotent DDL;
  per-org tenant scoping enforced at the SQL layer.
- ✅ **Workflow definitions persisted** — `defineWorkflow` writes to D1.
- ✅ **Idempotent run creation** — `runWorkflow` honors `opts.idempotencyKey`.
- ✅ **Signal / cancel** — delegated to CF Workflows `instance.sendEvent` / `terminate`.
- ✅ **Honest capability flags** — every flag matches what the code actually delivers.
- ⚠️ **Workflow execution stubbed** — the runtime walker bundle that interprets
  workflow JSON inside CF Workflows `run(event, step)` is queued for Phase 4.x.
  Calling `runWorkflow` will create a CF Workflow instance, but on first
  `step.do` the dispatcher's loader throws `not_implemented` and the run fails.
  The persistence path works; the execution path does not.
- ⚠️ **Streams** (`streams.*`) and `resumeFromStep` / `recover` throw
  `not_implemented` — `BackendCapabilities` declares them `false`.

## Architecture

CF Workflows is the engine. The adapter is thin glue that:

1. Persists Thodare's events / runs / steps / hooks in **D1** (CF's SQLite-shaped DB).
2. Provides a **dispatcher factory** (`createCloudflareDispatcher`) the user
   composes into their own Cloudflare Worker.
3. Implements `ThodareBackend` so frontends + contract tests can talk through
   the same surface as PG / SQLite.

## Required bindings

The dispatcher Worker must declare these bindings in `wrangler.jsonc`:

```jsonc
{
  "main": "src/index.ts",
  "compatibility_date": "2026-04-30",
  "compatibility_flags": ["experimental"],
  "d1_databases": [
    { "binding": "THODARE_DB", "database_name": "...", "database_id": "..." }
  ],
  "workflows": [
    { "name": "thodare", "binding": "WORKFLOWS", "class_name": "ThodareWorkflow" }
  ]
}
```

## Quick start (storage + dispatcher wiring; execution is Phase 4.x)

```ts
// src/index.ts — your dispatcher Worker
import {
  createBackendCloudflareDynamic,
  createCloudflareDispatcher,
  DynamicWorkflowBinding,
} from "@thodare/backend-cloudflare-dynamic";

// Re-export required by @cloudflare/dynamic-workflows.
export { DynamicWorkflowBinding };

// Register as `class_name` in wrangler.jsonc [[workflows]].
export const { ThodareWorkflow } = createCloudflareDispatcher();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const backend = await createBackendCloudflareDynamic({
      env,
      organizationId: "org-123",
    });

    // ✅ Persists workflow definition to D1.
    await backend.defineWorkflow({ name: "hello" }, async () => {});

    // ⚠️ Creates a CF Workflow instance and writes a run row. On first
    // step.do the runtime walker stub throws not_implemented (Phase 4.x).
    const { runId } = await backend.runWorkflow("hello", { x: 1 });

    return Response.json({ runId });
  },
};
```

## Capabilities

| Flag | Value | Notes |
|---|---|---|
| `maxStepDurationMs` | 31,536,000,000 (365 days) | CF max sleep per step |
| `maxRunDurationMs` | 31,536,000,000 (365 days) | Same upstream cap |
| `signalPrecision` | `"exact"` | CF `step.waitForEvent` durable delivery |
| `exactlyOnceSteps` | `true` | CF dedupes completed steps; step *functions* must remain idempotent for retries before completion |
| `serverless` | `true` | |
| `pricingModel` | `"per-invocation"` | |
| `maxStepOutputBytes` | 1,048,576 (1 MiB) | CF docs |
| `maxPersistedStateBytes` | 1,073,741,824 (1 GiB) | CF docs (paid tier) |
| `supportsLiveSubscription` | `false` | DO + WS queued for Phase 4.x |
| `supportsStepIOInspection` | `false` | No code path writes step rows in alpha |
| `supportsResumeFromStep` | `false` | CF Workflows requires re-create |
| `supportsRecover` | `false` | |
| `liveSubscriptionLatencyMs` | 0 | n/a — see `supportsLiveSubscription` |
| `supportsRemovedTombstone` | `false` | |
| `supportsContainerBlocks` | `false` | |
| `supportsDynamicSchemas` | `false` | |
| `supportsAwaitFirstBlockResult` | `false` | |

## Three CF-specific risks (per proposal §4.3)

1. **Account-level Workflows quota = noisy neighbor.** All Thodare orgs in
   one CF account share the Workflows concurrency quota. Mitigations:
   per-org CF account / sub-deployment for paying customers; document the
   limit; per-org rate-limit at the Thodare API layer.

2. **Plaintext metadata envelope.** The `@cloudflare/dynamic-workflows`
   envelope is unsigned and persisted in `event.payload`. Tenant code can
   read it back via `instance.status()`. The adapter puts only
   `{ workflowId, organizationId, workflowVersion }` in metadata — never
   any `hidden()` param, never any credential.

3. **Loader runs on every step resume.** Cloudflare's `dispatchWorkflow`
   does not internally cache — rely on Worker Loader's isolate cache.
   Loader callbacks must be cheap; the adapter's loader makes one D1 read
   per resume.

## Fallback

This is the initial alpha. There is no prior version of this package to
downgrade to. If the CF adapter does not fit your deployment, the
`@thodare/backend-openworkflow-pg` (Postgres) and
`@thodare/backend-openworkflow-sqlite` (in-process SQLite) adapters
implement the same `ThodareBackend` interface and ship today. Switching
adapters is a one-line change in your Worker entry point.

## License

MIT. Depends on `@cloudflare/dynamic-workflows` (MIT, © Dan Lapid 2026)
and `@thodare/backend` (MIT).
