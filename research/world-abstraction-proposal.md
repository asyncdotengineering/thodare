# Thodare World Abstraction — Proposal v2

> **Status:** research-grade proposal. Author: Claude (this session). Audience: Mithushan + the next session that opens an RFC at `rfcs/world-abstraction/`. Scope: architectural, not implementation.
>
> **v2 changes from v1.** Folds in 7 deep code reviews (~46k words) of `vercel/workflow`, `vercel/workflow-examples`, `vercel-labs/workflow-builder-template`, `cloudflare/dynamic-workflows`, `withastro/flue`, `rivet-gg/rivet`, plus n8n/ActivePieces/Sim Studio. v1 stays at `world-abstraction-proposal.v1.md` for diffability.

**One-line summary.** **Port the World abstraction itself** (three-port composition, append-only event log + materialized views, conformance suite, branded spec versions) — not as a wrapper for any single existing engine, but as Thodare's own substrate contract. Ship 5 first-party adapters that cover serverless / managed / self-host / dev. Add a first-class **Credential** primitive in v0.2 so the headless-substrate goal is real. Adopt Flue's three-verb CLI + no-`deploy` discipline. Fix the SPEC.md EditOp documentation drift. The JSON+EditOp surface stays untouched.

---

## 0. Vision (sharpened from v1)

Thodare is a **self-hostable, open-source, headless workflow orchestration engine** for durable workflows + background tasks + deferred jobs. The bet is the **JSON+EditOp surface that LLMs can build, edit, run, and read back** ([SPEC §2](../SPEC.md#2-the-bets)) — not the durable runtime underneath.

**Two consumers, one substrate** is the v2 framing:

1. **The LLM** patches workflow JSON via `EditOp[]` (skip-don't-reject) and reads back run output.
2. **The developer building a visual workflow product** (an n8n-class / ActivePieces-class / Sim-Studio-class application) consumes Thodare's HTTP API as the durable backend behind their own UI, their own brand, their own connector library.

Both consumers depend on the same substrate. The **World abstraction** makes the substrate pluggable so the same workflow JSON + the same EditOp surface runs against:

- **Postgres self-host** (the current openworkflow path; default for v0.2)
- **SQLite** for `thodare dev` / single-binary local
- **Cloudflare Workflows + dynamic-workflows** for serverless-managed
- **Vercel WDK** (lifts WDK's 7 official + community Worlds via one adapter)
- **Inngest** for users already on Inngest
- *(later)* **Rivet's `@rivetkit/workflow-engine`** — adapter is more tractable than v1 implied

The competitive frame is not "we built a better Temporal." It's: **the LLM-native, headless durable backend that runs on whatever substrate you trust** — and the right substrate for developers building durable-workflow products.

---

## 1. Why now — the architectural moment

This is the load-bearing observation that justifies the timing. Reinforced by deep reads of the source.

> **Three independent codebases — Thodare's T5 (locked Dec 2025), Cloudflare's `dynamic-workflows@0.1.1` (shipped 2026-05-01), Rivet's `@rivetkit/workflow-engine@2.3.0-rc.4` — converged on the same architectural pattern: one registered orchestrator + per-instance isolated KV + external dispatcher metadata that routes back to per-tenant logic.**

| Thodare T5 | CF `dynamic-workflows` (verified by `binding.ts:259-274`, `entrypoint.ts:55-80`) | Rivet `workflow-engine` (verified by `architecture.md:14-56`) |
|---|---|---|
| ONE registered openworkflow workflow (`wfkit-runtime`) | ONE registered `WorkflowEntrypoint` (the dispatcher) | ONE engine instance per workflow, KV-isolated by host |
| Workflow JSON pinned in run input (T4) | Routing metadata stashed via `wrapWorkflowBinding({ tenantId })` | `EngineDriver` operates in an isolated namespace; host provides isolation |
| Runtime walker reads JSON, dispatches blocks | `dispatchWorkflow` reads metadata, calls `loadRunner`, delegates `run(event, step)` | Dispatcher loads the workflow function for the namespace |
| Generic dispatcher serves every workflow | Generic dispatcher serves every tenant | Generic engine serves every workflow instance |

The convergence is not coincidence. It's the natural shape of "durable workflow execution at multi-tenant scale where workflows are dynamic." The CF library is **300 LoC, MIT, and shipped one day before this proposal** — a free architectural validation Thodare gets to absorb without writing a line.

**Material implication:** the World contract Thodare adopts should be aligned with this pattern, because every adapter Thodare ships will use it (including the openworkflow adapter, which already does).

---

## 2. What's wrong with the current state — sharpened

Five concrete problems with hardcoded `@thodare/openworkflow`. Three were in v1; two are new from the deep reviews.

### 2.1 The runtime story is "Postgres + worker, full stop" *(v1)*

Existing serverless users (Vercel / Cloudflare / Lambda) cannot adopt Thodare without spinning up a Postgres + a long-lived worker pod. Wrong shape; they leave.

### 2.2 The DX story leaks the substrate *(v1)*

`createWfkit({ backend })` requires `BackendPostgres.connect(...)` or `BackendSqlite.open(...)`. Substrate is a deploy-time concern, not an SDK call.

### 2.3 We can't credibly recommend Thodare to users with an existing engine *(v1)*

A user on Inngest, Trigger, Vercel WDK, or Rivet already has the durability layer. Forcing them to add Postgres + openworkflow alongside is a tax. The right pitch is "Thodare runs on top of what you have."

### 2.4 The connector primitive cannot host n8n / ActivePieces / Sim-Studio-style applications *(NEW from visual-builder review)*

Per `code-reviews/visual-builder-substrates.md` the gaps are concrete and prioritized:

| Gap | Severity | Affects |
|---|---|---|
| **No first-class `Credential` model** | **P0** | All three target projects ship one. Without it, headless-builder developers must inline secrets as `hidden()` params and shove them through `ToolContext.env` — which doesn't satisfy multi-org credential vault, OAuth flows, or per-tool scope declarations. |
| **No output `hiddenFromDisplay` flag** | **P0** | Sim has it. A `getCredentials` block whose output you plumb forward but the LLM should never reason about needs this. |
| **No `paramVisibility: 'llm-only'`** | **P0** | Sim has 4 visibility brands; Thodare has 3. Computed values the LLM must fill but the user can't see in the form. |
| **No container blocks / nesting / subflow ops** | **P1** | No for-each, no while, no parallel branches at the JSON level. AP `LOOP_ON_ITEMS` and Sim's `nestedNodes` cannot import. |
| **`SubBlock.condition` is equality-only** | **P1** | n8n has 12 condition operators (`gte`, `lte`, `between`, `regex`, `exists`, etc.); Sim has function-typed conditions; AP has `DynamicProperties`. Thodare has `{field, value, not?}`. IF-node-style filters degrade to `type: 'json'`. |
| **No dynamic schema endpoint** | **P1** | Slack channel pickers, Sheets sheet pickers, Airtable table pickers — bread and butter of every visual builder — need a server endpoint that takes form state + auth and returns sub-schema. AP solves with `DynamicProperties.props()`; Thodare has nothing. |
| **No `compute-edit-sequence` (diff → ops)** | **P1** | When a user drags a block on the canvas, the UI needs to emit a minimal `EditOp[]`. Sim ships this at `lib/workflows/training/compute-edit-sequence.ts`. Thodare can apply ops but can't synthesize them. |
| **`SubBlock` types: 5 vs Sim's 28+** | **P2** | `code`, `slider`, `combobox`, `multi-select`, `file-upload`, `oauth-connection-selector` etc. all missing. |

The full 15-item list is in `code-reviews/visual-builder-substrates.md:§4.5`. **The credentials gap is the headline; without it, Thodare is not a credible headless backend for any of the three target visual-builder shapes.**

### 2.5 `SPEC.md` documents the wrong EditOp set *(NEW — verifiable bug)*

- **Source truth (`packages/engine/src/types.ts:213-237`):** `add` / `edit` / `delete` / `connect` / `disconnect`
- **`SPEC.md:55` (wrong):** `add` / `update` / `remove` / `connect` / `disconnect`

This is documentation drift. Worse: v1 of this proposal carried the wrong names from SPEC.md. v2 uses the correct names throughout. **Action: SPEC.md needs a one-line correction in the same RFC that lands the World abstraction.**

Bonus EditOp finding: **Thodare has 5 ops; Sim Studio has 5 ops; only 3 of 5 are Thodare-original**. Sim's are `add` / `edit` / `delete` / `insert_into_subflow` / `extract_from_subflow` — Sim has no `connect`/`disconnect` at all (connections are embedded in `add.params.connections`). The "heavily inspired by Sim Studio" lineage diverged on subflow vs. edge ops. Thodare's flat-graph model is arguably better for the LLM-feedable surface; Sim's nesting model is required for container-blocks support (P1 above). Both can coexist — keep `connect`/`disconnect`, add `insert_into_subflow`/`extract_from_subflow` if/when container blocks ship.

---

## 3. The interface — Alternative B refined

Three alternatives were sketched in `_scratch-interface-design.md`. v1 recommended **Alternative B** (thin engine adapter wrap). The deep reviews refine that recommendation:

> **Port the World abstraction *itself* (the three-port composition + event-sourcing + conformance-suite pattern from WDK), but ship adapters that wrap existing engines for v0.2.** The interface SHAPE is WDK's; the implementation strategy still wraps engines so we inherit their runtime track records.

This is the WDK reviewer's verbatim recommendation: *"Thodare ports the World abstraction itself ... but does not adopt the JS-source-code workflow definition. That gives Thodare engine portability (PG, SQLite, CF, Lambda, etc.) without paying the SWC/VM tax."*

### 3.1 The `World` interface (informative — not a code change)

Mirrors WDK's three-port composition (`packages/world/src/interfaces.ts:240-307`), with adjustments for Thodare's JSON+EditOp surface:

```ts
interface ThodareWorld extends Storage, Queue, Streamer {
  readonly id: string;                // "openworkflow-pg" | "wdk" | "cloudflare-dynamic" | ...
  readonly capabilities: WorldCapabilities;
  readonly specVersion?: SpecVersion; // branded — see §3.4

  // Lifecycle
  start?(): Promise<void>;
  close?(): Promise<void>;

  // Workflow-orchestration verbs (these are Thodare-specific, not in WDK)
  defineWorkflow(spec: WorkflowSpec, handler: ThodareHandler): Promise<RegisteredWorkflow>;
  runWorkflow(name: string, input: unknown, opts?: RunOpts): Promise<RunHandle>;
  signal(runId: string, signalName: string, payload?: unknown): Promise<void>;
  cancel(runId: string): Promise<void>;
  resumeFromStep(runId: string, stepId: string): Promise<RunHandle>;  // Rivet's replayWorkflowFromStep
  recover(runId: string): Promise<RunHandle>;                          // Rivet's recover()

  // Optional: encryption hook (lifted from WDK pattern — opt-in via `?.()`)
  getEncryptionKeyForRun?(runId: string, ctx?: Record<string, unknown>): Promise<Uint8Array | undefined>;
  getDeploymentId?(): Promise<string>;
  resolveLatestDeploymentId?(): Promise<string>;
}

// Storage — append-only event log + materialized views (WDK's load-bearing insight)
interface Storage {
  events: { create, get, list, listByCorrelationId };  // ONLY mutation surface
  runs:   { get, list };                               // read-only views
  steps:  { get, list };                               // read-only views
  hooks:  { get, getByToken, list };                   // read-only views
  // Note: no runs.update / steps.update / hooks.create
  // All state changes flow through events.create()
}

// Queue — push OR pull, the World declares which
interface Queue {
  mode: "push" | "pull" | "embedded";  // see §3.3 — divergence from WDK
  queue(name: ValidQueueName, payload: QueuePayload, opts?: QueueOptions): Promise<{ messageId: MessageId | null }>;
  createQueueHandler(prefix, handler): (req: Request) => Promise<Response>;  // for "push" mode
  next?(prefix: QueuePrefix): Promise<QueueDelivery | null>;                  // for "pull" mode
  getDeploymentId(): Promise<string>;
}

// Streamer — same as WDK (lifted verbatim)
interface Streamer {
  streamFlushIntervalMs?: number;
  streams: { write, writeMulti?, close, get, list, getChunks, getInfo };
}

// What the orchestrator function receives
type ThodareHandler = (ctx: ThodareCtx) => Promise<unknown>;

interface ThodareCtx {
  input: unknown;
  step: ThodareStep;
  runId: string;
  signal: AbortSignal;        // canceled when world.cancel(runId) is called
  log: ThodareLogger;
}

// The step shim — every adapter implements these (mirrors WDK + Rivet shape)
interface ThodareStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;     // memoized, idempotent on replay
  sleep(name: string, duration: string | number | Date): Promise<void>;  // accept Date — birthday-card pattern
  waitForSignal<T>(opts: { name: string; signalName: string; timeoutMs?: number }): Promise<T>;
  // Stream output back (lifted from WDK `getWritable` + `x-workflow-stream-tail-index`)
  getWriter<T>(channel?: string): WritableStreamDefaultWriter<T>;
}

// Capability flags — adapter declares what's true
interface WorldCapabilities {
  // Runtime
  maxStepDurationMs: number;            // 15min Lambda, 30s Workers, ∞ self-host
  maxRunDurationMs: number;             // ∞ for most managed
  signalPrecision: "exact" | "best-effort";
  exactlyOnceSteps: boolean;            // true for openworkflow + WDK; false for some queues
  serverless: boolean;
  pricingModel: "self-host" | "per-invocation" | "per-second" | "managed-flat";
  maxStepOutputBytes?: number;          // CF Workflows = 1 MiB
  maxPersistedStateBytes?: number;      // CF Workflows = 1 GB/run

  // Headless-builder support (NEW — for visual-UI consumers)
  supportsLiveSubscription: boolean;        // SSE / WS for "step 3 of 5 running"
  supportsStepIOInspection: boolean;        // Storage.steps.list returns IO per step
  supportsResumeFromStep: boolean;          // resumeFromStep() implemented
  supportsRecover: boolean;                 // recover() implemented
  liveSubscriptionLatencyMs: number;        // floor on per-step event delivery

  // Op semantics
  supportsRemovedTombstone: boolean;        // Rivet's `removed` entry kind for graph migration
}
```

**Total surface: 8 World methods + 4 Step methods + ~17 capability flags.** Each capability flag explicitly documents an axis where adapters differ — no hidden behavior.

### 3.2 What's lifted from WDK verbatim, what diverges

**Lifted verbatim:**

| WDK pattern | Source | Why |
|---|---|---|
| `World extends Queue, Streamer, Storage` composition | `interfaces.ts:240` | Three orthogonal capability sets, each can be wrapped/instrumented separately. The right level of granularity. |
| Append-only event log + read-only materialized views | `interfaces.ts:118-132` | Makes replay possible; makes resilient-start possible; makes hooks auto-disposable on terminal state; makes audit + observability free. |
| `events.create()` is the ONLY mutation surface | `interfaces.ts:187-228` | Forces every state change through one chokepoint; testable, auditable, encryptable. |
| Branded `SpecVersion` type with cascade resolution | `spec-version.ts:22-29`, `start.ts:180-183` | Forward/backward compat without per-field-flag guards. |
| `EventResult.events?: Event[]` TTFB optimization | `events.ts:374-391` | Server pre-pays the first `list` call when responding to `run_started`. |
| `recovery.ts:reenqueueActiveRuns()` as a shared function | `recovery.ts:14-49` | Idempotent crash recovery; Worlds call from `start()`. |
| Encryption opt-in via `?.()` on optional method | `interfaces.ts:280-307`, `start.ts:193-197` | Zero ceremony, zero coupling, plug a KMS in later. Per-run keys via HKDF. |
| `Symbol.for()` cross-realm registries | `spec.md:103-119` | Cross-bundle steps register without depending on `@workflow/core`. |
| `MessageId` as branded type | `queue.ts:12-15` | Callers cannot fabricate. |
| Resilient-start path: `Promise.allSettled([events.create, queue.send])` | `start.ts:219-256` | If `events.create` fails with 429/5xx, queue carries `runInput` and server materializes on `run_started`. |
| Conformance test suite as a published package | `world-testing/createTestSuite(pkgName)` | Community Worlds prove validity by passing; living documentation. |

**Deliberately diverging from WDK:**

1. **JSON+EditOp surface, not directives.** WDK is JS-source-as-workflow-definition with SWC plugin + `vm.Context` deterministic replay. Thodare's bet is JSON. **Don't be tempted to add `'use workflow'` directives** — the moment you do, you owe the user the SWC plugin, dual bundles, vm sandbox, and the loop closes around the LLM-feedable surface. (`world-wdk` adapter exists *precisely* so users who want directives can have them — without polluting Thodare's own surface.)
2. **Push OR pull queue mode** (per `World.Queue.mode`). WDK's `createQueueHandler` returns an HTTP handler — push-only. That doesn't fit pull-only substrates (SQS, Kafka, NATS JetStream, Redis Streams). Thodare adds `next?(prefix)` so pull-only adapters work without an embedded HTTP server.
3. **First-class `Credential` artifact** (lifted from n8n / ActivePieces, not WDK). See §3.5.
4. **`removed` entry kind** (lifted from Rivet, not WDK). See §3.6.
5. **`resumeFromStep` and `recover` as first-class World methods** (lifted from Rivet's `replayWorkflowFromStep` + `recover`, not WDK). Required for headless-builder UIs (P1 in §2.4).
6. **`getWriter(channel?)` — named multi-channel writables.** WDK's `getWritable<T>()` is single-channel per run. Workflow-builder review confirmed that flight-booking-app already hacks an `envelope` field to multiplex — single channel leaks. Thodare's writers are per-channel from day one.
7. **`step.sleep` accepts `Date`** (kitchen-sink confirms WDK supports this; Thodare should too). Birthday-card / scheduled-send patterns. Also support `step.sleepUntil(name, ts)` for clarity.
8. **Don't hardcode in-process HTTP fanout in the way WDK's `world-postgres` reuses `world-local`.** Clever but unprincipled — couples Postgres mode to localhost HTTP loopback, awkward in serverless or multi-replica. Thodare splits Engine (durability) from Dispatcher (in-process / HTTP / RPC) explicitly.

### 3.3 Push vs. pull — the divergence that matters

WDK's queue is push-only (`createQueueHandler` returns `(req: Request) => Promise<Response>`). The substrate POSTs messages to the well-known route. This works for serverless (Vercel queue → function invoke), graphile-worker (embeds fetch loop), and in-process. **It does not work cleanly for substrates that are pull-only** (SQS, Kafka, Redis Streams, NATS JetStream) without an embedded HTTP server inside the World.

Thodare's `Queue.mode` declaration:

- `"push"` — adapter exposes `createQueueHandler(prefix, handler)` returning a Web `(req: Request) => Promise<Response>`. Mounted by the framework integration. WDK pattern.
- `"pull"` — adapter exposes `next(prefix)` returning the next message (or `null` after timeout). The runtime drives a fetch loop. SQS / Kafka / NATS pattern.
- `"embedded"` — adapter dispatches in-process; no HTTP loopback. World-local pattern + the `LocalWorld.registerHandler()` shape.

A capability flag (`queue.mode`) lets the runtime pick the right driver. The contract test suite has separate test packs per mode.

### 3.4 Spec versions, branded — lift verbatim from WDK

```ts
export type SpecVersion = number & { readonly [SpecVersionBrand]: typeof SpecVersionBrand };
export const SPEC_VERSION_LEGACY                    = 1 as SpecVersion;
export const SPEC_VERSION_SUPPORTS_EVENT_SOURCING   = 2 as SpecVersion;
export const SPEC_VERSION_SUPPORTS_CREDENTIALS      = 3 as SpecVersion;  // Thodare's first
export const SPEC_VERSION_CURRENT                   = SPEC_VERSION_SUPPORTS_CREDENTIALS as SpecVersion;
```

Cascade: `opts.specVersion ?? world.specVersion ?? SPEC_VERSION_SUPPORTS_EVENT_SOURCING`. Brand forces import-of-constant. Helpers `isLegacySpecVersion(v)` and `requiresNewerWorld(v)`. Costs nothing now; expensive to retrofit later.

### 3.5 First-class `Credential` artifact — the visual-builder substrate

This is the largest functional addition v2 makes vs. v1.

```ts
interface Credential {
  id: string;                                     // user-visible id (e.g., "slack-prod")
  type: CredentialType;                           // "oauth2" | "api-key" | "basic" | "bot-token" | "custom"
  organizationId: string;                          // multi-tenant scoping (T11)
  displayName: string;                             // for UI rendering
  properties: SubBlock[];                          // entry form schema
  authenticate?: AuthenticateConfig;               // declarative request signing (n8n pattern)
  test?: TestConfig;                               // declarative ping (n8n pattern)
  scopes?: string[];                               // OAuth scope declaration
  encryptedAt: Date;
  // The actual secret bytes are AES-256-GCM-encrypted at rest; never returned by the API
}

interface ToolCredentialBinding {
  required: boolean;
  type: CredentialType | string;                   // e.g. "oauth2:slack" | "custom:my-vendor"
  requiredScopes?: string[];
  showInForm?: boolean;                            // false = hide entirely from UI; true = show "Connect Slack" button
}

// Tools opt in:
defineConnector({
  // ...
  credential: { required: true, type: "oauth2:slack", requiredScopes: ["chat:write"] },
  // execute() receives ctx.credential.accessToken etc. — the Tool never sees the encrypted blob
});
```

**Storage:** `workflow.credentials` table — `id`, `organization_id`, `type`, `properties` (jsonb), `encrypted_secret` (bytea, AES-256-GCM with per-org key from KMS or env), `created_at`, `last_used_at`. Multi-tenant per T11.

**API endpoints:**
- `GET /api/credentials?type=oauth2:slack` — list connections for the active org.
- `POST /api/credentials` — create (with secret in request body, encrypted at rest).
- `POST /api/credentials/:id/test` — invoke the credential's `test` config; return live validity.
- `DELETE /api/credentials/:id` — soft delete (`deleted_at`).

**Workflow JSON references credentials by id only:**
```json
{
  "id": "slack-1",
  "type": "slack",
  "params": {
    "channel": "#alerts",
    "credentialId": "slack-prod"
  }
}
```
The `credentialId` is the only way the LLM can reference a credential. The actual secret never reaches the LLM, never appears in workflow JSON, never logs.

This pattern matches **n8n's `ICredentialType.authenticate` declarative signing** (`packages/nodes-base/credentials/SlackApi.credentials.ts`) and **ActivePieces' `PieceAuth.OAuth2 / SecretText / BasicAuth / CustomAuth`** (`packages/pieces/framework/src/lib/property/authentication/index.ts:10-74`). It does **not** match Vercel WDK (which has no credential model) — `world-wdk` adapter handles credentials at the Thodare layer and injects them into WDK steps via the same `ctx.credential` shim.

**This is the P0 unblock for the headless-substrate goal.** Without it, no n8n-class / AP-class / Sim-class application can be built on Thodare without reinventing this. Ship in v0.2 alongside the World abstraction, NOT deferred.

### 3.6 The `removed` entry kind — Rivet's gift

Rivet's `src/context.ts:2535-2585` implements the `removed` entry: when an EditOp deletes a block from a workflow, in-flight runs that snapshotted the original JSON keep working (Thodare T4 already guarantees this), but if a run **resumes against an evolved workflow definition** (e.g., after a deploy), the engine accepts a tombstone in place of the missing block.

Adopt verbatim:

```ts
interface SerializedBlock {
  // ... existing fields ...
  tombstone?: true;            // marks a removed block in a deployed workflow JSON
  tombstoneOriginalType?: string;  // for replay diagnostics
}

interface SerializedWorkflow {
  // ... existing fields ...
  blocks: SerializedBlock[];   // may contain tombstones
}
```

When the runtime walker encounters a tombstone during replay, it advances past it without dispatching to a tool. Replays for in-flight runs that snapshotted the *original* JSON (T4) never see tombstones; replays for runs that resumed against an evolved workflow do. This solves the "we deleted a block but a run is mid-flight" problem cleanly, without leaking implementation details to the LLM.

### 3.7 Conformance test suite — `@thodare/world-contract-tests`

Lift WDK's `@workflow/world-testing` shape verbatim (`createTestSuite(pkgName)`). Every adapter passes the same suite, parameterized over the adapter under test. Test packs:

**Core (every adapter):**
1. **Happy-path** — define → run → step → result → assert output.
2. **Replay determinism** — crash mid-run, restart, assert no duplicate side effects.
3. **Sleep precision** — `step.sleep("60s")` resumes within `[60s, 60s + signalPrecision-allowed slack]`.
4. **Signal delivery** — `world.signal(runId, name, payload)` resumes a `step.waitForSignal` within slack.
5. **Cancellation** — `world.cancel(runId)` causes `ctx.signal.aborted === true` in the orchestrator.
6. **Multi-tenant isolation (T11)** — runs from different `organizationId`s never cross.
7. **Idempotency** — same `idempotencyKey` returns the same `runId`.
8. **Capability honesty** — assertions gated by adapter's declared capabilities (skipped if `capabilities.supportsStreams === false`).
9. **Tombstone replay** — workflow with a removed block, in-flight run keeps T4 JSON; new run uses tombstone.
10. **`rawConfig` round-trip** — block with `rawConfig` extension reaches `execute()` with merged config; raw fields never leak into `params` Zod schema validation.

**Headless-builder pack (gated by `supportsLiveSubscription` etc.):**
11. **Live subscription** — subscribe to run events; receive `step_started` / `step_completed` / `step_failed` for every step in order, within `liveSubscriptionLatencyMs` slack.
12. **Step IO inspection** — list steps for a run; assert each has input + output + duration + status.
13. **Resume from step** — `world.resumeFromStep(runId, stepId)` → prior steps NOT re-executed; resumed step receives the original input.
14. **Recover from failed** — `world.recover(runId)` flips terminal-failed run to pending, retries; succeeds.
15. **Connector metadata richness** — `GET /api/connectors/:type` returns enough metadata for an n8n-style node panel (label, description, type, options, conditional visibility).
16. **Credential round-trip** — create credential, reference by id in workflow JSON, run; assert tool received `ctx.credential` and the secret never appeared in logs / events / API responses.
17. **NDJSON op-stream** — `POST /api/workflows/:id/operations?stream=ndjson` returns one JSON object per applied/skipped op as the batch processes.

**Mode-specific packs:**
18. **`Queue.mode === "push"`** — `createQueueHandler` returns a working HTTP handler.
19. **`Queue.mode === "pull"`** — `next(prefix)` returns messages in order; `null` after timeout.
20. **`Queue.mode === "embedded"`** — `registerHandler` works in-process without a fetch loopback.

Every adapter ships with a green report. Every PR runs them. This is the operational discipline that prevents "looks like it works on the demo, breaks on Black Friday."

### 3.8 The `rawConfig` escape hatch — every typed primitive has a passthrough

Per `code-reviews/kapso.md` §2 — *"every `WorkflowNode` carries an optional `rawConfig?: JsonObject` that gets shallow-merged on top of the compiler output. This is the same trick Thodare's EditOps would aim to be — a stable typed surface plus a typed-but-untyped passthrough so the SDK doesn't gate every server-side feature behind an SDK release."*

Lift verbatim. Every `SerializedBlock`, every `Credential`, every `EditOp` carries an optional `rawConfig?: JsonObject`. The runtime walker shallow-merges `rawConfig` on top of the typed `params` after Zod validation passes — the merged result is what reaches the connector's `execute()`.

```ts
interface SerializedBlock {
  id: string;
  type: string;
  name?: string;
  position?: { x: number; y: number };
  enabled: boolean;
  params: Record<string, unknown>;
  rawConfig?: JsonObject;          // shallow-merged on top of params at run time; bypasses Zod
  tombstone?: true;                // §3.6
}
```

**Why this matters:** the LLM (or a UI) can emit fields the active SDK doesn't yet model — e.g., a brand-new connector parameter on the server side that's not in the published Zod schema. With `rawConfig`, the LLM's emit lands; without it, the LLM is blocked until the SDK ships a release.

**Validator behavior:** `applyOperations` validates `params` strictly (against the connector's Zod schema) and accepts `rawConfig` as opaque JSON. At run time, `rawConfig` overrides matching keys in `params`. Audit-log every `rawConfig` use so security review can catch credential-leak attempts.

**Adapter scope:** The escape hatch belongs at the wire format, not the World layer. Every World sees the merged result; the World does not need to know `rawConfig` exists.

### 3.9 Cross-workflow references — Encore's `X.named()` distinction

Per `code-reviews/encore-ts.md` §8 — Encore separates "this code owns this resource" from "this code consumes a resource owned elsewhere":

```ts
// In service A — declare ownership
export const userQueue = new Queue<UserEvent>("user-events", { ... });

// In service B — reference, don't redeclare
const queueRef = Queue.named<UserEvent>("user-events");
await queueRef.publish({ ... });
```

For Thodare, fan-out workflows that invoke other workflows want this:

```ts
// In one workflow file — declare
export const onboardingWorkflow = defineWorkflow("user-onboarding") /* ... */;

// In another — reference for invocation, not redefinition
const onboarding = Workflow.named<UserOnboardingInput>("user-onboarding");
await ctx.invokeWorkflow(onboarding, { userId });
```

The static analysis path (when Thodare's CLI grows one) recognizes both forms; `new Workflow(...)` registers ownership in the manifest, `Workflow.named(...)` produces a typed reference without claiming ownership. Permission grants follow ownership.

### 3.10 Wire-format guarantees — canonical JSON serialization

Per `code-reviews/kapso.md` §8a — Kapso's `kapso-workflows/src/json.ts` produces deterministic JSON so `kapso push` diffs are clean.

**Thodare's wire format (every API response, every workflow JSON, every EditOp batch result) is canonically serialized**:

- Object keys sorted lexicographically.
- Arrays preserve insertion order (already ordered by domain meaning — DAG topo, op sequence).
- Numbers normalized to JSON's canonical form (no trailing zeros, no `+`).
- Strings use minimal escaping.
- One trailing newline at end of body.

**Why it matters:** workflow JSON is git-tracked by users; LLM EditOps are replay-tested against expected outputs; visual-builder canvases diff against the server's serialization. Without canonical form, every consumer reinvents normalization (or accepts spurious diffs). With it, the wire format IS its serialized representation — testable, diffable, hashable.

**Implementation:** one `canonicalize()` helper at the API response boundary; all routes pass through it. Roughly 30 LoC + a vitest pack that asserts byte-equality across permutations.

---

## 4. The adapter roster v2

### 4.1 Ships in v0.2 (the headline release) — platform-native worlds

**Architectural principle (refined post-v2):** **one native World per platform, each composed of that platform's own primitives.** Not a wrapper around another framework's runtime. Same shape as Flue's "Deploy Anywhere" matrix — Cloudflare gets a Cloudflare-native World using CF Workflows / Queues / DO / D1 directly; Vercel gets a Vercel-native World using Vercel Postgres / Blob / Cron / Functions directly; etc. No transitive dependency on another framework's evolution; platform-native pricing, semantics, deploy tools, and debugging all surface to the user unchanged.

| Package | Platform | Composed from (the platform's own primitives) | LoC estimate |
|---|---|---|---|
| `@thodare/world-self-host-postgres` | **Self-host** (Node + Postgres) — default for v0.2 | Postgres + worker container; deployable to Fly / Railway / Render / VPS / on-prem | ~150 |
| `@thodare/world-self-host-sqlite` | **Single-binary local** for `thodare dev` and demos | SQLite + in-process worker | ~50 |
| `@thodare/world-cloudflare` | **Cloudflare-native** | CF Workflows + Queues + DO + D1 + R2. Uses `cloudflare/dynamic-workflows@^0.1.1` *internally* for tenant routing (implementation detail, not exposed). | **~150** |
| `@thodare/world-vercel` | **Vercel-native** | Vercel Postgres (Neon) + Vercel Blob + Vercel Cron + Vercel Functions. **No WDK dependency.** | ~250 |
| `@thodare/world-aws` | **AWS-native** | RDS Postgres + SQS + Lambda + S3. EventBridge for cron. Step Functions optional for orchestrator path. | ~400 |

**v0.2 ships five platform-native backends.** Each composes its host platform's own primitives directly. Plus the credential model lands in the same release. That is the value proposition.

> **What changed from earlier drafts.** Earlier drafts framed `world-wdk` as an "inheritance play — one adapter, seven inherited backends" by wrapping Vercel's WDK. That framing is wrong — it couples Thodare to WDK's evolution, ships unwanted Vercel-flavored deploy semantics on every WDK-derived backend, and leaks WDK's directive + SWC pipeline into deployments that have no use for either. **Each platform should be reached by its own primitives.** WDK still exists as an *opt-in* adapter (§4.6) for users who specifically want directive-style authoring, but it is not how Thodare reaches Vercel.

### 4.2 Ships in v0.3+ (validated by user demand)

| Package | When | Why deferred |
|---|---|---|
| `@thodare/world-netlify` | A Netlify user asks | Netlify DB + Blob + Background Functions; ~300 LoC. Same shape as `world-vercel`. |
| `@thodare/world-fly-machines` | A user wants always-on per-tenant compute | Fly Machines + per-tenant LiteFS; container-shaped, not serverless. |
| `@thodare/world-rivetkit-engine` | When a user champions it | **Tractable for v0.2 if there's a champion** (~400-600 LoC per Rivet review). No FoundationDB required (Rivet OSS = Postgres + NATS), no Rivet binary. Implements the 11-method `EngineDriver` over Thodare's Postgres. |
| `@thodare/world-inngest` | A user already on Inngest asks | Drops here from v0.2 — the platform-native principle says Inngest is not a *platform*, it's a *service*; users adopting Inngest get more value building on the underlying CF/Vercel/AWS native World. |
| `@thodare/world-temporal` | A Temporal shop asks | Temporal's worker model is the "we don't want this" reference; only build if a real customer pays. |
| `@thodare/world-native` | Probably never | The "Alternative A" trap. Build only if a clear gap emerges that nothing else fills. |
| `@thodare/supervisor` | When self-host docker users want process isolation | Tiny Rust binary that forks one Node/Bun process per workflow worker — independent restart, isolated memory. Lifted from Encore's `supervisor-encore` pattern (`code-reviews/encore-ts.md` §4: `supervisor/src/supervisor.rs:32-110`). Packaging concern; not architecture. |

### 4.3 `@thodare/world-cloudflare-dynamic` — substantially refined from v1

Per `code-reviews/dynamic-workflows.md` the adapter is **~150 LOC, not ~600**:

```
Dispatcher Worker (one Worker per Thodare deployment)
├── re-exports DynamicWorkflowBinding (REQUIRED — synchronous throw on boot if missed)
├── default fetch handler routes /api/* to Thodare's Hono app, /webhook/* to Cloudflare's webhook endpoint
└── exports Thodare's runtime walker as a single WorkflowEntrypoint (the dispatcher)
    └── on every step, dispatchWorkflow unwraps `{ orgId, workflowId, workflowVersion }`
    └── fetches workflow JSON from D1 by `(orgId, workflowId, workflowVersion)`
    └── walks the JSON, calling step.do / step.sleep / step.waitForEvent
```

**Step API mapping:**

| `ThodareStep` | CF Workflows |
|---|---|
| `step.run(name, fn)` | `step.do(name, opts?, fn)` |
| `step.sleep(name, "60s")` | `step.sleep(name, "60s")` |
| `step.sleep(name, dateObj)` | `step.sleepUntil(name, dateObj)` |
| `step.waitForSignal({ name, signalName, timeoutMs })` | `step.waitForEvent(name, signalName, { timeout })` |
| `step.getWriter(channel?)` | DO + WS for live tailing; degrade to polling if no DO |

**Capability flags:** `serverless: true`, `maxStepDurationMs: ~30s CPU / 30 min wall`, `signalPrecision: "exact"`, `exactlyOnceSteps: true`, `maxStepOutputBytes: 1_048_576`, `maxPersistedStateBytes: 1_073_741_824`, `pricingModel: "per-invocation"`, `supportsLiveSubscription: true` (via DO+WS), `supportsResumeFromStep: false` (CF Workflows requires re-create).

**Three CF-specific risks documented in adapter README:**

1. **Account-level Workflows quota = noisy neighbor.** All Thodare orgs in one CF account share the Workflows quota. Mitigations: (a) per-org CF account/sub-deployment for paying customers, (b) document the limit, (c) per-org rate-limit at the Thodare API layer.
2. **Plaintext metadata envelope.** `dynamic-workflows` envelope is unsigned and persisted in `event.payload`. Tenant code can read it back via `instance.status()`. The adapter's contract test (#15 above) asserts the envelope contains only `{ orgId, workflowId, workflowVersion }` — never any `hidden()` param, never any credential.
3. **Loader runs on every `run` call.** No internal cache; rely on Worker Loader's isolate cache. Adapter docs document this.

**Pricing reality:** at 10M runs/day × 5 steps each, the v1 estimate was ~$6.1k/mo (Option A). The dynamic-workflows pattern keeps us on Option A. Net cost vs. self-hosted Postgres + workers ($300/mo) = ~20× delta; documented honestly in the adapter README.

### 4.4 `@thodare/world-vercel` — Vercel-native, not WDK-wrapped

Composes Vercel's own primitives directly. No WDK dependency.

| Thodare needs | Vercel primitive |
|---|---|
| Workflow JSON storage + run/step materialized views | Vercel Postgres (managed Neon) |
| Credential vault (encrypted at rest) | Vercel Postgres (`workflow.credentials`, AES-256-GCM with per-org key) |
| Job queue (`__wkf_workflow_*` / `__wkf_step_*`) | Vercel Queues *(in beta as of 2026-05; verify before locking)* OR Vercel Cron + a poll worker as fallback |
| Step execution | Vercel Functions (Lambda-style; the Thodare runtime walker is the function body) |
| Cron / scheduled triggers | Vercel Cron |
| Live run subscription (SSE) | Vercel Functions returning `Response` with streaming body |
| Large step output spillover | Vercel Blob (R2-compatible) |

**Capability flags:** `serverless: true`, `maxStepDurationMs: 300_000` (Vercel Pro), `signalPrecision: "exact"`, `exactlyOnceSteps: true`, `pricingModel: "per-invocation"`, `supportsLiveSubscription: true`, `supportsResumeFromStep: true`.

**Build target:** `thodare build --target=vercel` produces a directory with a Vercel Build Output API v3 layout + a `vercel.json` (merged into the user's `vercel.json` if present). The user runs `vercel --prod` themselves (per the no-`thodare deploy` rule + the deploy-redirect trick — Flue's `cloudflare-wrangler-merge.ts:563-580` pattern generalized).

### 4.5 `@thodare/world-aws` — AWS-native

Composes AWS primitives directly.

| Thodare needs | AWS primitive |
|---|---|
| Storage + materialized views | RDS Postgres (or Aurora Serverless v2 for scale-to-zero) |
| Credential vault | RDS Postgres + KMS-derived per-org key |
| Job queue | SQS (with `delaySeconds` for sleeps; SQS FIFO for in-order step messages per run) |
| Step execution | Lambda (with the runtime walker as handler; SQS Event Source Mapping for delivery) |
| Cron | EventBridge Scheduler |
| Live subscription | API Gateway WebSockets *or* a long-poll fallback |
| Large output spillover | S3 |
| Optional alternative orchestrator | AWS Step Functions if user prefers managed orchestration over Lambda+Postgres |

**Build target:** `thodare build --target=aws` emits a SAM template + bundled Lambda zip + IAM policies. User runs `aws sam deploy` themselves.

**Capability flags:** `serverless: true`, `maxStepDurationMs: 900_000` (Lambda 15-min), `pricingModel: "per-invocation"`, `supportsLiveSubscription: true` (via API GW WebSockets — adds operational cost), `supportsResumeFromStep: true`.

### 4.6 `@thodare/world-wdk` — *opt-in only*, not the inheritance play

Demoted from v2's "inheritance play." `world-wdk` exists if a developer specifically wants WDK's `'use workflow'` / `'use step'` directive authoring as the substrate (because they like the DX, not because they need Vercel — `world-vercel` already covers Vercel directly). The adapter:

1. Compiles Thodare's `SerializedWorkflow` JSON into a TS file with `'use workflow'` + `'use step'` directives at deploy time.
2. Bundles that TS via `@workflow/builders`.
3. Runtime: Thodare's runtime walker is registered as a single `'use workflow'` function in WDK; per-Thodare-workflow JSON is loaded from Thodare's own store at run time. Same convergence pattern as §1 (one orchestrator, per-instance metadata).

**Why opt-in only:** wrapping WDK to reach Vercel pulls Vercel users through an abstraction tax (WDK's runtime + SWC) that they did not ask for. `world-vercel` reaches Vercel directly with Vercel's own primitives — same dollars, simpler bill, platform-native debugging. WDK is a peer architecture to learn from (per `code-reviews/wdk.md` — patterns lifted verbatim into the Thodare contract); it is not the way Thodare reaches a platform.

### 4.7 The headless-friendliness adapter matrix — for visual-builder consumers

| Capability | `world-self-host-postgres` | `world-self-host-sqlite` | `world-cloudflare` | `world-vercel` | `world-aws` |
|---|---|---|---|---|---|
| Live subscription | ✅ LISTEN/NOTIFY | ✅ in-process EventEmitter | ✅ DO + WS | ✅ Functions streaming | ✅ API Gateway WS |
| Step IO inspection | ✅ | ✅ | ⚠️ 1 MiB cap per step | ✅ | ✅ |
| Resume from step | ✅ | ✅ | ⚠️ requires re-create | ✅ | ✅ |
| Recover failed | ✅ | ✅ | ⚠️ via re-create | ✅ | ✅ |
| Live latency | ~50ms | <10ms | ~200ms | ~100ms | ~200ms (WS) |
| Credentials at rest | per-org KMS or env-derived AES-256 | env-derived AES-256 | DO + AES-256 | KMS-derived per-org AES-256 | KMS-derived per-org AES-256 |
| Pricing at 10M runs/day | ~$300/mo | n/a (dev only) | ~$6.1k/mo | ~$2-3k/mo (Postgres + Functions) | ~$1.5k/mo (RDS + Lambda) |

Adopters of Thodare-as-headless-backend pick the platform-native World whose UI behavior + cost + ops familiarity matches their team. `world-wdk` (§4.6, opt-in) is omitted from this matrix because its capabilities are inherited from whatever WDK World it's pointed at; if a user picks WDK on Vercel, they should compare against `world-vercel` directly first.

---

## 5. Migration path

Six phases. Each independently shippable. **No behavior change for existing users until Phase 6.**

### Phase 1 — Define the contract + ship the conformance suite (~1.5 weeks)

- `packages/world/` (new) — pure types + `ThodareWorld` interface + `WorldCapabilities` + `ThodareStep` + `ThodareCtx` + branded `SpecVersion` constants. No runtime, no deps.
- `packages/world-contract-tests/` (new) — parameterized vitest suite. Provides `runContractTests(world, options?)`. **Ship FIRST**, before any second adapter, so the contract is anchored in executable form.
- RFC at `rfcs/world-abstraction/README.md` — restate this proposal in RFC form. Lock the interface and capability list in v0; bump in v1+ with explicit semver discipline.
- **SPEC.md fix:** correct `add` / `update` / `remove` → `add` / `edit` / `delete` in §3 T1. One-line PR.

### Phase 2 — Ship the credentials primitive (~1.5 weeks)

- `packages/engine/src/credentials/` (new) — `Credential`, `CredentialType`, `ToolCredentialBinding` types + AES-256-GCM helpers + per-org key derivation.
- `packages/api/src/routes/credentials.ts` (new) — CRUD + `/test` endpoint. Multi-tenant scoped per T11.
- `packages/api/src/store/credentials.ts` (new) — Drizzle / direct SQL store.
- DB migration: `workflow.credentials` table.
- `defineConnector` extended to accept `credential?: ToolCredentialBinding`.
- `ToolContext` extended with `credential?: { token, ...resolved fields }`.
- 8+ tests including: encrypt-at-rest, never-leaks-to-LLM, multi-tenant isolation, oauth-refresh path.
- Documentation: `apps/docs/src/content/docs/explanation/credentials.md` + how-to page.

### Phase 3 — Extract the openworkflow adapter (~1 week)

- `packages/world-openworkflow-pg/` (new) — wraps `OpenWorkflow` + `BackendPostgres`. Passes contract tests. ~150 LoC.
- `packages/world-openworkflow-sqlite/` (new) — same code, `BackendSqlite`. ~50 LoC.
- Refactor `packages/engine/src/runner/openworkflow.ts` + `runtime-workflow.ts` + `handle.ts` — take a `World` instead of an `OpenWorkflow` + `Backend`. The walker (`walk.ts`) is already abstract (`step: any`); minimal change.
- `packages/api/src/runtime-host.ts` — rewrite in terms of `world.runWorkflow`. ~30 LoC change.
- **Backward-compat:** `createWfkit({ backend })` continues to work; deprecated in favor of `createWfkit({ world })`.
- All existing 209 tests pass with no behavior change.

### Phase 4 — Ship the second adapter (~1.5 weeks)

- `packages/world-cloudflare-dynamic/` (new) — uses `cloudflare/dynamic-workflows@^0.1.1` peer dep + D1 + DO. ~150 LOC.
- `examples/deploy-cloudflare/` workspace — full deploy story end to end via `wrangler deploy`.
- New docs: `apps/docs/src/content/docs/how-to/deploy-cloudflare.md`.

This is **the proof point** — once a second adapter passes contract tests, the abstraction is real. Plus we get noisy-neighbor mitigation pattern documented.

### Phase 5 — Ship the platform-native worlds (~4 weeks)

- `packages/world-vercel/` (~250 LOC; Vercel Postgres + Blob + Cron + Functions)
- `packages/world-aws/` (~400 LOC; RDS + SQS + Lambda + S3 + EventBridge)
- `examples/deploy-vercel/`, `examples/deploy-aws/`, plus the existing `examples/deploy-cloudflare/`
- Per-adapter docs page in the deploy quadrant.
- **Headless-builder demo:** `examples/headless-ui-demo/` — a minimal canvas (React Flow + 200 LoC of glue) that reads from `@thodare/api` and proves the substrate story. Same demo runs against every adapter; only the deploy target changes.
- *(deferred to v0.3+)* `packages/world-wdk/` (opt-in only; ~150 LoC), `packages/world-netlify/`, `packages/world-rivetkit-engine/`, `packages/world-inngest/`

### Phase 6 — Deprecate the direct openworkflow API (~v0.3, separate release)

- `createWfkit({ backend })` removed.
- `createWfkit({ world })` is the only path.
- Migration codemod + changelog.
- This is the only release that breaks existing users; gate with a major version bump per Changesets discipline (T15).

**Total: ~9 weeks of focused work, each phase independently shippable, no behavior change for existing users until phase 6.** v1's estimate was 6 weeks; v2 grew because credentials + tombstone + resume/recover + headless-demo are real adds.

---

## 6. The CLI + deploy story — Flue patterns lifted

Per `code-reviews/flue.md` the proposed `thodare` CLI for v0.2:

```
thodare init                              # scaffold a new project (one of the few one-shot verbs)
thodare dev                               # local SQLite world; hot-reload on workflow JSON change
thodare run <workflow> [--input '{...}']  # one-shot CI-style run; reads result from stdout
thodare build --target=<world>            # produce the deployable artifact for the target
```

**Critically: no `thodare deploy`.** `thodare build --target=cloudflare` produces a directory with a `wrangler.jsonc` + a worker bundle + a deploy-redirect file (`<outputDir>/.wrangler/deploy/config.json` per Flue's pattern at `cloudflare-wrangler-merge.ts:563-580`); the user runs `wrangler deploy` themselves and **it Just Works** with no Thodare wrapper command. Same pattern for `--target=lambda` (SAM template + redirect), `--target=postgres-self-host` (Compose file + migration script).

**`BuildPlugin` interface** — lifted from Flue (`packages/sdk/src/types.ts:441-469`), extended with two Encore-derived methods (per `code-reviews/encore-ts.md` §8):

```ts
interface BuildPlugin {
  name: string;

  // Lifted from Flue (the five methods)
  generateEntryPoint(ctx: BuildContext): string | Promise<string>;
  bundle: 'esbuild' | 'none';                    // 'none' is load-bearing — for platforms that own bundling
  entryFilename?: string;                         // required when bundle === 'none'
  esbuildOptions?(ctx: BuildContext): Record<string, any>;
  additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;

  // Added from Encore.ts (per code-reviews/encore-ts.md §8)
  generateInfraConfigSchema?(ctx: BuildContext): JSONSchema;             // declares "what bindings does this World need"
  validateInfraConfig?(ctx: BuildContext, cfg: unknown): ValidationResult; // fail fast: "your Queue('foo') has no binding in thodare.world.json"
}
```

Each `world-*` package exports a `BuildPlugin`. The CLI `--target` flag dispatches. Third parties can write their own `world-foo` + `BuildPlugin` without touching the CLI.

**The `generateInfraConfigSchema` + `validateInfraConfig` pair** is the seam Thodare borrows from Encore's `runtimes/core/src/infracfg.rs`. Application code declares **what** it needs (`defineConnector("send_push", { credential: { required: true, type: "fcm" } })`); the per-target `thodare.world.json` declares **where** those things live (`{ "credential.fcm": { provider: "cf-do", namespace: "credentials-prod" } }`); the build accepts both and fails fast if the schema and the config disagree. **Without this seam, the multi-cloud story is hand-wavy ("each World decides"); with it, the seam is explicit, validatable, and surface-stable across adapter versions.**

### 6.1 The build-time config seam — `thodare.world.json`

Per Encore's `infra.config.json` pattern. One file per environment per target:

```jsonc
// thodare.world.cf.json
{
  "world": "@thodare/world-cloudflare",
  "bindings": {
    "credential.fcm":         { "provider": "cf-do",   "namespace": "credentials-prod" },
    "queue.workflow":         { "provider": "cf-queue", "name": "thodare-workflow" },
    "queue.step":             { "provider": "cf-queue", "name": "thodare-step" },
    "storage.workflows":      { "provider": "d1",      "database": "thodare-prod" },
    "storage.events":         { "provider": "d1",      "database": "thodare-prod" },
    "stream.runOutput":       { "provider": "cf-do",   "namespace": "stream-prod" }
  },
  "secrets": {
    "AUTH_SECRET":            { "provider": "cf-secret", "name": "AUTH_SECRET" }
  }
}
```

`thodare build --target=cloudflare --config=thodare.world.cf.json` reads both, validates the schema, and refuses to build if a binding is missing or the wrong provider is named. The per-World package owns the schema; the CLI does the validation. **Application code never knows which provider is wired** — that's the whole point of the seam.

### 6.2 The codegen tree in the user's repo — `.thodare/`

Per Encore's `encore.gen/` pattern (`code-reviews/encore-ts.md` §8). `thodare build --target=X` writes its generated entrypoint + per-World adapter glue to `.thodare/` in the user's repo (gitignored by default). Three properties matter:

1. **Production-grade, hand-readable, eject-able TS.** A user can read `.thodare/entry.ts` to understand what's actually running. They can fork it and own it. This is "AI-buildable, human-ownable" — the opposite of magic-hidden-in-`node_modules`.
2. **Inspectable in PRs.** If the user opts to commit `.thodare/`, every build's diff is a real PR-reviewable artifact.
3. **Per-target, deterministic.** Same input + same `BuildPlugin` produces byte-identical output. Per Flue's byte-equality check (`build.ts:155-166`).

**Merge-don't-replace** for platform configs (Flue's `cloudflare-wrangler-merge.ts` algorithm, generalized):

- User's `wrangler.jsonc` / `serverless.yml` / `compose.yaml` / `Dockerfile` is the source of truth.
- Thodare merges its required bindings + variables into the user's config.
- Per-field policy (Thodare-wins for engine bindings, user-wins for app bindings, union for migrations, sorted-deduped for arrays).
- Byte-equality check on the output; skip-write if no diff (avoids spurious mtime changes that retrigger downstream watchers).

**Specifically NOT copied from Flue (anti-patterns documented):**

1. **No two-workspace layout** — Flue ships both `./.flue/` (embedding) and `./` (greenfield) and pays for it in every doc page. Thodare picks **one (bare)**; `--workspace=<path>` is the explicit-override escape hatch.
2. **No `THODARE_MODE=dev` env var** that does double-duty (bypass production guards + leak dev-only error fields). Use named-purpose env vars; hard-error on startup if a dev bypass is set in production.
3. **No regex-based parsing of TS source** for triggers/exports. Use the TypeScript compiler API or `oxc-parser`.
4. **No "tests are expensive, skip them"** — Flue ships zero tests; Thodare keeps the 209-test discipline + adds the contract suite.

---

## 7. Thodare as headless substrate for visual-builder applications *(NEW v2 section)*

This is the second-consumer framing the user clarified mid-research. **Thodare is the engine; the developer brings the application.**

### 7.1 What "headless backend for n8n-class apps" actually requires

A developer building an n8n-class / ActivePieces-class / Sim-Studio-class application on top of Thodare needs the API to expose:

| What the UI needs | Thodare API endpoint | Status |
|---|---|---|
| List connectors with full UI metadata (label, icon, category, tags, auth requirements) | `GET /api/connectors` | **Partial** — needs metadata enrichment per §2.4 P3 |
| Get connector with rich form schema (incl. dynamic options) | `GET /api/connectors/:type` + `POST /api/connectors/:type/refresh` (NEW) | **Missing dynamic schema endpoint** P1 |
| List + create credentials per org | `GET/POST /api/credentials` (NEW in Phase 2) | **Missing** P0 |
| Test a credential | `POST /api/credentials/:id/test` (NEW) | **Missing** P0 |
| List workflows for org, paginated | `GET /api/workflows` | ✅ |
| CRUD workflow | `POST/GET/PATCH/DELETE /api/workflows/:id` | ✅ |
| Patch workflow (LLM-style or canvas-style) | `POST /api/workflows/:id/operations` | ✅ — extend with `?stream=ndjson` (NEW) |
| Diff two workflows → ops | `POST /api/workflows/:id/diff` (NEW) | **Missing** P1 — Sim has `compute-edit-sequence.ts` as reference |
| Trigger run | `POST /api/workflows/:id/run` | ✅ |
| Subscribe to run events | `GET /api/runs/:runId/stream` (SSE) | **Missing** P0 — gated by `World.capabilities.supportsLiveSubscription` |
| List runs + steps + IO | `GET /api/runs` + `GET /api/runs/:id/steps` | ✅ |
| Resume run from step | `POST /api/runs/:id/resume?step=<stepId>` (NEW) | **Missing** P1 — gated by `supportsResumeFromStep` |
| Recover failed run | `POST /api/runs/:id/recover` (NEW) | **Missing** P1 — gated by `supportsRecover` |
| Per-workflow webhook URL | `GET /api/workflows/:id/blocks/:blockId/webhook-url` (NEW) | **Missing** P3 |
| Full system catalog in one call (workflows + connectors + credential types + capability flags + active World) | `GET /api/system/manifest` (NEW) | **Missing** P1 — saves N round-trips for LLMs and visual builders bootstrapping (per `code-reviews/iii-dev.md` §3 — iii's `engine::functions::list` is its biggest LLM-feedability story) |

Ten of sixteen are present today. Six are gaps that v2 adds.

### 7.2 `examples/headless-ui-demo/` — the proof artifact

A minimal canvas (React Flow + ~500 LoC of glue) that reads from `@thodare/api` end-to-end:

1. Login + select org.
2. Render connector palette from `GET /api/connectors`.
3. Drag a connector onto a canvas; canvas emits an `EditOp[]` (using a Thodare-side `compute-edit-sequence` helper).
4. POST the ops to `/api/workflows/:id/operations?stream=ndjson`; render skipped vs applied as the response streams.
5. Click a "Connect Slack" button → opens credential entry form rendered from `Credential.properties`; POST to `/api/credentials`.
6. Click "Run"; subscribe to `/api/runs/:runId/stream` (SSE); render step-by-step progress.
7. Click "Rerun from this step" on a failed step → `POST /api/runs/:id/resume?step=<stepId>`.

**Same demo runs against every adapter; only the deploy target changes.** That's the headless-substrate story made concrete.

### 7.3 What this proposal does NOT do

To be precise about scope:

- ❌ Thodare does **not** ship `world-n8n` / `world-activepieces` / `world-sim-studio` adapters. Those are competing applications, not durable execution backends.
- ❌ Thodare does **not** import n8n nodes / AP pieces / Sim blocks as Thodare connectors. Cross-project connector portability is a separate question the headless-substrate developer can solve in their own application.
- ❌ Thodare is **not** competing with n8n / AP / Sim at the UI/product layer. It's the substrate they (or applications like them) build on.

The 15-item gap list in §2.4 + `code-reviews/visual-builder-substrates.md:§4.5` is what makes Thodare a credible backend for those applications. Three are P0 (credentials, output `hiddenFromDisplay`, `llm-only` visibility). Phase 2 ships P0 credentials. Phases 5-6 + a v0.3 follow-up ship the rest.

---

## 8. Risks + alternatives considered

### 8.1 Adapter capability variance — the real risk

Engines disagree on sleep precision, signal semantics, retry policy, step output size. **Mitigation:** capability flags carry the truth; the validator at `applyOperations` time refuses workflows whose declared step output exceeds the active World's `maxStepOutputBytes`; the contract-test suite asserts per-adapter behavior.

**Honest framing in docs:** "Thodare unifies the surface, not the substrate. Pick the World whose tradeoffs match your workload."

### 8.2 The "make Thodare a WDK World instead" alternative

Per WDK reviewer §8.4: technically tractable but inverts the right direction. WDK's surface is **code-first**; Thodare's bet is **JSON+EditOp**. Becoming a WDK World means adopting WDK's surface and burying ours. **Reject** — but document in RFC's "alternatives considered" section.

### 8.2a The "wrap WDK to inherit Vercel + Postgres + Local + community Worlds" alternative

This is the framing v2 *initially* used. Refined out in this revision (see §4.1): wrapping WDK as a meta-adapter for many platforms couples Thodare to WDK's evolution, ships Vercel-flavored deploy semantics on every WDK-derived backend, and leaks WDK's directive + SWC pipeline into deployments that have no use for either. **Each platform reaches its own primitives directly.** WDK survives only as an opt-in adapter (`world-wdk`, §4.6) for users who specifically want directive-style authoring.

### 8.2b The "build on Cloudflare's Agent Framework" alternative

Cloudflare's Agent Framework (`@cloudflare/agents`) provides a stateful agent class with WebSocket / hibernation / scheduling / tool-use. Flue uses it because Flue *is* an agent harness — its problem shape is exactly what Agent Framework solves.

Thodare's problem shape is different: durable orchestration of arbitrary workflow graphs where the graph is data (JSON), not code. Building Thodare on Agent Framework would (a) inherit a state-machine abstraction we don't need (the runtime walker already orchestrates state via openworkflow / CF Workflows — two state machines fighting for ownership of the run), (b) couple to Agent Framework's evolution and quirks, (c) lose direct access to Workflows / Queues / DO / D1 surface area. **Reject.** Build on the primitives directly. Agent Framework can still be a *consumer* of Thodare (an agent app calls Thodare's API to trigger a durable workflow) — it is a peer at a different layer, not a substrate.

### 8.3 The "build the native runtime (Alternative A)" alternative

Per WDK reviewer §8.2: "Don't ship a `vm.Context` workflow runtime if you don't have to." Right call for WDK's directive model; wrong call for Thodare's JSON model. Door stays open as `@thodare/world-native` if a clear gap emerges; almost certainly never.

### 8.4 The "just use one of these existing engines, scrap Thodare entirely" alternative

The framing: if WDK / Inngest / CF / Rivet exist, why does Thodare exist?

The answer: because none of them ship the JSON+EditOp + multi-tenant API + credential vault + Diataxis-disciplined docs + `hidden()` security boundary surface. **Thodare is the LLM-native + visual-builder-friendly control plane on top of any of them.** The World abstraction makes that pitch credible.

### 8.5 Adapter pricing transparency

CF Workflows at 10M runs/day = ~$6.1k/mo (per `cloudflare-as-world.md`). Self-hosted Postgres + workers at the same load = ~$300/mo. The 20× delta is the user's tradeoff, not ours, but **we owe them honest math in each adapter's README** — pricing examples at small / medium / Black-Friday scale, no marketing.

### 8.6 Credential model lock-in

Once Thodare ships the `Credential` artifact in v0.2, changing it later breaks every adapter and every consumer. **Mitigation:** the API is versioned (per spec-version cascade), and the storage schema uses jsonb for `properties` so new credential types don't require a migration. The branded `SpecVersion` in §3.4 prevents runaway drift.

### 8.7 The "wait, is Cloudflare's `dynamic-workflows` stable enough to depend on?" risk

It shipped 2026-05-01 at version 0.1.1. Per `code-reviews/dynamic-workflows.md`: API churn risk is real; tests don't exercise the RPC-stub path end-to-end; `WorkerEntrypoint` cannot be `new`'d outside workerd RPC contexts so unit tests cover only the function-level surface. **Mitigation:** pin `^0.1.1` as peer dep with explicit upgrade gates; do NOT vendor the source even though it's MIT and small (the upstream maintainers will move faster than us; let them); document that `world-cloudflare-dynamic` is "alpha-on-alpha" and not the recommended production World until upstream stabilizes.

---

## 9. Success metrics — Black Friday is the benchmark

For v0.2 to ship as "done":

### Functional

- [ ] Five adapters in the workspace, all green on `@thodare/world-contract-tests`.
- [ ] **Credential primitive shipped** with end-to-end test covering encrypt-at-rest + never-leaks-to-LLM + multi-tenant isolation.
- [ ] All existing 209 tests pass with no regressions; new total ≥ 280 (contract suite + credential + tombstone + resume/recover tests).
- [ ] Backward compat: `createWfkit({ backend })` works in v0.2 with deprecation warning.
- [ ] Migration codemod ships in same release.
- [ ] Every adapter ships a `examples/deploy-<adapter>/` workspace that boots with `pnpm install && pnpm dev` and runs end-to-end.
- [ ] `examples/headless-ui-demo/` ships and runs against all 5 adapters.

### Operational (the real bar)

- [ ] **10,000 concurrent workflow runs** sustained for 1 hour against `world-openworkflow-pg`, p99 step latency ≤ 200ms, zero data loss on a single worker pod restart mid-run.
- [ ] **1,000 concurrent runs** sustained for 1 hour against `world-cloudflare-dynamic`, p99 step latency ≤ 1s, zero replay-divergence errors, zero envelope-leak findings.
- [ ] **Adapter swap test:** `examples/full-llm-loop/` workflow runs identically on every adapter — only deploy target changes.
- [ ] **Black Friday simulation:** single 10M-run scripted scenario across all 5 adapters; results posted as `bench/black-friday-2026.md` with raw numbers, latency histograms, cost math.
- [ ] **Tombstone replay test passes** — a workflow with a removed mid-graph block, in-flight run keeps T4 JSON, new run uses tombstone, both succeed.
- [ ] **Resume-from-step test passes** on every World that declares `supportsResumeFromStep: true`.

### Strategic

- [ ] At least one external adopter writes a third-party World adapter using the public `@thodare/world` types within 90 days. (If nobody can, the abstraction is wrong.)
- [ ] At least one adopter migrates from openworkflow + Postgres to Cloudflare Workflows without changing their workflow JSON or their EditOp loop. (Demonstrates the substrate-swap promise.)
- [ ] **At least one external project demonstrates a custom n8n-class / AP-class / Sim-class UI built on `@thodare/api` within 90 days.** (Demonstrates the headless-substrate promise.)
- [ ] HN / X reach: post-launch front-page on HN ("Show HN: Thodare runs the same workflow on Postgres, Cloudflare, Vercel, and your laptop — and it's the headless backend for your n8n clone").

### DX

- [ ] `thodare init` → `thodare dev` → first workflow runs in < 60 seconds on a fresh laptop.
- [ ] CLI surface ≤ 4 verbs (`init`, `dev`, `run`, `build`) — no `deploy`.
- [ ] Each adapter's README documents pricing at three scales (10k / 1M / 10M runs/day) with verifiable math.
- [ ] Every adapter's README documents headless-friendliness matrix (live subscription / step IO / resume-from-step / live latency).
- [ ] **`thodare-skills/` directory ships** at v0.2 — Claude Code / Cursor / Codex / Gemini compatible — covering every primitive (define a workflow, define a connector, define a credential, patch via EditOps, run + observe). Per `code-reviews/iii-dev.md` §5 — iii ships 26 first-party SkillKit skills; raises the bar for "AI-buildable framework."

---

## 10. Open decisions — the maintainer needs to pick

Before this becomes an RFC, four decisions are load-bearing:

### 10.1 Capability flags vs. trait composition

This proposal recommends capability flags (Alternative B from `_scratch-interface-design.md`). If the maintainer prefers traits (Alternative C), the World interface and the contract-test suite need to be rebuilt around traits — meaningful redesign, not a tweak.

### 10.2 `thodare deploy` or not

Recommends "no, we ship `build` only and delegate to platform tools" (per Flue + the `wrangler` deploy-redirect trick). Some users will demand `deploy`. The maintainer should decide whether to hold the line. **Recommendation: hold the line.** The platform's deploy tools have the auth, the credential cache, the rollback story, the team permissions. Thodare wrapping them is one bug class away from disaster.

### 10.3 Push-only vs. push+pull queue mode

Recommends push+pull (per §3.3). WDK is push-only and pays for it (no SQS / Kafka / NATS support without an embedded HTTP server). Thodare adds `Queue.mode` declaration so pull-only adapters work natively. Maintainer should confirm this is worth the contract-suite complexity (separate test packs per mode).

### 10.4 Where the credentials primitive lives

Recommends `packages/engine/src/credentials/` (engine-level), with API endpoints in `packages/api/src/routes/credentials.ts`. Alternative: ship as a separate `@thodare/credentials` package. Maintainer call. **Recommendation: engine-level**, because every adapter and every connector depends on it; making it a separate package adds a dependency edge for no clear benefit.

---

## 11. The `code-reviews/` companion files

Every claim in this proposal is sourced from one or more of:

- [`code-reviews/wdk.md`](./code-reviews/wdk.md) — 7,641 words. World contract + 3 official Worlds + SWC plugin + runtime + framework integrations. The foundational read.
- [`code-reviews/workflow-examples.md`](./code-reviews/workflow-examples.md) — 4,499 words. WDK primitives reference + 5 reusable patterns + framework adapter contract.
- [`code-reviews/workflow-builder-template.md`](./code-reviews/workflow-builder-template.md) — 6,828 words. Plugin registry + interpreter/codegen split + AI op-stream route + Drizzle schema + auth.
- [`code-reviews/dynamic-workflows.md`](./code-reviews/dynamic-workflows.md) — 4,965 words. Line-by-line walkthrough of the 300-LoC library + concrete `world-cloudflare-dynamic` adapter sketch + 3 risks.
- [`code-reviews/flue.md`](./code-reviews/flue.md) — 8,702 words. `BuildPlugin` interface + wrangler-merge algorithm + error vocabulary + dev server two-tier reloader + the deploy-redirect trick.
- [`code-reviews/rivet.md`](./code-reviews/rivet.md) — 7,374 words. `EngineDriver` + `WorkflowContextInterface` + the `removed` entry kind + `replayWorkflowFromStep` + `recover()` semantics.
- [`code-reviews/visual-builder-substrates.md`](./code-reviews/visual-builder-substrates.md) — 6,570 words. n8n / AP / Sim deep dive + EditOp inheritance verification (3 of 5 ops diverged) + 15-item prioritized gap list.

Plus the v1-era research:

- [`durable-engines-survey.md`](./durable-engines-survey.md) — Inngest / Hatchet / Trigger / Temporal / CF Workflows / DBOS / Quirrel comparison.
- [`cloudflare-as-world.md`](./cloudflare-as-world.md) — three CF adapter shapes ranked + Black-Friday-scale pricing math.
- [`flue-deep-dive.md`](./flue-deep-dive.md) — first-pass Flue research (superseded by `code-reviews/flue.md`).
- [`rivet-deep-dive.md`](./rivet-deep-dive.md) — first-pass Rivet research (superseded by `code-reviews/rivet.md`).
- [`_scratch-interface-design.md`](./_scratch-interface-design.md) — three interface alternatives + openworkflow coupling map.
- [`_parking-lot-headless-substrate.md`](./_parking-lot-headless-substrate.md) — the user's mid-research clarification on the headless-substrate goal.
- [`world-abstraction-proposal.v1.md`](./world-abstraction-proposal.v1.md) — v1 of this proposal, kept for diffability.

External clones referenced (siblings of `thodare/` in `agent-control-panel/`):

| Repo | Path | License | Why |
|---|---|---|---|
| `vercel/workflow` | `../../workflow/` | Apache-2.0 | The WDK source — closest peer; lift contract patterns |
| `vercel/workflow-examples` | `../../workflow-examples/` | (per-package) | All 14 examples + custom-adapter Bun (~100 LoC) |
| `vercel-labs/workflow-builder-template` | `../../workflow-builder-template/` | Apache-2.0 | React Flow + plugin registry + AI op-stream — feeds builder-UI spike |
| `cloudflare/dynamic-workflows` | `../../dynamic-workflows/` | MIT | ~300 LoC pattern enabling cheap CF adapter |
| `withastro/flue` | `../../flue/` | (check repo) | CLI + deploy ergonomics; merge-don't-replace algorithm |
| `rivet-gg/rivet` | `../../rivet/` | Apache-2.0 | `EngineDriver` + `removed` entry + `replayWorkflowFromStep` |
| `n8n-io/n8n` | `../../n8n/` | Sustainable Use License | `INodeProperties` + `ICredentialType` reference |
| `activepieces/activepieces` | `../../activepieces/` | MIT | `Property` types + `PieceAuth` + linked-list workflow format |
| `simstudioai/sim` | `../../sim/` | Apache-2.0 | EditOp ancestor + `BlockConfig` + 28 SubBlock types |

---

**End of proposal v2.** Open the RFC at `rfcs/world-abstraction/README.md` when ready. The v2 above is RFC-shaped — translate `## n` headings to RFC sections + lock the interface in v0.

The standard isn't "good enough" — it's "holy shit." Two consumers, one substrate; pick the engine that fits your bill. That's the pitch.
