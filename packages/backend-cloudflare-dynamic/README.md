# @thodare/backend-cloudflare-dynamic

Cloudflare Workflows GA ThodareBackend adapter using
[`@cloudflare/dynamic-workflows`](https://github.com/cloudflare/dynamic-workflows)
(v0.1.1). Third concrete adapter in the v1 backend abstraction; first that
does not extend openworkflow.

**Version:** `1.0.0-alpha.1` — `pnpm install @thodare/backend-cloudflare-dynamic@alpha`.

## Status (v1 alpha)

- ✅ **Storage layer** — events, runs, steps, hooks tables on D1; idempotent DDL;
  per-org tenant scoping enforced at the SQL layer.
- ✅ **Workflow definitions persisted** — `defineWorkflow` registers name+version; `setWorkflowDefinition` attaches the SerializedWorkflow JSON. The CF adapter has a separate registration+definition step because the dispatcher runs in a serverless isolate and the JSON must be persisted in D1 before dispatch.
- ✅ **Signal / cancel** — delegated to CF Workflows `instance.sendEvent` / `terminate`.
- ✅ **Runtime walker** — `walkWorkflow` from `@thodare/engine` executes workflow JSON
  inside CF Workflows. Step rows + lifecycle events written to D1 with `organization_id`.
- ✅ **Live subscription** — `LogSession` Durable Object with WebSocket fan-out +
  DO storage persistence. `BackendCapabilities.supportsLiveSubscription: true`.
- ✅ **Step IO inspection** — `steps` table populated by cf-step-shim during walk.
  `BackendCapabilities.supportsStepIOInspection: true`.
- ✅ **Honest capability flags** — every flag matches what the code actually delivers.
- ✅ **Streams WebSocket fan-out** — RPC `push`/`getChunks` and a live
  WebSocket subscriber (`fetch` upgrade) both tested in the workerd pool.
- ⚠️ **DO is not org-scoped at the storage layer** — `LogSession` keys by
  `runId` only and relies on the runId UUID being unguessable to prevent
  cross-org reads. Other tables enforce T11 with explicit `organization_id`
  filters; the DO is intentionally thinner. Sound for alpha; flagged for
  Phase 5+ if a stricter security model is required.
- ⚠️ **CF control-flow exception assumption is unverified against real CF
  Workflows.** The `cf-step-shim` `try/catch` assumes CF's `step.do()` does
  not surface engine-internal sleep/wait parking exceptions to the user
  callback (per CF docs). Mock-tested only — flag if real-engine behavior
  differs.
- ⚠️ **WebSocket pattern is non-hibernation.** Uses `WebSocketPair` +
  `ws.accept()`. Works correctly but limits scale vs the Workers
  hibernation API. Acceptable for alpha.
## Registration → setDefinition sequence

The CF adapter has a **two-step registration sequence** that differs from other Thodare backends:

1. **`defineWorkflow(spec, handler)`** — registers the workflow name+version in D1 with `definition: null`. The handler is accepted but not used (CF dispatch runs in a serverless isolate; the handler cannot be held in-process).

2. **`setWorkflowDefinition(name, version, serializedWorkflow)`** — attaches the SerializedWorkflow JSON (`{ version, blocks, connections, ... }`) to the registered workflow. This is a CF-specific extension on `BackendCloudflareDynamic`. Required before `runWorkflow` — the dispatcher's `loadRunner` reads this column to feed the runtime walker.

3. **`runWorkflow(name, input, opts?)`** — dispatches a run. Fails with a clear error if `setWorkflowDefinition` hasn't been called for this workflow version.

```ts
const backend = await createBackendCloudflareDynamic({ env, organizationId });

// Step 1: register
await backend.defineWorkflow({ name: "my-wf" }, async () => {});

// Step 2: attach the workflow JSON (CF-specific)
await backend.setWorkflowDefinition("my-wf", 1, {
  version: "1.0.0",
  blocks: [{ id: "b1", type: "echo", name: "Echo", enabled: true, params: {} }],
  connections: [],
});

// Step 3: dispatch
const { runId } = await backend.runWorkflow("my-wf", { input: 42 });
```

Other adapters (PG, SQLite) don't need this — they register the handler in-process and the runtime walker holds it directly. The CF adapter's dispatcher runs in a serverless isolate, so the workflow JSON must be persisted in D1 before `runWorkflow` dispatches.

- ⚠️ **`resumeFromStep` / `recover`** throw `not_implemented` —
  `BackendCapabilities` declares them `false`.

## Architecture

CF Workflows is the engine. The adapter is thin glue that:

1. Persists Thodare's events / runs / steps / hooks in **D1** (CF's SQLite-shaped DB).
2. Provides a **dispatcher factory** (`createCloudflareDispatcher`) the user
   composes into their own Cloudflare Worker.
3. Provides a **`LogSession` Durable Object** for live run streaming via WebSocket.
4. Implements `ThodareBackend` so frontends + contract tests can talk through
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
  ],
  "durable_objects": {
    "bindings": [
      { "name": "LOG_SESSION", "class_name": "LogSession" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["LogSession"] }
  ]
}
```

## LogSession Durable Object

The `LogSession` DO provides per-run, multi-channel live streaming. Key properties:

- **Keyed by `runId`.** One DO instance handles all channels for a single workflow run.
- **WebSocket fan-out.** Subscribers connect via `GET /?channel=logs` with
  `Upgrade: websocket`. Reconnecting clients receive buffered history from DO storage.
- **RPC methods.** `push(channel, chunk)`, `getChunks(channel, since?)`,
  `getInfo(channel, runId)`, `closeChannel(channel)`, `list(runId)`.
- **DO storage persistence.** Chunks survive DO eviction; reconnecting subscribers
  see the full history.

The adapter's `streams.*` methods delegate to `LogSession` via
`env.LOG_SESSION.idFromName(runId).get(LogSession).push(channel, chunk)`.

Export `LogSession` from your Worker's main module so the DO is registered:

```ts
export { LogSession } from "@thodare/backend-cloudflare-dynamic";
```

## Quick start (full stack)

```ts
// src/index.ts — your dispatcher Worker
import { BlockRegistry, ToolRegistry } from "@thodare/engine/registry";
import {
  createBackendCloudflareDynamic,
  createCloudflareDispatcher,
  DynamicWorkflowBinding,
  LogSession,
} from "@thodare/backend-cloudflare-dynamic";

// Re-export required by @cloudflare/dynamic-workflows.
export { DynamicWorkflowBinding, LogSession };

// Build registries with your connectors + tools.
const blockRegistry = new BlockRegistry();
const toolRegistry = new ToolRegistry();
// ... register blocks and tools ...

// Register as `class_name` in wrangler.jsonc [[workflows]].
export const { ThodareWorkflow } = createCloudflareDispatcher({
  blockRegistry,
  toolRegistry,
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const backend = await createBackendCloudflareDynamic({
      env,
      organizationId: "org-123",
    });

    // Persists workflow definition to D1.
    await backend.defineWorkflow({ name: "hello" }, async () => {});
    await backend.setWorkflowDefinition("hello", 1, {
      version: "1.0.0",
      blocks: [/* ... */],
      connections: [/* ... */],
    });

    // Creates a CF Workflow instance. The runtime walker executes the
    // workflow JSON via @thodare/engine's walkWorkflow.
    const { runId } = await backend.runWorkflow("hello", { x: 1 });

    // Stream logs live via LogSession DO.
    await backend.streams.write("logs", runId, {
      index: 0,
      data: { message: "Workflow started" },
      timestamp: new Date().toISOString(),
    });

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
| `supportsLiveSubscription` | `true` | LogSession DO + WebSocket fan-out |
| `supportsStepIOInspection` | `true` | cf-step-shim writes step rows to D1 |
| `supportsResumeFromStep` | `false` | CF Workflows requires re-create |
| `supportsRecover` | `false` | |
| `liveSubscriptionLatencyMs` | 200 | DO + WS estimate per proposal §4.7 |
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
   `{ workflowId, organizationId, workflowVersion, runId }` in metadata — never
   any `hidden()` param, never any credential.

3. **Loader runs on every step resume.** Cloudflare's `dispatchWorkflow`
   does not internally cache — rely on Worker Loader's isolate cache.
   Loader callbacks must be cheap; the adapter's loader makes one D1 read
   per resume.

## Known test limitations

- **Real-engine E2E: first dispatch works, second may not.** The
  `tests/real-engine-e2e.test.ts` exercises `wrapWorkflowBinding.create()`
  → CF Workflows engine → `ThodareWorkflow.run()` → `walkWorkflow`. The
  first invocation dispatches successfully in the `@cloudflare/vitest-pool-workers`
  workerd (v0.12.21) — step rows and lifecycle events land in D1. A
  second invocation in the same test run may stay in `"running"` status
  indefinitely, which is consistent with the upstream library's own test gap
  (`code-reviews/dynamic-workflows.md` §6: no end-to-end test that exercises
  `wrapWorkflowBinding` → `WorkflowEntrypoint.run` with a real WorkerLoader).
  **Phase 5+ follow-up:** validate against a real CF Workflows deployment
  with `wrangler dev`.

## Fallback

This is the initial alpha. There is no prior version of this package to
downgrade to. If the CF adapter does not fit your deployment, the
`@thodare/backend-openworkflow-pg` (Postgres) and
`@thodare/backend-openworkflow-sqlite` (in-process SQLite) adapters
implement the same `ThodareBackend` interface and ship today. Switching
adapters is a one-line change in your Worker entry point.

## License

MIT. Depends on `@cloudflare/dynamic-workflows` (MIT, © Dan Lapid 2026),
`@thodare/backend` (MIT), and `@thodare/engine` (MIT).
