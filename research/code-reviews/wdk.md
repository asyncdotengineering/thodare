# Vercel Workflow Development Kit (WDK) — Source-Level Code Review for Thodare

Repository: `vercel/workflow` @ shallow-clone snapshot under `agent-control-panel/workflow/`. Apache-2.0. Monorepo: 28 packages, pnpm workspaces, turbo, Biome, vitest. The interface package (`@workflow/world`) is at version `5.0.0-beta.1` per `packages/world/package.json:3`. zod is pinned at `4.3.6` via the `pnpm-workspace.yaml:catalog`.

This review is written for a Thodare maintainer who needs to decide what of WDK's design to copy verbatim, what to deliberately diverge from, and what to be wary of when defining a Worlds-and-Adapters port.

---

## 1. Repo map — every package, role, and what it surfaces

Roles use four buckets: **port** (the abstraction), **runtime** (the engine that uses it), **world** (substrate adapters), **build/framework** (compile- and deploy-time integration), **utility** (helpers and tooling).

### Port

- **`@workflow/world`** (`packages/world/src/`) — port definition only. Three composed interfaces: `Storage`, `Queue`, `Streamer` (combined into `World` via `extends Queue, Streamer, Storage` at `interfaces.ts:240`). Zod schemas for events, runs, steps, hooks, waits, queue payloads. Spec-version constants (`spec-version.ts:22-29`). ULID timestamp validation. Ships only types and shared validators — no IO. Single dep: `ulid`. Peer dep: `zod`.
- **`@workflow/serde`** (`packages/serde/src/`) — exports `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` symbols (registered as `Symbol.for("workflow-serialize")`). Pure constants, used by user code to mark classes for cross-bundle serialization. Tiny.
- **`@workflow/errors`** (`packages/errors/src/`) — typed error classes (`EntityConflictError`, `ThrottleError`, `RunExpiredError`, `TooEarlyError`, `WorkflowWorldError`, `WorkflowRuntimeError`, `RetryableError`, `FatalError`, `StepNotRegisteredError`, `HookNotFoundError`, etc.) plus `ERROR_SLUGS`. Uses `is()` static guards instead of `instanceof` for cross-realm safety (the runtime executes user code in a `vm.Context`, see §5).

### Runtime

- **`@workflow/core`** (`packages/core/src/`) — the engine. Holds `runtime/world.ts` (the `getWorld()` resolver), `start.ts` (initiate runs), `step-handler.ts` (~892 LOC), `suspension-handler.ts`, `runs.ts` (cancel/recreate/stopSleep), `vm/` (the deterministic sandbox), `workflow.ts` (~776 LOC, the orchestrator that runs workflow code inside `vm.Context`), `events-consumer.ts` (replays the event log), `serialization.ts` and `serialization-format.ts` (devalue-based binary format), `encryption.ts` (browser-safe AES-GCM).
- **`workflow`** (`packages/workflow/src/index.ts:1-2`) — public umbrella package. Pure re-export of `@workflow/core` + `./stdlib.js`. This is what users `npm install`.
- **`@workflow/ai`** (`packages/ai/src/`) — AI-SDK companion. `agent/durable-agent.ts` (~752 LOC class) plus `do-stream-step.ts`, `stream-text-iterator.ts`, `tools-to-model-tools.ts`, `workflow-chat-transport.ts`. Wraps AI SDK so model calls and tool invocations become workflow steps; module-internal functions like `writeFinishChunk`, `closeStream`, `convertChunksToUIMessages` carry inline `'use step'` directives (`durable-agent.ts:1401, 1416, 1439`). Provider adapters live under `providers/{anthropic,google,openai,xai,gateway,mock}.ts`.

### Worlds (substrate adapters)

- **`@workflow/world-local`** (`packages/world-local/src/`) — file-based dev world. Storage = JSON files under `.workflow-data/` (per-entity dirs `runs/`, `steps/`, `events/`, `hooks/`, `waits/`, `streams/`). Queue = in-process `setTimeout`-driven dispatcher backed by a `Sema` semaphore (default concurrency 1000). Streamer = file-based with `.bin` chunks. Surfaces a `LocalWorld` extension type with `registerHandler()` (skip HTTP, dispatch in-process) and `clear()` (test cleanup). Tags scope files for parallel vitest workers. Declares `specVersion: SPEC_VERSION_CURRENT` (3) at `index.ts:67`.
- **`@workflow/world-postgres`** (`packages/world-postgres/src/`) — production self-host. Drizzle schema in `drizzle/schema.ts` (`workflow_runs`, `workflow_events`, `workflow_steps`, `workflow_hooks`, `workflow_waits`, `workflow_stream_chunks`). Queue = `graphile-worker` (default concurrency 10). Streaming = LISTEN/NOTIFY on `workflow_event_chunk` topic + bytea chunks. CBOR via cbor-x for binary columns, but with parallel `*_json` columns marked `@deprecated` for legacy reads. Reuses `world-local` queue handler shape (see "surprises" §7). Has a pgboss → graphile migration path baked in at `queue.ts:285-330`.
- **`@workflow/world-vercel`** (`packages/world-vercel/src/`) — managed. Storage = HTTP API to Vercel's workflow service. Queue = `@vercel/queue` `QueueClient.send()` with CBOR transport (`specVersion >= 3`) and JSON fallback for older runs. Encryption is real (`getEncryptionKeyForRun` implemented via HKDF-SHA256, `encryption.ts:33-72`). Streamer uses a 13-byte custom binary control frame (`streamer.ts:35-83`) with magic footer `WFCT` to pass `done`/`nextIndex` over HTTP. Implements `resolveLatestDeploymentId`. `specVersion = 3` (`index.ts:28`).
- **`@workflow/world-testing`** (`packages/world-testing/src/`) — *not a world implementation*. It is a Hono test server (`server.mts`) and a Vitest cross-world conformance suite (`createTestSuite(pkgName)` at `index.mts:7`) that community worlds run against to validate their World implementation passes WDK's invariants (`addition`, `idempotency`, `hooks`, `nullByte`, `errors` test packs).

### Build / framework integrations

- **`@workflow/swc-plugin`** (`packages/swc-plugin-workflow/`) — Rust SWC plugin. Three modes: `step`, `workflow`, `detect`. Emits the `__internal_workflows{...}*/` JSON manifest comment and rewrites `'use step'` / `'use workflow'` functions. Has its own 1169-line `spec.md`. See §4.
- **`@workflow/builders`** (`packages/builders/src/`) — esbuild + SWC orchestration. Discovers workflow/step files (regexp pre-scan, then SWC `detect` pass), extracts manifest comments via `workflows-extractor.ts`, builds workflow and step bundles separately, applies `module-specifier`-based ID rewrites for cross-bundle stability, and resolves `workflow/internal/builtins` pseudo-package via `pseudo-package-esbuild-plugin.ts`. Two output targets: `next` (functions dirs) and `vercel-build-output-api.ts` (Vercel Build Output API v3).
- **`@workflow/next`** (`packages/next/src/`) — Next.js integration. `withWorkflow(nextConfig, opts)` wraps `next.config.js`. Two builder paths: eager (file-write at config time, all Next versions) and deferred (Next 16.2+ canary using `experimental.deferredEntries`, gated by `WORKFLOW_NEXT_LAZY_DISCOVERY=1`). Constants at `builder.ts:7-11` show the three deferred entries: `/.well-known/workflow/v1/{flow,step,webhook/[token]}`. Sets `WORKFLOW_TARGET_WORLD=local` automatically when `VERCEL_DEPLOYMENT_ID` is absent.
- **`@workflow/sveltekit`** (`packages/sveltekit/src/`) — three files. `index.ts` triggers a top-level `await builder.build()` then patches `.vercel/output/functions/.well-known/workflow/v1/{flow,step}.func/.vc-config.json` to attach `experimentalTriggers: [{type:'queue/v2beta', topic:'__wkf_workflow_*'}]` (`index.ts:18-49`).
- **`@workflow/astro`** (`packages/astro/src/`) — `builder.ts`, `index.ts`, `plugin.ts`. Same three-route pattern.
- **`@workflow/nitro`** (`packages/nitro/src/`) — Nitro module + Vite plugin shim. `builders.ts`, `vite.ts`.
- **`@workflow/nuxt`** (`packages/nuxt/src/module.ts`) — single-file Nuxt module that delegates to nitro.
- **`@workflow/vite`** (`packages/vite/src/`) — `index.ts` + `hot-update.ts` for HMR-aware bundling.
- **`@workflow/rollup`** (`packages/rollup/src/`) — Rollup plugin form of the SWC transform. Used by `@workflow/vitest`.
- **`@workflow/nest`** (`packages/nest/src/`) — NestJS controller decorators that mount the three `/.well-known` routes onto a Nest router.
- **`@workflow/vitest`** (`packages/vitest/src/`) — in-process testing harness. Uses a `VitestBuilder extends BaseBuilder` (`index.ts:18`) that builds bundles to a tmp dir, then uses `setWorld()` to inject a `LocalWorld` and `world.registerHandler()` to bypass HTTP entirely.

### Tooling / utility / observability

- **`@workflow/cli`** (`packages/cli/src/`) — `commands/` + `lib/` + `base.ts`. The `workflow` CLI: dev, build, deploy, runs:list/cancel, hooks, etc.
- **`@workflow/utils`** (`packages/utils/src/`) — `parse-name.ts` (parses the `step//module//name` ID structure into `shortName`/`moduleSpecifier`/`functionName`), `world-target.ts` (the `WORKFLOW_TARGET_WORLD` env var resolver, see §5), `get-port.ts`, `pluralize.ts`, `promise.ts` (`withResolvers`), `time.ts`.
- **`@workflow/typescript-plugin`** (`packages/typescript-plugin/src/`) — TS Language Service plugin: type-aware diagnostics that call out non-serializable args to step functions, missing `'use step'` directives, etc.
- **`@workflow/web`** (`packages/web/`) — the Observability UI (React Router 7 SPA). Reads runs/events/steps/hooks via the World's storage interface from a server-side React Router loader (`workflow-server-actions.server.ts`). Reads `.well-known/workflow/v1/manifest.json` to discover workflows.
- **`@workflow/web-shared`** (`packages/web-shared/src/`) — shared React components for the observability UI.
- **`@workflow/tsconfig`** — shared tsconfig.
- **`@workflow/docs-typecheck`** — runs `tsc` over the documentation snippets to keep docs honest.

---

## 2. The World contract — every method, every type, every invariant

`packages/world/src/interfaces.ts:240` declares:

```ts
export interface World extends Queue, Streamer, Storage {
  specVersion?: number;
  start?(): Promise<void>;
  close?(): Promise<void>;
  resolveLatestDeploymentId?(): Promise<string>;
  getEncryptionKeyForRun?(run: WorkflowRun): Promise<Uint8Array | undefined>;
  getEncryptionKeyForRun?(
    runId: string,
    context?: Record<string, unknown>
  ): Promise<Uint8Array | undefined>;
}
```

Six surface areas: `Storage` (a 4-namespace facade), `Queue`, `Streamer`, plus four optional lifecycle hooks (`specVersion`, `start`, `close`, `resolveLatestDeploymentId`, encryption). The comments are unusually load-bearing — they encode invariants the type system cannot.

### 2.1 Spec versions are branded (`spec-version.ts`)

```ts
export type SpecVersion = number & { readonly [SpecVersionBrand]: typeof SpecVersionBrand };
export const SPEC_VERSION_LEGACY = 1 as SpecVersion;                          // pre-event-sourcing JSON storage
export const SPEC_VERSION_SUPPORTS_EVENT_SOURCING = 2 as SpecVersion;          // baseline community worlds must support
export const SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT = 3 as SpecVersion;    // CBOR queue payloads, Uint8Array-native
export const SPEC_VERSION_CURRENT = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT as SpecVersion;
```

Two helpers: `isLegacySpecVersion(v)` (true when `v === undefined || v <= 1`) and `requiresNewerWorld(v)` (true when `v > SPEC_VERSION_CURRENT`). The branded type forces every package to import the constant rather than write `2` inline.

The `World.specVersion` comment at `interfaces.ts:243-250` says: *"When set, `start()` creates runs at this version so world-specific features (e.g., CBOR queue transport) are enabled automatically. When omitted, runs default to `SPEC_VERSION_SUPPORTS_EVENT_SOURCING` (2), the safe baseline that all worlds — including community worlds on older `@workflow/world` versions — are expected to handle."* Confirmed in `start.ts:180-183`:

```ts
const specVersion =
  opts.specVersion ??
  world.specVersion ??
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING;
```

### 2.2 Storage — append-only event log, materialized views

The doc-comment at `interfaces.ts:118-132` is the clearest single statement of WDK's storage model:

> *"Workflow storage models an append-only event log, so all state changes are handled through `events.create()`. Run/Step/Hook entities provide materialized views into the current state, but entities can't be modified directly. … Note: Hooks are automatically disposed by the World implementation when a workflow reaches a terminal state (run_completed, run_failed, run_cancelled). This releases hook tokens for reuse by future workflows."*

Four namespaces:

- `Storage.runs.{get,list}` — `get` is overloaded three ways on the `resolveData` discriminator (`'none'` returns `WorkflowRunWithoutData`, `'all'` returns full `WorkflowRun`). `list` returns `PaginatedResponse<...>` (see `shared.ts:29`).
- `Storage.steps.{get,list}` — same overload pattern.
- `Storage.events.{create,get,list,listByCorrelationId}` — `create` is overloaded to accept `runId: string | null` for the *first* event (`run_created`) and a strict `runId: string` thereafter. The `null` overload uses `RunCreatedEventRequest`; the string overload uses `CreateEventRequest = Exclude<AnyEventRequest, RunCreatedEventRequest>`. Both return `EventResult` (defined at `events.ts:374-391`):

```ts
export interface EventResult {
  event?: Event;        // optional for legacy compat
  run?: WorkflowRun;    // for run_* events
  step?: Step;          // for step_* events
  hook?: Hook;          // for hook_created events
  wait?: Wait;          // for wait_* events
  events?: Event[];     // populated on run_started to skip an initial events.list call (TTFB optimization)
}
```

That last field is a key piece of operational ergonomics: the runtime needs the full event log to replay; the server can prepay the first `list` call when responding to `run_started`.

- `Storage.hooks.{get,getByToken,list}` — `getByToken` lookups are how the public webhook endpoint resolves the hook on `POST /.well-known/workflow/v1/webhook/{token}`. Note there is **no `hooks.create`** — hooks are created exclusively via `events.create({eventType: 'hook_created'})` to maintain the event-sourcing invariant.

### 2.3 Events — discriminated unions, two views

`packages/world/src/events.ts:56-77` defines the canonical event taxonomy:

```ts
export const EventTypeSchema = z.enum([
  // Run lifecycle
  'run_created', 'run_started', 'run_completed', 'run_failed', 'run_cancelled',
  // Step lifecycle
  'step_created', 'step_completed', 'step_failed', 'step_retrying', 'step_started',
  // Hook lifecycle
  'hook_created', 'hook_received', 'hook_disposed',
  'hook_conflict',          // World-only: created when token already exists
  // Wait lifecycle
  'wait_created', 'wait_completed',
]);
```

Two derived discriminated unions:

- `CreateEventSchema` — what callers may pass to `events.create`. Excludes `hook_conflict`. The doc-comment at `events.ts:177-189` is explicit: *"Event created by World implementations when a hook_created request conflicts with an existing hook token. This event is NOT user-creatable - it is only returned by the World when a token conflict is detected. When the hook consumer sees this event, it should reject any awaited promises with a HookTokenConflictError."*
- `AllEventsSchema` — what callers may *read* from the event log. Includes `hook_conflict`.

Then `EventSchema = AllEventsSchema.and(z.object({ runId, eventId, createdAt, specVersion: optional }))` adds the server-side identifiers.

The `EVENT_DATA_REF_FIELDS` map at `events.ts:10-20` declares which fields hold "ref/payload" data per event type — used by `stripEventDataRefs()` so that `resolveData: 'none'` strips only the heavy payloads (`input`, `output`, `result`, `error`, `metadata`, `payload`) and preserves metadata like `stepName`. This is what powers the cheap `list` calls.

Verbatim sample, the `step_completed` schema at `events.ts:95-101`:

```ts
const StepCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_completed'),
  correlationId: z.string(),
  eventData: z.object({
    result: SerializedDataSchema,   // Uint8Array (v2+) | unknown (legacy v1)
  }),
});
```

`run_started` carries optional run-creation data (`events.ts:225-242`) — *"the runtime passes the run input through the queue so the server can create the run on the run_started call if it doesn't exist yet."* This is the **resilient-start** path and is the load-bearing reason `run_created` and `queue.send` are issued in `Promise.allSettled` parallel at `start.ts:219-256` — if `run_created` fails with 429/5xx, the queue carries the data forward and the server materializes the run on `run_started`.

### 2.4 Serialization — Uint8Array all the way down (v2+)

`packages/world/src/serialization.ts:8-32`:

```ts
export type SerializedData = Uint8Array | unknown;
export const BinarySerializedDataSchema: z.ZodType<SerializedData> = z.instanceof(Uint8Array);
export const LegacySerializedDataSchemaV1: z.ZodType<unknown> = z.any();
export const SerializedDataSchema = z.union([BinarySerializedDataSchema, LegacySerializedDataSchemaV1]);
```

Comment: *"Binary serialized data using devalue format. This is the output of `TextEncoder.encode(devalue.stringify(...))`. The workflow core runtime handles serialization/deserialization, and World implementations store and transport this opaque binary payload."* This is the contract worth internalizing: **the World does not parse user data**. It stores opaque bytes. Devalue handles cycles, `Map`/`Set`/`Date`/`Uint8Array`/regex/typed arrays, and custom registered classes. WDK does not use JSON for user data after spec v2.

### 2.5 Run states and discriminated unions (`runs.ts:65-94`)

`WorkflowRunSchema` is a `z.discriminatedUnion('status', [...])` enforcing per-state shape:

- `pending|running` → `output: undefined, error: undefined, completedAt: undefined`
- `cancelled` → `output: undefined, error: undefined, completedAt: Date`
- `completed` → `output: SerializedData, error: undefined, completedAt: Date`
- `failed` → `output: undefined, error: StructuredError, completedAt: Date`

`StructuredError = { message: string, stack?: string, code?: string }` (`shared.ts:53-57`). The `code` field is "populated with `RunErrorCode` values (`USER_ERROR`, `RUNTIME_ERROR`) for `run_failed` events".

### 2.6 Queue — strict prefix taxonomy and templated names

`packages/world/src/queue.ts:3-10`:

```ts
export const QueuePrefix = z.union([
  z.literal('__wkf_step_'),
  z.literal('__wkf_workflow_'),
]);
export const ValidQueueName = z.templateLiteral([QueuePrefix, z.string()]);
```

Z4's `templateLiteral` enforces that every queue name is `${'__wkf_step_' | '__wkf_workflow_'}${string}`. This is the world-wide convention used by the SvelteKit Vercel adapter to subscribe to topics with wildcards (`'__wkf_workflow_*'`, see `sveltekit/src/index.ts:26-31`).

`MessageId = z.string().brand<'MessageId'>()` — branded so callers cannot fabricate message IDs.

Verbatim: the `Queue` interface (`queue.ts:88-120`):

```ts
export interface Queue {
  getDeploymentId(): Promise<string>;

  queue(
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions
  ): Promise<{ messageId: MessageId | null }>;

  createQueueHandler(
    queueNamePrefix: QueuePrefix,
    handler: (
      message: unknown,
      meta: {
        attempt: number;
        queueName: ValidQueueName;
        messageId: MessageId;
        requestId?: string;
      }
    ) => Promise<void | { timeoutSeconds: number }>
  ): (req: Request) => Promise<Response>;
}
```

Two non-obvious invariants encoded here:

1. **`messageId` may be `null`** (`queue.ts:102`). Confirmed by Vercel implementation comment at `world-vercel/src/queue.ts:236-237`: *"messageId may be null when VQS fails over to a different region — the event is ingested but the responding region cannot return an ID."*
2. **`createQueueHandler` returns a Web `(req: Request) => Promise<Response>`** — the queue handler is *itself an HTTP handler* that the framework integration mounts at `/.well-known/workflow/v1/{flow,step}`. The `Queue` is not a "pull from queue, dispatch in-process" pattern; it is "push from queue → HTTP POST → handler". This is the central WDK pattern (see §5.3).
3. **Returning `{ timeoutSeconds }` from the handler is how sleeps and `retry-after` work.** The queue layer reschedules. The doc-comment in `world-vercel/src/queue.ts:109-130` calls this out: *"VQS v3 supports `delaySeconds` which delays the initial delivery of a message. We use this for implementing sleep() by creating a new message with the delay … For sleeps > 24 hours (max delay), we use chaining."*

`QueueOptions` (`queue.ts:78-86`) carries `deploymentId`, `idempotencyKey`, `headers`, `delaySeconds`, `specVersion`. The `specVersion` here is used by the Vercel queue to choose CBOR vs JSON transport per-message — see `world-vercel/src/queue.ts:204-208`.

### 2.7 Streamer — `write/writeMulti/close/get/list/getChunks/getInfo`

`interfaces.ts:32-116`. Six methods plus an optional `streamFlushIntervalMs`. Two read modes:

- `get(runId, name, startIndex?)` — returns a *live* `ReadableStream<Uint8Array>` that yields new chunks as they arrive. Negative `startIndex` resolves to "n chunks before the end" (clamped to 0). This is how the observability UI tails workflow output in real time.
- `getChunks(runId, name, options?)` — returns a *paginated snapshot* `StreamChunksResponse` (`shared.ts:102-111`), with `data`, `cursor`, `hasMore`, *and* a `done` flag for "is the stream closed". This is the "fetch what's there now" mode used by HTTP clients without long-polling.

`getInfo(runId, name)` returns `{ tailIndex: number; done: boolean }` — used by the runtime to resolve negative `startIndex` to absolute positions before connecting.

`writeMulti` is optional — the comment at `interfaces.ts:53-69` says *"This is an optional optimization for world implementations that can batch multiple writes efficiently (e.g., single HTTP request for world-vercel). If not implemented, the caller should fall back to sequential write() calls."* World-postgres implements it (`streamer.ts:172-207`).

### 2.8 Recovery helper (`recovery.ts:14-49`)

Shipped as a *function*, not a method on `World`. `reenqueueActiveRuns(runs, enqueue, label)` lists all `pending` and `running` runs and re-enqueues them. Both `world-local` (`index.ts:78`) and `world-postgres` (`index.ts:69`) call this from their `start()` lifecycle hook. The comment notes: *"The workflow handler is idempotent (event-log replay), so duplicate enqueues are safe."* That idempotency is the load-bearing invariant for crash recovery.

### 2.9 ULID timestamp validation (`ulid.ts`)

Exported helpers `ulidToDate`, `validateUlidTimestamp`, plus three constants `DEFAULT_TIMESTAMP_THRESHOLD_MS`, `DEFAULT_TIMESTAMP_THRESHOLD_PAST_MS`, `DEFAULT_TIMESTAMP_THRESHOLD_FUTURE_MS`. Used to defend against clock-skew attacks where a client provides a runId with a future ULID.

---

## 3. The three official Worlds — what's identical, what diverges

| Aspect | world-local | world-postgres | world-vercel |
|---|---|---|---|
| Storage | JSON files per entity, `.locks` dir for atomic terminal-state guards | Drizzle on Postgres with parallel CBOR + legacy JSON columns, schema `workflow.*` | HTTP API to Vercel-managed service |
| Queue | In-process, `setTimeout` + `Sema`, HTTP fan-out via undici dispatcher | graphile-worker (3 attempts, default concurrency 10), reuses `world-local`'s `createQueueHandler` for HTTP | `@vercel/queue`'s VQS v3 + `delaySeconds` (max 23h, chains for longer) |
| Streamer | Per-stream files + EventEmitter for live tailing | LISTEN/NOTIFY on `workflow_event_chunk` topic + bytea + Mutex per stream | HTTP polling with custom 13-byte control frame (`WFCT` magic) |
| Encryption | None | None | HKDF(deploymentKey, projectId\|runId) → AES-256, fetched via Vercel API or derived locally |
| Spec version | `SPEC_VERSION_CURRENT` (3) | `SPEC_VERSION_CURRENT` (3) | `SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` (3, named explicitly) |
| `resolveLatestDeploymentId` | not implemented | not implemented | implemented (`resolve-latest-deployment.ts`) |
| Lifecycle | `start()` → re-enqueue active runs; `clear()` + tag scoping for tests | `start()` → `pgboss → graphile` migration, then re-enqueue | none — stateless wrt local process |

### 3.1 The most surprising piece — `world-postgres` reuses `world-local` internally

`packages/world-postgres/src/queue.ts:81-83`:

```ts
const port = process.env.PORT ? Number(process.env.PORT) : undefined;
const localWorld = createLocalWorld({ dataDir: undefined, port });
```

And the comment block at `queue.ts:62-71` is explicit:

> *"The Postgres queue works by creating two job types in graphile-worker… When a job is processed, it is deserialized and then re-queued into the local world, showing that we can reuse the local world, mix and match worlds to build hybrid architectures, and even migrate between worlds."*

Then at `queue.ts:125`: `const createQueueHandler = localWorld.createQueueHandler;` — **postgres's `createQueueHandler` is literally `world-local`'s `createQueueHandler`**. The Postgres world uses local for the in-process HTTP routing, and Postgres only for the durable scheduling layer. This is a profound design choice: Worlds compose. Treating the in-process dispatch as a separate concern from durability lets WDK assemble hybrid worlds without leaking abstractions.

### 3.2 `world-postgres` workflow-run serialization

`queue.ts:434-453` introduces `inflightWorkflowRuns: Map<string, Promise<...>>` keyed by `workflow:${runId}` — without an idempotency key, two queue messages for the same workflow run *serialize* in-process to prevent two concurrent replays from racing on the same event log. Step messages do not serialize (they fan out). The comment: *"Preserve step fan-out while preventing two workflow replays from mutating the same run's event log at the same time."*

This is the kind of invariant that has no business being implicit — a single-runtime concurrency guard hidden inside one world. A different world (e.g. multi-process) would need a distributed lock or a database-level concurrency control (advisory lock, SELECT FOR UPDATE, etc.). WDK leaves this to the implementer.

### 3.3 Encryption is opt-in per world, runtime gracefully degrades

`interfaces.ts:280-307` declares `getEncryptionKeyForRun` as **optional**, with two overloads:

- `(run: WorkflowRun) → key`: preferred, used when entity exists
- `(runId, context?) → key`: used by `start()` before entity exists

The comment: *"When not implemented, encryption is disabled — data is stored unencrypted."*

`start.ts:193-197`:

```ts
const rawKey = await world.getEncryptionKeyForRun?.(runId, { ...opts, deploymentId });
const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
```

The `?.` is the entire opt-in mechanism. The runtime passes `encryptionKey` down through `dehydrateWorkflowArguments`/`hydrateWorkflowArguments` and an undefined key flips encryption off. This is well-factored — an HTTP-only world can plug in a KMS/HKDF key derivation without touching the runtime.

`world-vercel/src/encryption.ts:33-72` shows `deriveRunKey(deploymentKey, projectId, runId)` using `HKDF-SHA256` with `info = ${projectId}|${runId}`, salt = 32 zero bytes. Comment cites RFC 5869 §3.1: *"Zero salt is acceptable per RFC 5869 Section 3.1 when the input key material has high entropy (as is the case with our random deployment key)."* Per-run keys, no shared key across runs.

### 3.4 Stream handling diverges most

- **Local** writes chunks as `.bin` files and uses an EventEmitter for live tailing.
- **Postgres** uses `LISTEN/NOTIFY` on a single channel `workflow_event_chunk` (`streamer.ts:108`) and dedupes subscribers via an `Rc<Mutex>` reference-counted resource pool. The notification carries only `{streamId, chunkId}` — subscribers fetch the chunk data via Drizzle. There is **one shared LISTEN client** for the entire process. ULID-ordered keys give cross-row sort.
- **Vercel** uses HTTP. The 13-byte control frame trick (`streamer.ts:35-83`) is non-obvious: the server returns a chunk stream that ends with a sentinel — 4 zero bytes, 1 flag byte (bit 0 = done), 4 bytes of nextIndex (big-endian uint32), then magic `WFCT`. Clients parse the tail of every read to detect "stream is done" vs "timeout — please reconnect at index N". This is a lower-overhead alternative to SSE event types or chunked-encoding trailers.

---

## 4. The SWC plugin — what it actually emits

Plugin name: `@workflow/swc-plugin`. Spec: `packages/swc-plugin-workflow/spec.md` (1169 lines). Three modes selected via plugin config: `step` | `workflow` | `detect`. All three modes emit a JSON manifest comment at the top of each touched file. `detect` mode does not modify anything else — it exists so that `@workflow/builders` can fast-scan the project with regexp, then run SWC in `detect` to validate at AST level.

### 4.1 The manifest comment

`spec.md:23`:

```
/**__internal_workflows{"workflows":{"path/file.ts":{"myWorkflow":{"workflowId":"workflow//./path/file//myWorkflow"}}},"steps":{...},"classes":{...}}*/
```

`builders/src/workflows-extractor.ts` reads these comments out of every emitted file to build `manifest.json`. The same JSON is what the observability UI (`web/`) reads to discover workflows in a deployment.

### 4.2 ID format (`spec.md:34-86`)

Format: `{type}//{modulePath}//{identifier}` where:
- `type` ∈ `workflow | step | class`
- `modulePath` is either a versioned npm specifier (`point@0.0.1`, `@myorg/shared@1.2.3`, `workflow/internal/builtins@4.0.0`) when `moduleSpecifier` config is provided, or a relative path prefixed `./` (`./src/jobs/order`) — file extensions stripped — when not.
- `identifier` is the function/class name. Nested functions use `/` separators; static methods use `.` (e.g. `MyClass.staticMethod`); instance methods use `#` (`Counter#add`).

Versioning the ID is what makes class serialization safe across cross-bundle deploys. The `parseWorkflowName` / `parseStepName` helpers in `@workflow/utils/parse-name` take this apart at the runtime side.

### 4.3 `'use step'` output (Step mode)

`spec.md:101-119` — input `export async function add(a, b) { "use step"; return a + b; }`:

```js
/**__internal_workflows{...}*/;
export async function add(a, b) {
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"),
        __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(add, "step//./input//add");
```

Three things happen: directive stripped, function attached `.stepId`, function registered in a globally-shared `Map` keyed by `Symbol.for("@workflow/core//registeredSteps")`. **No imports** — the registration is a self-contained IIFE so third-party packages can ship steps without depending on `@workflow/core`. The cross-realm (`Symbol.for`) registry is the load-bearing trick.

### 4.4 `'use workflow'` output (Workflow mode)

`spec.md:447-457` — workflow-mode replaces step bodies with proxies and keeps workflow bodies intact:

```js
// step (in workflow bundle):
export var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//add");
// workflow:
export async function myWorkflow(data) { /* original body */ }
myWorkflow.workflowId = "workflow//./input//myWorkflow";
globalThis.__private_workflows.set("workflow//./input//myWorkflow", myWorkflow);
```

In step mode, workflow bodies are replaced with a *throwing stub* (`spec.md:159-162`) so direct invocation fails with a clear error message. After both rewrites, the plugin runs DCE to remove now-unreferenced helpers and imports — heavily so in workflow mode where step bodies are gone.

### 4.5 Closure variables (`spec.md:303-340`)

Workflow mode passes captured variables as a *closure factory function*:

```js
var increment = globalThis[Symbol.for("WORKFLOW_USE_STEP")](
  "step//./input//myWorkflow/increment",
  () => ({ count })
);
```

Step mode hoists the closure-using function to module level and injects an inline IIFE that reads `closureVars` from `WORKFLOW_STEP_CONTEXT_STORAGE` (an AsyncLocalStorage installed by the runtime). Detection walks the AST recursively — including nested classes, getters/setters, TS expression wrappers (`as`, `satisfies`, `!`, instantiation expressions) — and excludes imports and module-level declarations.

### 4.6 Custom serialization (`spec.md:617-660`)

Classes can declare `static [WORKFLOW_SERIALIZE]` and `static [WORKFLOW_DESERIALIZE]` (or `Symbol.for("workflow-serialize")` / `Symbol.for("workflow-deserialize")` directly). Plugin emits an IIFE that registers the class in `globalThis[Symbol.for("workflow-class-registry")]` and `Object.defineProperty(cls, "classId", {value: id, writable:false})`. Discovery is automatic — files importing from `@workflow/serde` or using the `Symbol.for("workflow-serialize")` literal are picked up even without `'use step'` / `'use workflow'` directives.

Cross-bundle registration is automatic: every class-with-serde is included in *both* the workflow bundle and the step bundle so any boundary crossing can serialize/deserialize. `spec.md:907-921`.

### 4.7 Validation errors (`spec.md:949-963`)

Eight rejection cases including non-async workflows, instance `'use workflow'` (only static OK), getters with `'use workflow'` (only `'use step'` OK), conflicting module-level directives, misspellings (`"use steps"`).

---

## 5. The runtime — how `getWorld()` resolves, how a run starts, how a step is dispatched

### 5.1 `getWorld()` resolution (`runtime/world.ts`)

The resolver is at `world.ts:73-126`. Reads `WORKFLOW_TARGET_WORLD` via `resolveWorkflowTargetWorld()` (`utils/world-target.ts`). Default fallback at `world-target.ts:11`:

```ts
return env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local';
```

Three branches:
1. `vercel` (or `@workflow/world-vercel`) → `createVercelWorld()`
2. `local` → `createLocalWorld({ dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR })`
3. Anything else → dynamic `import(targetWorld)`, then call `mod()` | `mod.default()` | `mod.createWorld()`. Falls back to CJS `require()` for environments where `new Function('specifier', 'return import(specifier)')` is unavailable. The `dynamicImport = new Function(...)` trick at `world.ts:36-38` exists specifically to hide the import from bundlers so they don't try to resolve it at build time.

Caching uses `Symbol.for('@workflow/world//cache')` on `globalThis` — cross-realm safe (the runtime's `vm.Context` has its own `globalThis` but `Symbol.for` is shared). There are *two* caches: `WorldCache` (full world) and `StubbedWorldCache` (just `createQueueHandler` + `specVersion`, safe to call at build time before env vars are set). Both are hydrated via cached promises with explicit error-clear semantics so a failed creation doesn't poison subsequent calls (`world.ts:144-150`).

`setWorld()` is the testing hook — `vitest` and `world-testing` use it to inject `LocalWorld` instances directly.

### 5.2 `start()` (`runtime/start.ts`)

Ten distinct concerns in ~200 lines:

1. **Validate the workflow function** carries `workflowId` (set by SWC). Throws `WorkflowRuntimeError('start-invalid-workflow-function')` if not.
2. **Resolve world** (passed in `opts.world` or `getWorld()`).
3. **Resolve `deploymentId`** (`opts.deploymentId` ?? `world.getDeploymentId()`). If `'latest'`, requires `world.resolveLatestDeploymentId()`.
4. **Generate runId client-side** (`wrun_${ulid()}`) — note `start.ts:170-171`: *"required for future E2E encryption where runId is part of the encryption context"*. Confirmed by the HKDF derivation at `world-vercel/src/encryption.ts:55`.
5. **Serialize trace context** for cross-queue OTEL propagation.
6. **Resolve specVersion** with the cascade in §2.1.
7. **Resolve encryption key** via `world.getEncryptionKeyForRun?.()`.
8. **Dehydrate args** to `Uint8Array` via `dehydrateWorkflowArguments`.
9. **Issue `events.create(run_created)` and `world.queue(...)` in parallel via `Promise.allSettled`** — the resilient-start path. Queue failure is fatal, but `events.create` failure with 429/5xx becomes "resilient start" — the runtime will recover via `run_started` carrying the `runInput`.
10. **Verify server-accepted runId** — *"Verify server accepted our runId"* (`start.ts:294-298`).

The resilient-start handling distinguishes three error categories: `EntityConflictError` (409, run already exists, return success), `ThrottleError | WorkflowWorldError(>=500)` (retryable, mark `resilientStart=true`), other errors (throw). `start.ts:262-284`.

### 5.3 The HTTP route trio: `/.well-known/workflow/v1/{flow,step,webhook/[token]}`

The framework integration owns route mounting. Sources of truth:

- `next/src/builder.ts:7-11` declares the three routes for Next 16.2+ deferred entries.
- `next/src/builder-deferred.ts:186-188` writes the `route.js` files.
- `sveltekit/src/index.ts:18-49` patches the `.vercel/output/functions/.well-known/workflow/v1/{flow,step}.func/.vc-config.json` with `experimentalTriggers`.
- `world-local/src/queue.ts:161,173` POSTs to `${baseUrl}/.well-known/workflow/v1/${pathname}` where `pathname ∈ {flow, step}`.
- `world-postgres/src/queue.ts:256` does the same.
- `core/src/workflow/create-hook.ts:51` constructs the public URL: `${url}/.well-known/workflow/v1/webhook/${encodeURIComponent(hook.token)}`.
- `vercel-build-output-api.ts:158` declares the routing: `dest: '/.well-known/workflow/v1/webhook/[token]'`.

The handler factory at the route is essentially `world.createQueueHandler('__wkf_workflow_', stepHandler)` — see `core/src/runtime/step-handler.ts:50-52`:

```ts
const stepHandler = (worldHandlers: WorldHandlers) =>
  worldHandlers.createQueueHandler(
    '__wkf_step_',
    async (message_, metadata) => { /* ... */ }
  );
```

So a framework adapter's job is essentially: import `getWorldHandlers()` and `stepHandler`/`flowHandler`/`webhookHandler`, mount the resulting `(req: Request) => Promise<Response>` at the three paths. The framework is unaware of the queue substrate.

### 5.4 Step dispatch lifecycle

Inside `step-handler.ts`, on each delivery:

1. **Health check** — `HealthCheckPayloadSchema` first. Health check is intentionally unauthenticated; payload includes `correlationId` so the response stream is unguessable (`step-handler.ts:55-66`).
2. **Max-delivery guard** — `MAX_QUEUE_DELIVERIES = 48` (`runtime/constants.ts`). On exceeding, attempts to mark step failed and re-enqueue the workflow exactly once, then consumes the message. Comment at `step-handler.ts:118-126` warns that persistent failure is "most likely due to a persistent outage of the workflow backend or a bug in the workflow runtime and should be reported".
3. **Fetch step function** from the in-process step registry by name.
4. **Issue `step_started` event** — server validates state and returns the entity. Returns:
   - `409 EntityConflictError` → step already terminal, re-enqueue workflow and exit.
   - `425 TooEarlyError` → `retryAfter` not reached yet, return `{timeoutSeconds: err.retryAfter}` for the queue to reschedule.
   - `429 ThrottleError` → return `{timeoutSeconds: ...}`.
   - `410 RunExpiredError` → workflow finished, drop.
5. **Execute step body** inside the propagated trace context.
6. **Dehydrate result and issue `step_completed` / `step_failed` event**.
7. **Re-enqueue the workflow** so it can replay with the new event.

### 5.5 Workflow VM replay — `vm.Context` + deterministic globals

`packages/core/src/vm/index.ts` (123 lines, very dense) builds the deterministic sandbox:

- `seedrandom(seed)` where `seed = "${runId}:${workflowName}:${+startedAt}"` — `Math.random` becomes deterministic.
- `Date()` constructor returns `fixedTimestamp` when called with no args; `Date.now()` returns `fixedTimestamp`. The static methods are preserved via `Object.setPrototypeOf(g.Date, Date_)`.
- `crypto.getRandomValues` and `crypto.randomUUID` use the seeded RNG; `crypto.subtle.generateKey` throws "Not implemented"; `crypto.subtle.digest` is bound to the host (digesting is deterministic). Implemented via `Proxy` to avoid mutating the host's globals.
- `process.env` is `Object.freeze({...process.env})` — read-only.
- TC39 polyfills installed: Uint8Array base64/hex (`installUint8ArrayBase64`), `Symbol.dispose` / `Symbol.asyncDispose`.
- `g.exports = {}` and `g.module = { exports: g.exports }` — labeled "HACK: Shim `exports` for the bundle" (`vm/index.ts:112-114`).

`updateTimestamp(ts)` is exposed so the orchestrator can advance the clock as it consumes each event (`workflow.ts:159-166`). The `startedAt` of the run is the initial value; each consumed event's `createdAt` advances it. This is **how `Date.now()` returns deterministic values during replay** — every step that executed at time T sees `Date.now() === +T` during all subsequent replays.

`workflow.ts:225-266` explicitly stubs `fetch` (throws — must use the `fetch` step), and `setTimeout`/`setInterval`/`setImmediate` and their clear- counterparts (throw — must use `sleep`). The workflow VM has no async scheduling primitives by design.

The orchestrator wires `WORKFLOW_USE_STEP`, `WORKFLOW_CREATE_HOOK`, `WORKFLOW_SLEEP`, `WORKFLOW_GET_STREAM_ID` symbols into the sandbox `globalThis` (`workflow.ts:189-201`) so the SWC-emitted `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id")` calls land here. The symbols are imported from `core/src/symbols.ts`.

The `EventsConsumer` (`events-consumer.ts`) is a subscriber dispatch system: each `useStep`/`createHook`/`sleep` call subscribes a callback that consumes the next matching event from the log. The orchestrator subscribes a passive subscriber for `updateTimestamp` and a structural consumer that eats `run_created` and `run_started` events. The promise queue holder pattern (`workflow.ts:124, 149-154`) lets the consumer always see the latest queue state as it's mutated by callbacks during replay.

---

## 6. Framework integrations — what's the contract, how thin

The contract a framework adapter must implement:

1. **Run the build pipeline.** Use `@workflow/builders` to discover `'use step'`/`'use workflow'` files via SWC `detect` mode, build separate workflow and step bundles (workflow bundle = workflow code + step proxies; step bundle = step code + workflow throwing stubs), and emit `manifest.json` plus three route handler files.
2. **Mount three routes.** `POST /.well-known/workflow/v1/flow`, `POST /.well-known/workflow/v1/step`, `POST /.well-known/workflow/v1/webhook/[token]`. Each route handler is `(req: Request) => Promise<Response>` returned from `world.createQueueHandler(prefix, handler)`.
4. **Set `WORKFLOW_TARGET_WORLD` env var sensibly.** Next sets `local` when no `VERCEL_DEPLOYMENT_ID`, else `vercel` (`next/src/index.ts:68-81`).
5. **(Optional) Patch deploy-target config** — SvelteKit patches Vercel `.vc-config.json` to attach `experimentalTriggers: [{type:'queue/v2beta', topic:'__wkf_workflow_*'}]` (`sveltekit/src/index.ts:20-48`).

How thin actually:
- **`@workflow/nuxt/src/module.ts`** — single file; delegates to nitro.
- **`@workflow/sveltekit/src/index.ts`** — 80 lines plus `builder.ts` and `plugin.ts`.
- **`@workflow/astro/src/`** — 3 files (`builder.ts`, `index.ts`, `plugin.ts`).
- **`@workflow/next/src/`** — 8 files, the heaviest (eager + deferred builders, socket-server for HMR-aware build coordination, runtime stub).

The next/runtime stub is itself a microcosm of the design (`next/src/runtime.ts:1-5`):

```ts
// re-export runtime as stub for resolving to not
// require @workflow/core be a dependency as well as
// @workflow/next
export * from '@workflow/core/dist/runtime';
```

The framework adapter doesn't depend on the runtime; it just hands the runtime URL to the user's bundle.

---

## 7. Top 10 surprises / non-obvious decisions

1. **Worlds compose, and `world-postgres` reuses `world-local` for HTTP routing.** `world-postgres/src/queue.ts:82` literally instantiates a local world and uses its `createQueueHandler`. The architectural unit "queue handler" is decoupled from "queue substrate".

2. **The queue handler is itself an HTTP handler, not a pull loop.** `Queue.createQueueHandler` returns `(req: Request) => Promise<Response>`. The substrate is responsible for *delivering* messages by HTTP POST to the well-known route. There is no pull-from-queue API exposed to the runtime. This unifies the dispatch story across local (in-process undici fetch), postgres (graphile-worker → fetch), and Vercel (VQS → serverless function invoke). Adapting to a substrate that's pull-only (e.g. SQS, Kafka) requires either an embedded HTTP server inside the world or a translation layer.

3. **`messageId` may be null** (`queue.ts:102`, `world-vercel/src/queue.ts:236-237`) — region-failover semantics leak through the contract. Code that depends on the returned `messageId` for tracking has to handle this.

4. **The runtime executes user workflow code in a Node `vm.Context` with patched `Math.random`, `Date`, `crypto`, `process.env`, and stubbed `fetch`/`setTimeout`** (`vm/index.ts`, `workflow.ts:225-266`). This is deeper than I expected for a "JS-first" SDK — every execution rebuilds the sandbox. This implies real CPU cost per workflow invocation and an explicit Node-only constraint (`vm` is not available in V8 isolates / Workers / Deno without polyfilling).

5. **The build pipeline emits *two* bundles per workflow file** — workflow-mode (steps replaced with proxies, workflow bodies preserved) and step-mode (step bodies preserved, workflow bodies replaced with throwing stubs). The same source file becomes two artifacts, deployed as the `flow` and `step` route handlers respectively. Plus `webhook/[token]` for hook resumption. This is what allows steps and workflows to have *different runtime requirements* (steps run in Node with real `fetch`, workflows run in `vm.Context`).

6. **Cross-realm registration is via `Symbol.for(...)`** — `Symbol.for("@workflow/core//registeredSteps")`, `Symbol.for("workflow-class-registry")`, `Symbol.for("WORKFLOW_USE_STEP")`. This survives the `vm.Context` boundary (`Symbol.for` is shared) and removes the need for the SWC plugin's emitted code to import from `@workflow/core` (matters for third-party packages that ship steps).

7. **The `EventResult.events` field is a TTFB optimization** — when responding to `run_started`, the World may include the full event list so the runtime can skip the first `events.list()` call (`events.ts:385-390`). This means the World implementation is encouraged to be *aware of* what the runtime will do next. Worlds that don't pre-pay this cost just leave `events` undefined.

8. **There is no `World.getUrl()` method.** Two TODO comments call this out (`workflow.ts:203`, `step-handler.ts:516`): *"there should be a getUrl method on the world interface itself. This solution only works for vercel + local worlds."* Today the runtime hardcodes `https://${VERCEL_URL}` or `http://localhost:${port}`. Custom worlds running behind reverse proxies or non-localhost dev servers have to set env vars.

9. **The CBOR transport upgrade was an *additive* spec version, not a breaking one.** `world-vercel/src/queue.ts:71-95` defines a `DualTransport` that serializes with CBOR but deserializes CBOR-first with a JSON fallback — for in-flight messages from older deployments at the moment a deploy lands. This is the kind of forward/backward-compat plumbing that's invisible from outside but represents weeks of careful design.

10. **Hooks are auto-disposed by the World on terminal-state events.** `interfaces.ts:128-131`: *"Hooks are automatically disposed by the World implementation when a workflow reaches a terminal state (run_completed, run_failed, run_cancelled). This releases hook tokens for reuse by future workflows."* The runtime does *not* explicitly dispose hooks. Worlds must implement this in the `events.create('run_*')` codepath. A community world that forgets this leaks hook tokens.

Bonus: **`world.start()` is also where `pgboss → graphile` migration lives** (`world-postgres/src/queue.ts:285-330`). World start is conventionally "spin up workers" but WDK's pattern says it's also "run schema/data migrations". A community world has to handle its own migration story inside `start()`.

Bonus 2: **Hook conflict is a server-only event.** `events.ts:177-189` — Worlds *generate* `hook_conflict` events when a `hook_created` request hits an existing token. Callers cannot create these. The runtime watches for them and rejects awaited promises with `HookTokenConflictError`. This is the in-band signaling mechanism for hook-token collision and only appears in the `AllEventsSchema`, not `CreateEventSchema`.

Bonus 3: **The `worlds-manifest.json` at the repo root is a discovery registry, not a tech contract.** It declares official + community worlds with `id`, `package`, `env` defaults, optional `services` (Docker images for local stack-up), `setup` script paths, `requiresDeployment`, `requiresCredentials`, and `features` (only `"encryption"` is currently used). This is consumed by the CLI's `workflow init` (or similar) flow and surfaces as a "pick your world" wizard. It is the closest thing WDK has to a Thodare-style "select your engine at deploy" UX.

---

## 8. Implications for Thodare

Thodare's bet — "JSON+EditOp surface that LLMs can build" on top of a swappable durable substrate — has a different center of gravity than WDK. WDK bets on **JS source code as the workflow definition**, with SWC-driven directives, deterministic VM replay, and event-sourced storage. The "World" is the substrate adapter pattern; everything else is the JS-first DX.

### 8.1 Patterns to copy verbatim

- **Composition over single big interface.** `World extends Queue, Streamer, Storage` (`interfaces.ts:240`). Three orthogonal capability sets, optionally combined. Each can be implemented by a different substrate or wrapped with instrumentation independently. Thodare's "engine" port should split similarly: at minimum a `Storage` (event log + materialized views), a `Scheduler` (analog of `Queue`), and a `Streamer` if Thodare wants live tailing for the LLM-readback story.

- **Append-only event log + materialized views.** The `events.create` is the *only* mutation surface. Run/Step/Hook entities are read-only views. This is what makes replay possible, makes resilient-start possible, makes hooks auto-disposable on terminal state, and makes audit + observability essentially free. WDK is more than a workflow engine in this respect — it's a tightly designed event-sourcing system whose surface happens to look like a workflow API. For Thodare's "LLMs read back what ran" story, the event log is the right primitive — the LLM-readable shape can be derived from events without ever exposing direct entity mutation.

- **Branded spec versions + cascade resolution.** `SpecVersion` branded type forces import-of-constant. The `opts.specVersion ?? world.specVersion ?? SAFE_BASELINE` cascade lets newer SDKs use newer features automatically while remaining forward/backward-compatible. The `requiresNewerWorld()` guard at the world boundary is how WDK rejects runs from too-new SDKs. Thodare should bake this in from day one — it costs almost nothing now and is enormously expensive to retrofit.

- **Conformance test suite as a published package.** `@workflow/world-testing` exports `createTestSuite(pkgName)` which exercises addition, idempotency, hooks, null-byte, and error semantics. A community world is "valid" iff it passes this suite. Thodare should ship this *first*, before building the second engine. It anchors the contract in executable form rather than prose. It also doubles as living documentation.

- **Resilient start as a first-class pattern.** `Promise.allSettled([events.create, queue.send])` with retryable-error classification is the right shape for any system where the storage and scheduler can fail independently. `RunStartedEventSchema` carrying optional `runInput` for the case where the storage call lost is a clean way to encode it without forking the schema.

- **`createQueueHandler` returns an HTTP handler.** Even if Thodare doesn't go full HTTP-fanout, the pattern of "the engine adapter returns something the framework mounts" decouples the engine from the framework. This is the seam that lets WDK integrate with Next, Nuxt, Astro, SvelteKit, Hono, Nitro, Nest with sub-100-line adapters.

- **Encryption as opt-in via `?.()` on an optional method.** `world.getEncryptionKeyForRun?.(runId, context)` plus `if (rawKey) importKey(rawKey)`. Zero ceremony, zero coupling to the runtime, plug a KMS in when ready. The two overloads (run-entity vs runId+context) gracefully handle the chicken-and-egg of "we need the key to write the run, but the run doesn't exist yet at start time".

- **`Symbol.for(...)` registries for cross-realm globals.** Whatever Thodare's equivalent of "the LLM-emitted workflow body runs in some sandbox" turns out to be, the registry pattern is the right way to plumb step IDs across realms without binding emitted code to a specific package.

### 8.2 Patterns to deliberately diverge from

- **Don't make the workflow definition a JS source-level construct.** This is WDK's whole bet and Thodare's whole anti-bet. WDK's directive system requires a Rust SWC plugin, separate workflow + step bundles, a `vm.Context` for replay, custom serde for class-in-the-event-log support, and a build pipeline that produces two bundles and a manifest comment per file. The complexity is enormous and is the price of "let users write plain async functions". Thodare's JSON+EditOp surface skips all of this. Don't be tempted to add "well, also we support `'use workflow'` directives" — the moment you do, you owe the user the SWC plugin, the deterministic VM, and the dual-bundle build, all of which are fundamentally incompatible with "LLMs build, edit, run, read back".

- **Don't hardcode HTTP fanout as the only dispatch model.** The decision that "the queue substrate POSTs to a well-known URL" works for serverless, works for graphile-worker (which embeds a fetch loop), and works for in-process. It does not work cleanly for substrates that are pull-only (SQS, Kafka, Redis Streams, NATS JetStream) without an embedded HTTP server. Thodare's port should support both push (queue → handler invocation) and pull (handler → queue.next()) modes, or pick one and own the consequences. A pull-only port can wrap a push substrate but a push-only port cannot wrap a pull substrate.

- **Don't conflate "in-process dispatch" with "durable substrate".** WDK's `world-postgres` instantiating `world-local` for the in-process HTTP fetch is clever but unprincipled — it ties Postgres mode to the existence of a localhost HTTP server, which is fine on a long-lived process but awkward in serverless or multi-replica setups. Thodare should split these explicitly: an `Engine` (durability) and a `Dispatcher` (in-process or HTTP or RPC). They compose, but they're separate ports.

- **Don't model storage as four separate namespaces hidden behind `events.create`.** WDK does `Storage.runs.list/get`, `Storage.steps.list/get`, `Storage.events.{create,get,list,listByCorrelationId}`, `Storage.hooks.{get,getByToken,list}`. The asymmetry — *only* events have `create` — is consistent with event sourcing but is also four indices a substrate must maintain. For Thodare's LLM-edit story, an `EditOp` is itself the natural mutation surface; the analog of `events.create` is `applyOp(workflowId, op)`. Don't replicate WDK's four namespaces unless Thodare really has runs, steps, hooks, events as distinct first-class entities exposed to users.

- **Don't ship a `vm.Context` workflow runtime if you don't have to.** It's the right call for WDK's "your async function is the workflow" model, but for Thodare's "the workflow is JSON" model, the runtime is just a JSON interpreter that calls user-registered handlers. No VM, no determinism via seeded RNG, no `Date.now()` patching. That simplicity is a moat against WDK and Inngest.

### 8.3 Be wary of

- **Spec version surface area grows fast.** WDK is at v3 in beta and already has a "legacy v1 → v2 → v3" migration story baked into every entity schema (look at the `*_json` parallel columns in `world-postgres/src/drizzle/schema.ts` marked `@deprecated`). Thodare will face the same problem the moment the wire format changes. Pre-decide: is the storage engine free to migrate data lazily (read-on-old-format, write-on-new-format) or eagerly? WDK chose lazy — the cost is parallel columns forever and a `v1Compat` flag threaded through the codebase (`events.ts:362`, `runs.ts:92-95`, etc.).

- **The `getUrl()` gap.** WDK has TODOs in two places (`workflow.ts:203`, `step-handler.ts:516`) acknowledging that "where am I served from" is not on the World interface. Thodare can avoid this by adding it on day one: `engine.getPublicUrl(): URL` or accepting it as construction config.

- **The "hook tokens auto-dispose on terminal state" invariant is implicit.** It's only in a doc-comment (`interfaces.ts:128-131`). A community world that forgets it leaks. Thodare should make the cleanup either happen in shared code (like `recovery.ts`) or be enforced by the conformance suite.

- **The serialization story leaks.** Devalue produces opaque `Uint8Array` bytes. Storage must be `bytea`/`blob` capable. Cosmos DB, DynamoDB, Firestore can store bytes but with awkward limits (DynamoDB 400KB per item). The `EVENT_DATA_REF_FIELDS` map in `events.ts:10-20` exists because WDK assumes large payloads will be stored externally and referenced by ID — there's no in-tree implementation of that ref scheme but the runtime relies on it (see `world-vercel/src/refs.ts`). Thodare's storage should plan for "blobs stored elsewhere, IDs in the event log" from the start.

- **Postgres-world's per-run in-process serialization (`inflightWorkflowRuns`)** is a single-process concurrency guard. In a multi-replica deploy, two replicas can still race on the same run's event log. The recovery mechanism (event-log idempotency on replay) papers over this, but every replay does serialization/deserialization work twice. Thodare needs to decide whether to enforce per-run serialization at the storage layer (advisory locks, conditional writes) or accept the duplicate work.

### 8.4 Strategic read on "wrap WDK as one of many Worlds"

Mostly correct. WDK's `World` interface is a real port with three official implementations and an active community-worlds ecosystem (Turso, MongoDB, Redis, Jazz documented in `worlds-manifest.json`). The conformance suite is published. The tooling (build pipeline, observability UI, framework integrations) is independent of the world choice. Standing up a "Thodare-as-a-World" or "WDK-as-an-Engine" mapping is technically tractable.

But the directional asymmetry is real. WDK's *workflows* are JS code with directives; *Thodare's* workflows are JSON. To wrap WDK-as-an-engine, Thodare would have to compile its JSON workflow definition into a `.js` file with `'use workflow'` and then run the SWC plugin and deploy two bundles. That is technically possible but loses Thodare's editing story (the LLM cannot edit the compiled JS). To wrap Thodare-as-a-World for WDK, Thodare's storage would have to satisfy WDK's exact event-sourcing schema with devalue Uint8Array payloads — feasible, mostly a translation layer.

The most natural pairing is: **WDK is one engine choice for Thodare**, where Thodare's runtime layer compiles a JSON workflow into a JS workflow file at deploy time, and uses WDK's build pipeline and worlds. The cost is owning the JSON→JS compiler. The benefit is inheriting WDK's framework integrations, observability UI, and worlds ecosystem. The risk is that WDK's `vm.Context` runtime makes it Node-bound forever; if Thodare wants to deploy to Cloudflare Workers / Bun / Deno-on-edge, WDK is not the engine.

The cleaner mapping is: Thodare ports the *World abstraction itself* — adopts the three-way Storage/Queue/Streamer split, the event-sourcing model, the resilient-start pattern, the spec-version branding, the conformance suite — but does not adopt the JS-source-code workflow definition. That gives Thodare engine portability (PG, SQLite, CF, Lambda, etc.) without paying the SWC/VM tax. WDK becomes a peer architecture to learn from rather than a runtime to embed.

---

### Verbatim type/interface inventory cited in this review

- `World` interface — `packages/world/src/interfaces.ts:240-307`
- `Storage` interface — `packages/world/src/interfaces.ts:133-235`
- `Streamer` interface — `packages/world/src/interfaces.ts:32-116`
- `Queue` interface — `packages/world/src/queue.ts:88-120`
- `EventResult` interface — `packages/world/src/events.ts:374-391`
- `WorkflowRunSchema` (discriminated union) — `packages/world/src/runs.ts:65-94`
- `EventTypeSchema` (canonical event taxonomy) — `packages/world/src/events.ts:56-77`
- `CreateEventSchema` (user-creatable subset) — `packages/world/src/events.ts:277-297`
- `AllEventsSchema` (read subset including hook_conflict) — `packages/world/src/events.ts:301-322`
- `WorkflowInvokePayloadSchema` / `StepInvokePayloadSchema` — `packages/world/src/queue.ts:39-56`
- `RunInputSchema` (resilient-start payload) — `packages/world/src/queue.ts:30-37`
- `SerializedDataSchema` — `packages/world/src/serialization.ts:29-32`
- `StepCompletedEventSchema` — `packages/world/src/events.ts:95-101`
- `RunStartedEventSchema` — `packages/world/src/events.ts:232-242`
- `HookConflictEventSchema` — `packages/world/src/events.ts:184-190`
- `SPEC_VERSION_*` constants — `packages/world/src/spec-version.ts:22-29`

### Files most worth re-reading in full

- `packages/world/src/interfaces.ts` (308 lines, every comment counts)
- `packages/world/src/events.ts` (407 lines)
- `packages/swc-plugin-workflow/spec.md` (1169 lines, the most detailed compiler spec in the codebase)
- `packages/core/src/runtime/start.ts` (~337 lines)
- `packages/core/src/vm/index.ts` (123 lines, the deterministic sandbox)
- `packages/core/src/workflow.ts` (776 lines, the orchestrator that wires it all together)
- `packages/world-postgres/src/queue.ts` (533 lines, the most surprising World implementation)
- `packages/world-vercel/src/encryption.ts` (220 lines, the only encryption-implemented world)
- `packages/world-vercel/src/queue.ts` (312 lines, CBOR transport + DualTransport)
- `packages/world-vercel/src/streamer.ts` (419 lines, the WFCT control frame)
