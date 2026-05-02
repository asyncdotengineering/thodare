# Rivet — Source-Level Code Review for Thodare

Reviewed commit/clone: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/rivet/`
License: Apache-2.0 (workspace-wide, declared in root `Cargo.toml:73`).
Workspace version at review time: `2.3.0-rc.4` (Cargo) and `2.3.0-rc.4` (workflow-engine `package.json`).

This review reads the actual code rather than restating Rivet's marketing. The relevant verdict for the `world-rivetkit-engine` proposal is buried in two facts that the marketing pages obscure:

1. The **Rust engine** (`engine/packages/*`, ~50 crates) and the **TypeScript `@rivetkit/workflow-engine`** package (`rivetkit-typescript/packages/workflow-engine/`) are **two completely independent durable-execution implementations**. They share *concepts* (history, replay, activity/step, sleep, signal/message) but **no code, no protocol, no persistence**. The Rust side talks to runners over a BARE-encoded WebSocket runner-protocol; that runner is just the user's actor code, not the workflow engine.
2. `@rivetkit/workflow-engine` is a clean ~3K-LOC TS library with **a single ~110-line `EngineDriver` interface**. It is genuinely peer-shaped to `@thodare/openworkflow`'s runtime walker — it is NOT bolted to FoundationDB, NOT bolted to Rivet's Rust engine, and NOT bolted to Cloudflare Durable Objects. Anything that can give it sorted-prefix KV with atomic batch-write and an alarm timer can host it.

Everything below substantiates those two claims.

---

## 1. Repo Map

### 1.1 Rust engine — `engine/packages/`

`Cargo.toml:1-67` lists ~50 first-party crates plus the rivetkit-rust subtree. Roles, grouped:

**Workflow-orchestration core ("gasoline" — Rivet's Rust workflow engine, named after the gas-station theme):**
- `gasoline` — the durable-execution library. `gasoline/src/lib.rs:1-19` exports `activity`, `workflow`, `ctx`, `db`, `history`, `worker`, `registry`, `signal`, `message`, `listen`, `operation`, `executable`. The user-facing `Workflow` trait is in `gasoline/src/workflow.rs:11-19`; `Activity` in `gasoline/src/activity.rs:9-21`. Notably this is a **separate workflow engine from the TS one** — different shape (async-trait Rust traits, not durable async functions; events instead of entries; coordinates instead of locations) but solving the same problem.
- `gasoline-macros` — proc macros (`#[workflow]`, `#[activity]`, etc.) per Cargo.toml workspace.
- `gasoline-runtime` — wires gasoline into the Rivet engine alongside `pegboard`, `epoxy`, `namespace`. `gasoline-runtime/Cargo.toml` deps confirm: `epoxy + gas + namespace + pegboard + rivet-config + rivet-types + universaldb`. `gasoline-runtime/src/lib.rs` contains `workflows/` — Rivet's *own* internal workflows that run on gasoline.
- `workflow-worker` — the Rust binary (well, library — `engine` is the binary) that pulls work from the registry. `workflow-worker/src/lib.rs:1-22` is 22 lines: it composes registries from `pegboard`, `namespace`, `epoxy`, `gasoline_runtime`, `datacenter`, builds a `DatabaseKv`, and starts a `Worker`. **This crate exists only to host Rivet's internal control-plane workflows; it is not a generic worker for user workflows.**

**Storage abstraction:**
- `universaldb` — Rivet's home-grown KV abstraction. `universaldb/Cargo.toml:1-29` shows it depends on `foundationdb-tuple` (just for tuple key encoding, not the DB), `rocksdb`, and `tokio-postgres`. `universaldb/src/lib.rs:1-25` re-exports `Database`, `DatabaseDriverHandle`, `Subspace`, and `tuple = foundationdb_tuple`. `universaldb/src/driver/` contains exactly two real backends: `postgres/` and `rocksdb/`. **There is no FoundationDB driver in the open-source tree.** FDB-tuple is just the binary key codec (the same one `@rivetkit/workflow-engine`'s TS keys.ts uses via the `fdb-tuple` npm package).
- `sqlite-storage` — local actor sqlite storage.
- `postgres-util` — Postgres helpers.
- `cache`, `cache-purge`, `cache-result` — multi-tier cache built on universaldb + Redis-via-pools.

**Actor scheduling — pegboard:**
- `pegboard` — this is **the** big crate. `pegboard/Cargo.toml` deps include `foundationdb-tuple`, `epoxy-protocol`, `rivet-runner-protocol`, `vbare`. `pegboard/src/lib.rs:1-30` registers ~13 workflows: `actor::Workflow`, `actor2::Workflow`, `runner::Workflow`, `runner2::Workflow`, `runner_pool::Workflow`, several backfill workflows, `serverless::receiver::Workflow`, `serverless::conn::Workflow`, etc. `pegboard/src/keys/` includes `actor_kv.rs`, `actor.rs`, `runner.rs`, `envoy.rs`, `epoxy/`. **Pegboard is the actor scheduler + actor KV layer, implemented as a pile of gasoline workflows.** It is NOT a generic durable workflow database — its workflows are specifically about actors, runners, runner pools, and serverless connections.
- `pegboard-gateway`, `pegboard-gateway2`, `pegboard-envoy`, `pegboard-outbound`, `pegboard-runner` — the network gateway tier that proxies HTTP/WS into actors.
- `runner-protocol` — the BARE schema (`engine/sdks/schemas/runner-protocol/v1.bare`–`v7.bare`, currently `PROTOCOL_VERSION: 7` per `rivetkit-typescript/packages/engine-runner/src/mod.ts:23`) that the Rust gateway uses to talk to TS runners over WebSocket.

**Replication / coordination:**
- `epoxy` — `epoxy/src/lib.rs:1-23` registers three workflows: `backfill::Workflow`, `coordinator::Workflow`, `replica::Workflow`. `epoxy-protocol` is its wire format. **Epoxy is Rivet's MultiPaxos-style replication coordinator for namespace metadata across datacenters.** It is not a cache, not a serializer — it is consensus.
- `universalpubsub` — pub/sub abstraction (NATS or in-memory).

**API / gateway / infra:**
- `api-builder`, `api-peer`, `api-public`, `api-public-openapi-gen`, `api-types`, `api-util` — the public REST/OpenAPI surface.
- `guard`, `guard-core` — the front-door HTTP gateway (TLS termination, request routing).
- `engine` — the binary entrypoint; `engine/src/lib.rs:7-30` defines the `SubCommand` enum: `Start`, `Database`/`db`, `Workflow`/`wf`, `Config`, etc.
- `bootstrap`, `service-manager`, `runtime`, `pools` — process lifecycle, connection pooling.
- `config`, `config-schema-gen`, `env`, `error`, `error-macros`, `metrics`, `logs`, `telemetry`, `tracing-utils`, `tracing-reconfigure`, `util`, `util-id`, `util-serde`, `types` — utilities.
- `datacenter` — multi-DC primitives.
- `namespace` — namespace workflows.
- `test-deps`, `test-deps-docker`, `test-snapshot-gen` — test scaffolding.

### 1.2 TypeScript — `rivetkit-typescript/packages/`

Per `pnpm-workspace.yaml:1-30` plus directory listing:

- **`workflow-engine`** — the standalone durable-execution library. Has `package.json` declaring `@rivetkit/workflow-engine`. **This is the only piece relevant to Thodare as a backend.** Deps: `@rivetkit/bare-ts`, `cbor-x`, `fdb-tuple`, `vbare` (per `package.json:53-58`). Zero Rivet-internal deps. Could be lifted onto npm and consumed by any host that implements `EngineDriver`.
- **`rivetkit`** (published as `rivetkit`) — the actor-framework user-facing SDK. `src/mod.ts` is the public entry; `src/actor/` defines the `actor()` builder; `src/workflow/` wraps `@rivetkit/workflow-engine` as `c.run = workflow(async (ctx) => …)`. `src/drivers/engine/actor-driver.ts` is the production driver; `src/inspector/`, `src/devtools-loader/` for tooling.
- **`engine-runner`** + **`engine-runner-protocol`** — runner that connects to Rivet engine over WebSocket using the BARE-encoded `runner-protocol`. `engine-runner/src/mod.ts:23` pins `PROTOCOL_VERSION: 7`. This is what runs in a "rivet runner" process.
- **`rivetkit-napi`** — Rust-backed N-API bindings (in the Rust workspace via `rivetkit-typescript/packages/rivetkit-napi`).
- **`framework-base`**, **`react`**, **`next-js`** — framework integrations.
- **`mcp-hub`**, **`devtools`**, **`traces`** — developer tooling.
- **`sql-loader`** — SQL migration loader.
- **`engine-cli`** — CLI front for the engine (TS-side helpers, not the Rust `engine` binary).

### 1.3 Other top-level dirs

- `examples/*` — ~50 example apps; the relevant ones for workflows are `examples/kitchen-sink/src/actors/workflow/{order,payment,batch,race,timer,approval,history-examples,dashboard}.ts` plus `examples/kitchen-sink/src/actors/queue/worker.ts` (queue-iter pattern).
- `self-host/compose/{dev,dev-host,dev-multidc,dev-multinode,dev-multidc-multinode,prod-file-system}/` — Docker Compose configs.
- `self-host/k8s/engine/` — K8s manifests (Postgres + NATS + engine StatefulSets/Deployments).
- `engine/sdks/typescript/{api-full,envoy-protocol,runner,runner-protocol,test-runner}` — generated TS clients.
- `rivetkit-{python,rust,swift,asyncapi,openapi,json-schema}` — auto-generated SDKs in other languages.
- `frontend/`, `website/`, `docs/`, `docs-internal/` — UI, marketing, docs.

---

## 2. `@rivetkit/workflow-engine` — Full Walkthrough

This is the package the Thodare proposal ought to be wrapping. It is small, self-contained, well-architected, and unusually well-documented (read `architecture.md:1-461` end-to-end — it is genuinely accurate).

### 2.1 Public API

`src/index.ts:1-133` re-exports:
- `runWorkflow(workflowId, workflowFn, input, driver, options) → WorkflowHandle` — entry point (line 597).
- `replayWorkflowFromStep(workflowId, driver, entryId?, options?) → WorkflowHistorySnapshot` — surgical replay-from-entry (line 755).
- `WorkflowContextImpl` — the context implementation; users program against `WorkflowContextInterface` from `src/types.ts`.
- `Loop.continue` / `Loop.break` helpers (line 124).
- The full error catalog and every entry/storage type.

### 2.2 The `EngineDriver` interface (verbatim, `src/driver.ts:32-108`)

```typescript
export interface EngineDriver {
    // === KV Operations ===
    get(key: Uint8Array): Promise<Uint8Array | null>;
    set(key: Uint8Array, value: Uint8Array): Promise<void>;
    delete(key: Uint8Array): Promise<void>;
    deletePrefix(prefix: Uint8Array): Promise<void>;
    deleteRange(start: Uint8Array, end: Uint8Array): Promise<void>;

    /**
     * IMPORTANT: Results MUST be sorted by key in lexicographic byte order.
     */
    list(prefix: Uint8Array): Promise<KVEntry[]>;

    /** Should be atomic if possible. */
    batch(writes: KVWrite[]): Promise<void>;

    // === Scheduling ===
    setAlarm(workflowId: string, wakeAt: number): Promise<void>;
    clearAlarm(workflowId: string): Promise<void>;
    readonly workerPollInterval: number;

    /** Queue-backed message driver used for workflow messaging. */
    readonly messageDriver: WorkflowMessageDriver;

    waitForMessages(messageNames: string[], abortSignal: AbortSignal): Promise<void>;
}
```

Plus `KVEntry { key: Uint8Array; value: Uint8Array }` (driver.ts:6-9) and `KVWrite { key: Uint8Array; value: Uint8Array }` (driver.ts:14-17).

`WorkflowMessageDriver` (`src/types.ts:359-374`):

```typescript
export interface WorkflowMessageDriver {
    addMessage(message: Message): Promise<void>;
    /** Must be non-blocking and return immediately. */
    receiveMessages(opts: {
        names?: readonly string[];
        count: number;
        completable: boolean;
    }): Promise<Message[]>;
    completeMessage(messageId: string, response?: unknown): Promise<void>;
}
```

That is the **entire** persistence surface. Eleven KV methods + alarms + a 3-method message driver. Notably:

- **No transactions, no sessions, no locking primitives** — isolation is provided externally (one workflow per KV namespace per host).
- **No workflow-id parameter on KV ops** — confirmed deliberate per `architecture.md:38-56` and the explicit comment at `driver.ts:23-30`.
- **`setAlarm` / `clearAlarm` take `workflowId`** — because alarms are managed by a shared scheduler (architecture.md:56).
- **`workerPollInterval`** — surfaced because in-memory short sleeps vs. driver-backed long sleeps split at this threshold (architecture.md:245).

### 2.3 Entry kinds (verbatim, `src/types.ts:139-162`)

```typescript
export type EntryKindType =
    | "step"
    | "loop"
    | "sleep"
    | "message"
    | "rollback_checkpoint"
    | "join"
    | "race"
    | "removed";

export type EntryKind =
    | { type: "step"; data: StepEntry }
    | { type: "loop"; data: LoopEntry }
    | { type: "sleep"; data: SleepEntry }
    | { type: "message"; data: MessageEntry }
    | { type: "rollback_checkpoint"; data: RollbackCheckpointEntry }
    | { type: "join"; data: JoinEntry }
    | { type: "race"; data: RaceEntry }
    | { type: "removed"; data: RemovedEntry };
```

Per-kind data shapes (`src/types.ts:69-136`):

```typescript
export interface StepEntry { output?: unknown; error?: string; }
export interface LoopEntry { state: unknown; iteration: number; output?: unknown; }
export interface SleepEntry { deadline: number; state: SleepState; }
// SleepState = "pending" | "completed" | "interrupted"
export interface MessageEntry { name: string; data: unknown; }
export interface RollbackCheckpointEntry { name: string; }
export interface BranchStatus { status: BranchStatusType; output?: unknown; error?: string; }
// BranchStatusType = "pending" | "running" | "completed" | "failed" | "cancelled"
export interface JoinEntry { branches: Record<string, BranchStatus>; }
export interface RaceEntry { winner: string | null; branches: Record<string, BranchStatus>; }
export interface RemovedEntry { originalType: EntryKindType; originalName?: string; }

export interface Entry {
    id: string;          // UUID
    location: Location;
    kind: EntryKind;
    dirty: boolean;      // in-memory only
}
```

Metadata is stored separately and lazy-loaded (`src/types.ts:177-188`):

```typescript
export interface EntryMetadata {
    status: "pending" | "running" | "completed" | "failed" | "exhausted";
    error?: string;
    attempts: number;
    lastAttemptAt: number;
    createdAt: number;
    completedAt?: number;
    rollbackCompletedAt?: number;
    rollbackError?: string;
    dirty: boolean;
}
```

The **`removed` kind is the migration tombstone** — see `src/context.ts:2535-2585`. When a step is deleted from workflow code, the user must call `await ctx.removed("old-step-name", "step")` in the same place. On replay, this either (a) finds the original entry of the original kind and skips (no-op return), or (b) finds an existing `removed` placeholder and skips, or (c) creates a new `removed` placeholder. The `HistoryDivergedError` at line 2569 fires only if the existing entry is *neither* a `removed` *nor* the `originalType` declared at the call site. **This is exactly the primitive Thodare needs for its EditOp `remove` op** (see §8).

### 2.4 The location / NameIndex system

Types (`src/types.ts:1-27`):

```typescript
export type NameIndex = number;
export type PathSegment = NameIndex | LoopIterationMarker;
export interface LoopIterationMarker { loop: NameIndex; iteration: number; }
export type Location = PathSegment[];
```

Operations (`src/location.ts:22-87`):
- `registerName(storage, name) → NameIndex` — interns (returns existing index if seen).
- `appendName(storage, location, name) → Location` — registers + appends.
- `appendLoopIteration(storage, location, loopName, iteration) → Location` — appends a `{loop, iteration}` marker.
- `locationToKey(storage, location) → string` — produces the human-readable form like `"parallel/x/work"` or `"outer/~0/inner"` (numeric segments resolve via the registry; loop markers render as `~N`).
- `isLocationPrefix(prefix, location) → bool` — used for loop-pruning and replay-boundary search.
- `parentLocation`, `locationsEqual`, `getChildEntries`, `emptyLocation` — supporting ops.

Worked example beyond architecture.md:

Suppose a workflow does:
```typescript
await ctx.step("validate", ...);                                    // name "validate" → idx 0
await ctx.loop({ name: "process", state: 0, run: async (l, s) => {  // "process"   → idx 1
    await l.step("fetch", ...);                                      // "fetch"     → idx 2
    await l.join("publish", {                                        // "publish"   → idx 3
        primary: { run: async (b) => await b.step("send", ...) },    // "primary"   → idx 4, "send" → idx 5
        mirror:  { run: async (b) => await b.step("send", ...) },    // "mirror"    → idx 6
    });
    return Loop.continue(s + 1);
}});
```

After 2 loop iterations, the registry is `["validate","process","fetch","publish","primary","send","mirror"]` and the `history.entries` map (each value an `Entry`) is keyed by `locationToKey` strings (per `src/storage.ts:451-463`):

| Key string                                | location (raw)                                  | kind         |
|-------------------------------------------|--------------------------------------------------|--------------|
| `validate`                                | `[0]`                                            | step         |
| `process`                                 | `[1]`                                            | loop         |
| `process/~0/fetch`                        | `[1, {loop:1,iter:0}, 2]`                        | step         |
| `process/~0/publish`                      | `[1, {loop:1,iter:0}, 3]`                        | join         |
| `process/~0/publish/primary/send`         | `[1, {loop:1,iter:0}, 3, 4, 5]`                  | step         |
| `process/~0/publish/mirror/send`          | `[1, {loop:1,iter:0}, 3, 6, 5]`                  | step         |
| `process/~1/fetch`                        | `[1, {loop:1,iter:1}, 2]`                        | step         |
| …                                         | …                                                | …            |

Note the dual reuse: `send` (idx 5) appears in two different parent locations, *and* it's reused across iterations. The numeric-index encoding compresses the on-disk key. The KV encoding (per `src/keys.ts:117-225`) tuples the segment numbers under prefix `2` (HISTORY); a `LoopIterationMarker` segment becomes a nested 2-element tuple `[loopIdx, iteration]` (keys.ts:39-45). This nesting is **load-bearing**: it lets `buildLoopIterationRange` (keys.ts:150-169) build a half-open range over a single loop's iterations, so loop-history pruning is one `deleteRange` call per loop.

### 2.5 Replay model — what's enforced where

The loop in `executeWorkflow` (`src/index.ts:872-1075`) does:

1. `loadStorage(driver)` (`src/storage.ts:137-193`) — list `[1]` for names, sort by index, list `[2]` for history, list `[4]` for metadata, get `[3,1]`/`[3,2]`/`[3,3]` for state/output/error. Builds the in-memory `Storage` from §2.6.
2. Re-runs the workflow function with a `WorkflowContextImpl`.
3. Each `ctx.step("name", fn)` call (`src/context.ts:629…`) checks `storage.history.entries.get(locationToKey(currentLocation + name))`:
   - **Found, kind matches, has output** → return cached output without running `fn` (replay).
   - **Found, kind mismatches** → throw `HistoryDivergedError` (context.ts:511, 589, 803, 1165, 1449, 1537, 1546, 1821, 2025, 2049, 2084, 2240, 2278, 2302, 2332, 2569 — the engine is *paranoid* about divergence, with 16 distinct call-sites).
   - **Found, has error, retries available** → throw `StepFailedError(retryAt)` to schedule the next attempt.
   - **Not found** → execute `fn`, persist the entry on success, persist the metadata.
4. `ctx.sleep` / `ctx.queue.next` either succeed in-line (deadline passed / message present) or throw `SleepError` / `MessageWaitError` to yield. The runner catches these (index.ts:983-1015) and returns `{ state: "sleeping", sleepUntil, waitingForMessages }` after flushing.

**Where determinism breaks:** the engine catches NOTHING about non-determinism *between* steps (e.g., `Math.random()` in plain code outside `ctx.step`). The user is expected to read QUICKSTART.md "Best Practices" §1-9 (lines 449-480) and not do that. The only enforcement is structural: if your second run takes a different *path* through the workflow, the entry-kind mismatch fires `HistoryDivergedError`. This is the same trade-off Temporal makes (Temporal's approach is identical: "you broke determinism, here's a non-deterministic-error").

`assertNotInProgress` / `EntryInProgressError` (`src/errors.ts:163-171`) catches the most common user mistake: forgetting to `await` a step. The engine sets `entryInProgress = true` before each step and bombs if a second one starts.

Loop-history pruning (`src/context.ts:1117-1409`, default interval 20 iterations per `DEFAULT_LOOP_HISTORY_PRUNE_INTERVAL = 20`) deletes old iteration history once the loop state has been persisted at iteration `N`. **Rollback can only replay back to the last retained iteration** (architecture.md:395) — this is a deliberate trade-off: bounded replay cost vs. unbounded rollback depth.

### 2.6 In-memory storage (`src/types.ts:343-354`)

```typescript
export interface Storage {
    nameRegistry: string[];
    flushedNameCount: number;
    history: History;                          // = { entries: Map<string, Entry> }
    entryMetadata: Map<string, EntryMetadata>; // keyed by entryId
    output?: unknown;
    state: WorkflowState;
    flushedState?: WorkflowState;
    error?: WorkflowError;
    flushedError?: WorkflowError;
    flushedOutput?: unknown;
}
```

The `flushedX` fields make the dirty-tracking precise: only changed bytes are written. `flush()` (`src/storage.ts:237-360`) walks `dirty` entries, builds `KVWrite[]`, chunks them under `MAX_KV_BATCH_ENTRIES = 128` and `MAX_KV_BATCH_PAYLOAD_BYTES = 976 KiB` (storage.ts:43-44 — those numbers are **Cloudflare Durable Object KV batch limits**, which is a tell), then issues one `driver.batch()` per chunk.

### 2.7 Storage schema — wire format

Per `architecture.md:236-263` and confirmed in `src/keys.ts:12-26`:

```
[1, index]                              → name registry         (UTF-8 bytes)
[2, ...locationSegments]                → history Entry         (BARE + version envelope)
[3, 1]                                  → workflow state        (UTF-8 enum text)
[3, 2]                                  → workflow output       (CBOR)
[3, 3]                                  → workflow error        (CBOR)
[3, 4]                                  → workflow input        (CBOR)
[4, entryId]                            → EntryMetadata         (BARE + version envelope)
```

Keys are encoded with `fdb-tuple.pack()` (the npm package, `keys.ts:6,98-101`). This gives lexicographic byte ordering for free — required for `list(prefix)` to return entries in deterministic order.

Values are encoded with **two formats stacked**:
- The **outer envelope** is `vbare`'s `createVersionedDataHandler` (`schemas/versioned.ts:34-107`) — a 1-byte version prefix + BARE-encoded body. Currently `CURRENT_VERSION = 1`.
- The **BARE body** is generated from `schemas/v1.bare` (the schema is in this repo at lines 1-204, well-commented) by `scripts/compile-bare.ts`. The compile script (lines 65-126) runs `@bare-ts/tools.transform`, then post-processes the output to (1) replace `@bare-ts/lib` import with `@rivetkit/bare-ts` and (2) strip the Node `assert` import in favor of an inlined assert. **The compile-bare.ts file specifically calls out (line 13) "IMPORTANT: Keep the post-processing logic in sync with engine/packages/runner-protocol/build.rs"** — i.e., the same BARE-→-TS post-processing trick is applied on the Rust side too, for the runner protocol.
- **User-data fields inside BARE structs are CBOR-encoded `data` blobs** (per `schemas/v1.bare:7` `type Cbor data` and references to `Cbor` throughout). So step outputs, loop state, workflow input/output, message bodies are all CBOR. The schema fields are typed-but-opaque from BARE's perspective.

`schemas/serde.ts` is the round-trip layer (610 lines, all conversion code). Worth noting: `WorkflowState` is *not* CBOR — it's just `TextEncoder`-encoded ASCII (serde.ts:506-533). The author optimized away the envelope for a single-byte-class field.

`CLAUDE.md:6-13` flags an important duplication: **the same `v1.bare` schema is mirrored in `rivetkit-typescript/packages/rivetkit/schemas/persist/v1.bare`** for inspector-transport reasons. Keep both in sync.

### 2.8 Error catalog (verbatim shapes from `src/errors.ts:1-172`)

- **User-thrown control-flow:**
  - `CriticalError(message)` — bypass retry, force rollback.
  - `RollbackError(message)` — same; semantically "stop and roll back".
  - `RollbackCheckpointError()` — auto-thrown if rollback fires without prior `ctx.rollbackCheckpoint(name)`.
- **Internal yield errors (caught by runtime, surface as `{state: "sleeping"}`):**
  - `SleepError(deadline, messageNames?)` — sleep until deadline; optionally also wake on named messages.
  - `MessageWaitError(messageNames[])` — pure message wait.
  - `EvictedError()` — graceful shutdown via `handle.evict()`.
  - `RollbackStopError()` — stop rollback traversal at first incomplete-history boundary.
- **Step lifecycle:**
  - `StepFailedError(stepName, originalError, attempts, retryAt)` — internal, triggers retry-after-alarm.
  - `StepExhaustedError(stepName, lastError?)` — terminal after `maxRetries`.
- **Replay/migration:**
  - `HistoryDivergedError(message)` — workflow code changed in incompatible way.
  - `EntryInProgressError()` — user forgot to await previous step.
- **Parallelism:**
  - `JoinError(errors: Record<string, Error>)` — at least one branch failed.
  - `RaceError(message, errors: Array<{name, error}>)` — all branches failed.
  - `CancelledError()` — branch cancelled by race winner.

There is **no separate `TimeoutError` class**; `StepTimeoutError` is defined inside `src/context.ts:113-121` (not exported) and gets repackaged as `StepFailedError` for the retry path.

### 2.9 Workflow run modes — `yield` vs. `live`

`src/types.ts:546` defines `WorkflowRunMode = "yield" | "live"`. The default is `"yield"` (index.ts:606). In yield mode, `runWorkflow` returns a `WorkflowResult` whose `state` is `"sleeping"` if the workflow hit a `SleepError`/`MessageWaitError`; the host scheduler is responsible for waking it up. In **live mode** (used by `ActorWorkflowDriver` via `mode: "live"` in `rivetkit/src/workflow/mod.ts:233`), `executeLiveWorkflow` (index.ts:499-595) loops internally: after each yield it calls `driver.waitForMessages()` and/or its own `waitForSleep()` (which is a `setTimeout`-with-eviction-race), then re-runs `executeWorkflow`. Live mode lets a long-lived actor host avoid round-tripping yields back through scheduler infrastructure.

### 2.10 Known gaps (from `TODO.md:1-83`)

The package's own TODO list:
- Loops as checkpoints (mechanism exists; not yet a first-class API)
- "Caffeination" (keep-actor-awake heuristic) — TODO
- Renaming `listen` → `queue.next`-style handlers — partially done
- "If we modify c.state in the workflow, it should roll back" — state-vs-history sync is incomplete
- "Remove the internal signal queue" — wants to delegate buffering to the actor
- Otel trace-id semantics — TBD
- Migration tests (`run code-a then code-b`) — wanted, not built
- Make steps **ephemeral by default** with opt-in durability — explicit reversal of current default

Pino logger integration is also listed as TODO but appears to be in-flight — `RunWorkflowOptions.logger?: Logger` is wired through (index.ts:608, types.ts:550).

---

## 3. `@rivetkit/rivetkit` — Actor Model & How Workflows Bind In

### 3.1 The `ActorDriver` interface (verbatim, `rivetkit/src/actor/driver.ts:17-141`)

```typescript
export interface ActorDriver {
    loadActor(actorId: string): Promise<AnyActorInstance>;
    getContext(actorId: string): unknown;

    // Batch KV operations (per-actor)
    kvBatchPut(actorId: string, entries: [Uint8Array, Uint8Array][]): Promise<void>;
    kvBatchGet(actorId: string, keys: Uint8Array[]): Promise<(Uint8Array | null)[]>;
    kvBatchDelete(actorId: string, keys: Uint8Array[]): Promise<void>;
    kvDeleteRange(actorId: string, start: Uint8Array, end: Uint8Array): Promise<void>;
    kvListPrefix(actorId: string, prefix: Uint8Array,
                 options?: { reverse?: boolean; limit?: number; }
                ): Promise<[Uint8Array, Uint8Array][]>;
    kvListRange(actorId: string, start: Uint8Array, end: Uint8Array,
                options?: { reverse?: boolean; limit?: number; }
               ): Promise<[Uint8Array, Uint8Array][]>;

    // Schedule
    setAlarm(actor: AnyActorInstance, timestamp: number): Promise<void>;
    cancelAlarm?(actorId: string): void;

    // Optional / experimental
    overrideDrizzleDatabaseClient?(actorId: string): Promise<DrizzleDatabaseClient | undefined>;
    getNativeDatabaseProvider?(): NativeDatabaseProvider | undefined;
    startSleep?(actorId: string): void;
    ackHibernatableWebSocketMessage?(gatewayId: ArrayBuffer, requestId: ArrayBuffer,
                                     serverMessageIndex: number): void;
    startDestroy(actorId: string): void;
    hardCrashActor?(actorId: string): Promise<void>;
    shutdownRunner?(immediate: boolean): Promise<void>;
    serverlessHandleStart?(c: HonoContext): Promise<Response>;
    getExtraActorLogParams?(): Record<string, string>;
    onBeforeActorStart?(actor: AnyStaticActorInstance): Promise<void>;
}
```

This is the lower-level driver. **`ActorDriver` is per-host (one per process); `EngineDriver` is per-workflow (one per actor instance).** The `actor.keys.ts:5-14` namespace uses single-byte prefixes — `WORKFLOW_PREFIX = 0x06` is what makes the per-workflow KV a *sub-namespace* of the per-actor KV. `STORAGE_VERSION.WORKFLOW = 1` (keys.ts:17) is appended after the prefix, giving `[0x06, 0x01, …workflowEngineKey]`.

### 3.2 How the actor `run` function gets workflow superpowers — `rivetkit/src/workflow/mod.ts`

`workflow(fn)` (mod.ts:118-302) wraps the user's workflow function and returns a `run` function suitable for `actor({ run: workflow(async (ctx) => …) })`. Inside `run`:

1. Pulls the actor instance out of `runCtx[ACTOR_CONTEXT_INTERNAL_SYMBOL]` (mod.ts:189-194).
2. Builds an `ActorWorkflowDriver` (`rivetkit/src/workflow/driver.ts:104-231`) and an `ActorWorkflowControlDriver` (lines 254-348). The first is the live driver passed to `runWorkflow`; the second is for replay/inspector ops without going through the actor's awake-keepalive.
3. Calls `runWorkflow(actor.id, …, driver, { mode: "live", logger, onHistoryUpdated, onError })` (mod.ts:228-241).
4. Wires `runCtx.abortSignal` to `handle.evict()` (mod.ts:244-253) so actor sleep/destroy gracefully evicts the workflow.

### 3.3 `ActorWorkflowDriver` — adapter from `EngineDriver` to `ActorDriver` (`rivetkit/src/workflow/driver.ts`)

This is the production reference implementation of `EngineDriver`. It's only ~230 lines and worth understanding in detail because it shows what an adapter actually looks like:

- Every `EngineDriver` KV op is forwarded to the corresponding `ActorDriver.kvBatch*` op, but **prefixed with `makeWorkflowKey(key)`** (driver.ts:121, 130, 138, 145, 169-181). `makeWorkflowKey` (in `actor/keys.ts`) prepends `[0x06, 0x01]` so the workflow's KV namespace is partitioned within the actor's KV namespace — this is where the architecture.md "isolation comes from outside" guarantee lives.
- `batch(writes)` (driver.ts:190-209) does **two things in parallel**: `kvBatchPut` for the workflow KV writes *and* `actor.stateManager.saveState({ immediate: true })`. The comment (lines 193-194): *"Flush actor state together with workflow state to ensure atomicity. If the server crashes after workflow flush, actor state must also be persisted."* This is non-trivial — it means the `EngineDriver.batch()` contract is being *strengthened* by the actor host to include the actor's own user-state. Cloudflare Durable Objects users get this for free because DO transactions span everything; here it's done explicitly.
- `setAlarm(_, wakeAt)` is forwarded to `actor.driver.setAlarm(actor, wakeAt)` — i.e., **the workflow's alarm and the actor's alarm are the same alarm**. This is fine only because one workflow per actor.
- `clearAlarm` is a **no-op** (driver.ts:217-220) — *"No dedicated clear alarm support in actor drivers"*. This is a known limitation; in practice `setAlarm(now)` is used to override.
- `messageDriver` is `ActorWorkflowMessageDriver` (lines 33-102) which delegates to `actor.queueManager.enqueue/receive/completeMessage(s)`. **The workflow engine doesn't store messages itself — they live in the actor's queue.** This is `architecture.md:218-232` ("The workflow engine never stores queue messages in workflow KV") implemented.
- `waitForMessages` is `actor.queueManager.waitForNames(names, abortSignal)` — long-poll on the actor's queue.
- `ActorWorkflowControlDriver` (lines 254-348) is a sibling driver used for `replayWorkflowFromStep` etc. — same KV impl, but doesn't go through `runCtx.internalKeepAwake` and uses a `NoopWorkflowMessageDriver` that throws on any message op (lines 233-252).

### 3.4 Queue mechanics — how `c.queue.iter()` actually works

The `examples/kitchen-sink/src/actors/queue/worker.ts:34` line `for await (const job of c.queue.iter())` is what the user writes. Walking the implementation:

1. `actor({ queues: { jobs: queue<WorkerJob>() }, async run(c) {…} })` declares a typed queue via the schema config (`actor/schema.ts`, type `QueueSchemaConfig`).
2. `c.queue.iter()` lives on the actor's `WorkflowQueue`-like context. In a non-workflow actor (this example) it's served by `actor.queueManager` directly (the same `QueueManager` referenced in `ActorWorkflowMessageDriver`). The QueueManager is owned by `BaseActorInstance` (instance/mod.ts:334, initialized at 784).
3. Messages are persisted under `KEYS.QUEUE_PREFIX = 0x05` plus `STORAGE_VERSION.QUEUE = 1` (actor/keys.ts:5-19). FIFO ordering comes from the `bigint` `id` (the QueueManager assigns monotonically increasing ids).
4. `.iter()` is a long-running async iterator — under the hood it calls `queueManager.receive()` in a loop with `count: 1` until the actor is told to sleep / destroy.
5. **Inside a workflow context**, `ctx.queue.next()` instead goes through `WorkflowContextImpl` (`workflow-engine/src/context.ts:1574-1900`), which records a `MessageEntry` in history so the message consumption is replay-deterministic. The actor-level QueueManager is still the source of truth for pending messages; the workflow engine just remembers which ones it's already consumed (via the `MessageEntry` history with `__rivetWorkflowQueueMessage` marker, context.ts:97).

This split — **the actor queue is the message bus, the workflow engine just records which messages it's processed** — is why `EngineDriver.messageDriver` can be a thin shim. Adopting this pattern in Thodare means: don't store events inside the workflow event log; treat events as an external queue and let the workflow record event-receipt as a history entry.

---

## 4. Rust Engine — What's What

### 4.1 `gasoline` — Rivet's *separate* Rust workflow engine

`gasoline/src/lib.rs:1-19` lays out the modules; `workflow.rs:11-19` is the user-facing `Workflow` trait:

```rust
#[async_trait]
pub trait Workflow {
    type Input: WorkflowInput;
    type Output: Serialize + DeserializeOwned + Debug + Send;
    const NAME: &'static str;
    const PRUNE_VARIANT: PruneVariant;
    async fn run(ctx: &mut WorkflowCtx, input: &Self::Input) -> Result<Self::Output>;
}
```

`activity.rs:11-21` is the matching `Activity` trait (think: a `step` in TS-land, but with `const MAX_RETRIES: usize` and `const TIMEOUT: Duration` baked in at the type level). The semantic mapping to TS-side concepts is approximate but real:

| Gasoline (Rust)      | workflow-engine (TS)        |
|----------------------|------------------------------|
| `Activity`           | `step`                       |
| `Workflow`           | the workflow function itself |
| `SubWorkflow`        | (no direct TS equivalent — listed as future work) |
| `Loop`               | `loop`                       |
| `Sleep`              | `sleep`                      |
| `SignalSend`/`Signals`/`Signal` (deprecated) | `message` |
| `MessageSend`        | (durable cross-workflow message) |
| `Branch`             | branches inside `join`/`race` |
| `Removed`            | `removed`                    |
| `VersionCheck`       | (no TS equivalent — explicit version-pinning event) |

That table is from `gasoline/src/history/event.rs:41-50,89-100`.

The Rust history model uses `Coordinate`s (location.rs) rather than `Location` paths and uses an `EventType` integer enum (FromRepr) for the wire format. The persistence backend is `db::DatabaseKv` — not the TS `EngineDriver`, but a Rust trait `Database` (`gasoline/src/db/mod.rs:23-27`) implemented over `universaldb` (`gasoline/src/db/kv/mod.rs:53-60` shows `DatabaseKv { config, pools, subspace, system }`).

**The Rust gasoline engine is its own thing.** It does NOT call into the TS workflow engine, does NOT share history schema, does NOT share entry kinds (gasoline has `VersionCheck`, `SubWorkflow`, `MessageSend` that TS lacks; TS has `join`/`race`/`rollback_checkpoint` that gasoline lacks). They were independently designed for different runtimes (Rust async vs. JS event-loop).

### 4.2 `workflow-worker` — what it actually is

`workflow-worker/src/lib.rs:1-22` is the entire crate. It composes the registries from pegboard, namespace, epoxy, gasoline-runtime, and datacenter, builds a `gasoline::db::DatabaseKv`, and starts a `gasoline::Worker`. **It is the in-process runner for Rivet's internal control-plane workflows** (the actor scheduler, the runner pool manager, the epoxy coordinator, the namespace operations) — NOT a generic worker for user workflows. End users write actors in TS; their workflows run inside the actor process via `@rivetkit/workflow-engine`, not here.

### 4.3 `pegboard` — actor scheduler implemented as gasoline workflows

`pegboard/src/lib.rs:1-30` registers ~13 gasoline workflows (`actor::Workflow`, `actor2::Workflow`, `runner::Workflow`, `runner2::Workflow`, `runner_pool::Workflow`, several backfill workflows for migrations, and `serverless::receiver::Workflow` / `serverless::conn::Workflow`). The `2` suffix is a versioning convention — `actor2` is the next-gen actor scheduler workflow that runs in parallel with the legacy `actor` workflow (this is how Rivet does workflow-version migrations in production).

`pegboard/src/keys/` includes `actor_kv.rs` — **the per-actor KV layer that user actors write to**. So when a TS actor calls `c.state.x = 42`, it eventually translates to a `pegboard::actor_kv` write through the runner-protocol → engine → universaldb path. `pegboard/src/actor_sqlite.rs` is the optional SQLite-per-actor durability for the `sqlite-drizzle` example pattern.

`pegboard/Cargo.toml` deps include `foundationdb-tuple` (just the codec, see §1.1), `epoxy-protocol`, `rivet-runner-protocol`, `vbare`, `rivetkit-shared-types`. The runner-protocol dep is what lets it speak to TS runners.

### 4.4 `epoxy` — replication / consensus

`epoxy/src/lib.rs:1-23` registers `backfill::Workflow`, `coordinator::Workflow`, `replica::Workflow`. Cargo.toml deps include `epoxy-protocol`, `vbare`, `slog` + `slog-async` + `tracing-slog` (consensus protocols love slog for structured event logging). Reading the directory layout, this is a leader-coordinated state-machine replication system for namespace/datacenter metadata — basically Rivet's homegrown Raft variant. Not a cache. Not a serializer.

### 4.5 `universaldb` — the storage abstraction layer

`universaldb/src/lib.rs:1-25` re-exports the API. Two real backends: `driver/postgres/` and `driver/rocksdb/` (`universaldb/src/driver/`). `foundationdb-tuple` is **only used as a tuple-key encoder**, not as a database. **There is no FoundationDB driver in the open-source tree.** This is the killer fact for the FDB question (§5).

### 4.6 FoundationDB role — answered

Searching every Cargo.toml: `foundationdb-tuple` appears as a dep in `universaldb` (the codec), `pegboard` (which uses tuple keys for its actor scheduler state), and indirectly via `universaldb` re-export. **`foundationdb` (the actual database client) is nowhere in the Cargo.toml workspace.** The only live `Database` impls in `universaldb/src/driver/` are Postgres and RocksDB. The self-host docker-compose (§6) confirms: Postgres only.

So FDB is not in the open-source build path. Rivet's hosted product presumably swaps in an FDB driver behind the same `Database` trait, but that's not in this repo. **`world-rivetkit-engine` can absolutely ship without FDB.** The `fdb-tuple` npm package the TS workflow-engine uses (`workflow-engine/package.json:57`) is a JS port of just the tuple codec — no FDB client, no FDB at all.

---

## 5. The Rust ↔ TypeScript Boundary

There is a wire protocol, and it is not what you'd guess.

**The Rust engine does NOT talk to `@rivetkit/workflow-engine`.** It talks to `@rivetkit/engine-runner`, which is the runner host that owns user actors. The protocol is:

- **Schema:** BARE-encoded, defined in `engine/sdks/schemas/runner-protocol/v{1..7}.bare`. Current version: `PROTOCOL_VERSION = 7` (per `rivetkit-typescript/packages/engine-runner/src/mod.ts:23`). The schemas evolve via vbare's version envelope.
- **Transport:** WebSocket. Confirmed by `engine-runner/src/mod.ts` imports (`import type WebSocket from "ws"`, `Tunnel` from `./tunnel`) and the `pegboardEndpoint`/`pegboardRelayEndpoint` config fields.
- **Direction:** runner connects out to the pegboard-gateway URL (default `:6420`). Once connected, the gateway can push actor lifecycle events (start, stop, KV ops, message delivery, alarms) and the runner streams back state, ack hibernatable WebSocket message indices, etc.
- **Codegen symmetry:** `rivetkit-typescript/packages/workflow-engine/scripts/compile-bare.ts:13` explicitly says: *"Keep the post-processing logic in sync with engine/packages/runner-protocol/build.rs."* Same BARE → TS post-processing trick as the workflow-engine's persistence schema, but the runner-protocol is *also* compiled to Rust on the engine side (`engine/packages/runner-protocol/build.rs`).

So the picture is:
```
[Rust engine: gasoline+pegboard+epoxy on universaldb/Postgres]
        ⇅  BARE-over-WebSocket runner-protocol v7
[TS runner: @rivetkit/engine-runner hosts actors]
        ↳ inside each actor:
              actor() definition with run: workflow(...)
              → @rivetkit/workflow-engine.runWorkflow(..., ActorWorkflowDriver)
              → ActorWorkflowDriver.kvBatchPut → ActorDriver.kvBatchPut
              → /* per-actor KV which goes back over runner-protocol to pegboard */
```

The TS workflow engine's persistence is therefore **routed back to the Rust engine via the runner protocol**, but logically it's just KV — gasoline neither knows nor cares that some of that KV is encoding workflow-engine entries. To gasoline, it's all opaque actor state.

This means: a Thodare adapter could substitute a different `EngineDriver` (Postgres-backed, your own) that *bypasses Rivet's engine entirely*. That's the $0 path.

---

## 6. Self-Host vs. Cloud — Code Split

Looking at `self-host/`:
- `compose/dev/docker-compose.yml:1-243` — services: **clickhouse, prometheus, grafana, postgres, rivet-engine, runner, vector-server, vector-client, otel-collector**. No FoundationDB. No CockroachDB. No NATS in the simple dev compose (NATS appears in `dev-multidc-multinode` and the K8s manifests).
- `compose/dev-multidc-multinode/docker-compose.yml`, `compose/prod-file-system/docker-compose.yml` — similar shape, more replicas.
- `k8s/engine/` — 14 manifests; the storage tier is Postgres (`12-postgres-statefulset.yaml`, `10-postgres-configmap.yaml`, `11-postgres-secret.yaml`, `13-postgres-service.yaml`) + NATS for pub/sub (`07-nats-statefulset.yaml`).

**Everything in this repo is open-source under Apache-2.0.** There is no obvious "cloud-only" carve-out — no `// @license-cloud` markers, no separate proprietary modules. What you don't get in the OSS tree:

- A working FoundationDB driver (the trait exists, the impl doesn't).
- The hosted multi-region routing logic (likely lives in `pegboard-gateway2` and is partially open).
- Any commercial-license SaaS account/billing code.

The Rust engine binary, the TS rivetkit framework, the workflow engine, the runner, the inspector, the dev tools — all open-source. Anyone can self-host the whole thing on Postgres.

---

## 7. Top 10 Surprises

1. **Rivet has TWO durable workflow engines, and they don't talk.** Rust `gasoline` for internal control plane; TS `@rivetkit/workflow-engine` for user code. Different schemas, different concepts, different lifecycles. Most reviewers assume one wraps the other; neither does.
2. **No FoundationDB in the OSS tree.** `foundationdb-tuple` is a key-encoding library; the actual FDB client crate is not a dep anywhere. Self-host runs on Postgres.
3. **`@rivetkit/workflow-engine` has no workflow-id parameter on KV ops.** It assumes per-instance isolation is provided externally. This makes the driver interface 11 methods instead of 22, but it also means **you can never share a KV namespace between two workflows** without writing your own prefixing layer — the host has to do it (as `ActorWorkflowDriver.makeWorkflowKey` does with `[0x06, 0x01, …]`).
4. **The workflow engine never stores queue messages.** Messages live in the actor's queue manager. The workflow engine only records `MessageEntry` history of which messages it consumed. This is a **deliberate decoupling** — the workflow engine doesn't need a queue, just a record of what it pulled.
5. **`removed` is a first-class entry kind, not a metadata flag.** Migration is a structural primitive (`ctx.removed("name", "step")`). The TS engine validates that the existing entry on disk is either a `removed` placeholder OR the original kind (`context.ts:2563-2572`), then no-ops. **This is the right shape for Thodare's EditOp `remove`.**
6. **Workflow input is persisted on first run and used for all replays** (`index.ts:907-921`). If you restart with different input, you get the original input back. No way to "fix" a bad input mid-workflow other than `replayWorkflowFromStep`.
7. **The KV batch limits `MAX_KV_BATCH_ENTRIES = 128` and `MAX_KV_BATCH_PAYLOAD_BYTES = 976 KiB`** (`storage.ts:43-44`) are **Cloudflare Durable Objects' limits**. The chunking is built into the engine even though the default driver isn't DO. Tells you the engine was designed with DO as a primary target host.
8. **The wire format is BARE+CBOR, not JSON.** `vbare` envelope (1-byte version) wraps a BARE struct whose user-data fields are CBOR blobs. `WorkflowState` skips the envelope and is just UTF-8 enum text. **Three serialization formats stacked.** This is fast and compact but inspector-unfriendly.
9. **Rollback is checkpointed and bounded.** `ctx.rollbackCheckpoint(name)` must be called *before* any rollback-eligible step; rollback can only walk back to the most recent retained loop iteration (loop history pruning erases older iterations). This is the opposite of Temporal's "we can replay forever" approach — Rivet trades unbounded rollback for bounded storage.
10. **The Rust engine ships its own internal workflow-version migration mechanism** as parallel workflow definitions: `actor::Workflow` + `actor2::Workflow`, `runner::Workflow` + `runner2::Workflow`, `runner_pool::Workflow` + `runner_pool2_backfill::Workflow`. There's no clever "schema evolution" framework — they just write the new workflow next to the old, run the backfill, and delete the old. **This is the same playbook Thodare should use for its own internal workflows.**

Bonus 11: `entryInProgress` enforcement is real. If you forget `await` on a `ctx.step`, the next call throws `EntryInProgressError` with a human-readable hint (`errors.ts:163-171`). This catches the #1 user mistake in pretty much every durable-execution library.

---

## 8. Implications for Thodare

### 8.1 Is `@rivetkit/workflow-engine` a peer to `@thodare/openworkflow`?

**Yes — structurally peer-shaped, but with a different contract.** Both are "the user writes async functions; we record an event log; we replay on resume." Both expose a context object with step/loop/sleep/wait-event/parallel primitives. Both want the host to provide isolation + persistence + scheduling.

The mismatches:
- **Storage model:** `@rivetkit/workflow-engine` is **KV-only**; openworkflow assumes Postgres event-log + materialized views. Adapting requires implementing `EngineDriver` over Postgres (perfectly possible — sorted prefix scans, atomic batch writes, alarms-as-rows with a poller; Rivet themselves have a Postgres-backed `universaldb` driver that serves a similar purpose for their Rust side).
- **Per-instance isolation:** `EngineDriver` has no `workflow_id` parameter, so a Postgres driver needs to either (a) one schema per workflow (terrible) or (b) prefix every key with `workflow_id` internally and ignore the architecture-doc claim of external isolation. Path (b) is what you want — wrap a single shared Postgres connection pool, prefix keys with the workflow id, expose per-workflow `EngineDriver` objects that share the underlying pool.
- **Materialized views:** workflow-engine has `WorkflowHistorySnapshot` (`types.ts:279-283`) for inspectors. Thodare wants per-run timelines, per-step durations, per-event traces. The `onHistoryUpdated` hook (`types.ts:551`) gives you a callback after every flush — wire that into your Postgres timeline tables.

### 8.2 Could it really be a Thodare backend?

**Yes, with three caveats.**

1. **You buy into KV semantics.** Steps store opaque CBOR blobs; you can't `SELECT step.output → 'amount' FROM ...` natively. Either you mirror the structured fields into Postgres yourself in the `onHistoryUpdated` callback, or you accept that introspection is "decode the CBOR blob in app-land."
2. **You buy into the Rivet entry-kind set.** No native `human_approval` — model it as `ctx.queue.next("approval", { names: ["approve", "reject"] })`. No native `compute` distinct from `step` — model it as an `ephemeral: true` step. No native `wait_for_event` distinct from `message` — same wire underneath.
3. **You give up surface control of replay rules.** Rivet enforces history match by entry-kind + location; if Thodare's runtime walker today does richer determinism checks (e.g., hash of step input matches), you'd need to layer that on top via `onError`/`onHistoryUpdated` — but you can't override Rivet's `HistoryDivergedError` semantics.

### 8.3 Primitives Thodare should lift verbatim

1. **The `removed` entry kind.** Adopt it 1:1. When Thodare's EditOp `remove(stepName)` lands on a graph that has in-flight runs, **insert a `removed` tombstone in their event log** so replays can advance past the deleted step without history divergence. The semantics in `context.ts:2547-2585` are exactly right: accept a tombstone OR the original kind, write a tombstone if neither found, throw `HistoryDivergedError` only on actual mismatch. **This is the single biggest design lift available.**
2. **Location as `(NameIndex | LoopIterationMarker)[]` with a per-run name registry.** Even if you don't compress with NameIndex (your event log is in Postgres rows, not bytes-tight KV), the structural insight — that locations are paths through a tree with named branches and numeric loop-iteration markers — is worth adopting. It makes prefix queries (loop-pruning, branch-cancellation) trivial.
3. **Per-instance isolated KV / event log.** Don't push workflow-id into every primary key. Use one schema/namespace per logical run; let your driver assume single-writer per namespace. This dramatically simplifies the API surface and makes future driver swaps (Cloudflare DO, sqlite-per-actor, etc.) viable.
4. **The `onHistoryUpdated` callback hook** for materialized-view fan-out. Don't re-derive views from the event log — push them as the engine writes. This is what powers Rivet's inspector and would power Thodare's run-timeline UI.
5. **Three-layer serialization stacking** (envelope-version + structured-schema + opaque-CBOR-fields). You're already on Postgres so you'd use jsonb instead of CBOR, but the pattern of "version envelope around schema with arbitrary blob fields" is worth keeping. It makes schema evolution a non-event.
6. **Workflow input persisted on first run** (`index.ts:907-921`). Trivial but easy to forget. Makes `recover()`/replay-from-step deterministic.
7. **`recover()` semantics** (`index.ts:661-715`): walk all entry-metadata, flip `failed`/`exhausted` to `pending`, clear retry counters, clear workflow-error, re-arm alarm. Map exactly to Thodare's "retry exhausted run" admin action.
8. **`replayWorkflowFromStep(workflowId, driver, entryId?)` (`index.ts:755-841`).** Surgical replay-from-entry. Walk back to the enclosing loop-boundary, delete history below that, reset state to `sleeping`, schedule alarm. This is **exactly** what Thodare needs for "rerun from step X."

### 8.4 Primitives to deliberately reject

1. **Live mode driving its own sleep timer with `setTimeout`** (`index.ts:457-497`). Fine for a JS actor host; wrong for Thodare's centralized scheduler. Always use yield mode + an external alarm/poller.
2. **Loop history pruning by interval** (default 20). Useful in KV-byte-counted storage; in Postgres with cheap rows, you probably want full history retention by default with optional pruning. Don't carry the `historyPruneInterval` defaults forward.
3. **Pino logger as a parameter** (`types.ts:550`). Thodare should use its own observability stack; pin a no-op logger when wrapping.
4. **`workerPollInterval` exposed on the driver interface** (`driver.ts:95`). This is a CF-DO-style "alarm precision" leak — your Postgres driver should either always go through `setAlarm` (no in-memory short-sleep) or expose precision differently.
5. **CBOR for blobs.** You're on Postgres; jsonb is more inspectable and indexable. Lose the BARE+CBOR stack.
6. **The fdb-tuple key encoder.** Use BIGINT primary keys + B-tree indexes. The fdb-tuple cleverness is overkill on Postgres.

### 8.5 What `world-rivetkit-engine` actually looks like

If you ship the deferred adapter, the realistic shape is:

**Surface:** `world-rivetkit-engine` exports a `RivetkitWorld` that implements Thodare's `World` interface (whatever that ends up being). Internally it composes:
- An `EngineDriver` over Thodare's storage (Postgres or whatever you settle on). This is the bulk of the work — ~400-600 LOC of clean Postgres queries that happen to fit Rivet's `EngineDriver` shape.
- A thin shim that translates Thodare's primitives (trigger / compute / wait_duration / wait_for_event / human_approval) into `WorkflowContextInterface` calls.

**Dependencies:**
- `@rivetkit/workflow-engine` (peer-dep on `^2.x`)
- `cbor-x`, `fdb-tuple`, `vbare`, `@rivetkit/bare-ts` (transitively required)
- Thodare's Postgres pool

That's it. **No Rivet engine binary, no pegboard, no gasoline, no FDB, no docker-compose.** The adapter lives entirely inside Thodare's process.

**Capability flags** (what `world-rivetkit-engine` can/cannot do):
- ✅ Steps, loops, sleeps, signals (messages), join, race, rollback, rollback-checkpoint
- ✅ Migrations via `removed` entry
- ✅ Replay-from-step
- ✅ Recover-failed
- ⚠️ Cross-workflow messaging — possible but not native; you'd model child workflows as queue messages
- ⚠️ Workflow versioning — Rivet's TS engine has `HistoryDivergedError` but no first-class `VersionCheck` event (the Rust gasoline engine has it; the TS engine doesn't); Thodare would have to layer this on
- ❌ Native distributed sub-workflows — not in the TS engine
- ❌ Anything involving the Rivet engine binary (you're not running it)

**Primitive map** (Thodare → Rivet):
| Thodare | Rivet equivalent |
|---|---|
| `trigger` (start a run) | `runWorkflow(id, fn, input, driver)` |
| `compute` / pure step | `ctx.step(name, async () => …)` |
| `compute` with retries | `ctx.step({ name, run, maxRetries, retryBackoffBase, retryBackoffMax, timeout })` |
| `wait_duration` | `ctx.sleep(name, durationMs)` or `ctx.sleepUntil` |
| `wait_for_event` | `ctx.queue.next(name, { names: ["evt"] })` + queue plumbing |
| `human_approval` | `ctx.queue.next(name, { names: ["approve","reject"] })` then branch on result |
| `parallel_all` | `ctx.join(name, { a: {run}, b: {run} })` |
| `parallel_first` | `ctx.race(name, [{name,run}, …])` |
| `loop` (foreach, while) | `ctx.loop({ name, state, run })` with `Loop.continue/break` |
| EditOp `remove` (graph migration) | `ctx.removed(name, originalType)` |
| Run cancel | `handle.cancel()` |
| Run pause / evict | `handle.evict()` |
| Run resume from step | `replayWorkflowFromStep(id, driver, entryId)` |
| Run retry-exhausted | `handle.recover()` |

The 1-to-1 coverage is genuinely tight. The places it leaks are: per-step structured-output querying (CBOR blob), versioning-as-a-first-class-citizen, and anything cross-workflow.

### 8.6 Is Rivet a peer to openworkflow, or a different shape?

**Peer-shaped, contract-different.** Both are "durable async-function executor." Both have steps + sleeps + signals + parallel + loops. The differences are at the contract layer:

- **Storage shape:** Rivet ⇒ KV; openworkflow (per Thodare's design) ⇒ Postgres event log.
- **Isolation model:** Rivet ⇒ external (per-instance namespace); openworkflow ⇒ central (multi-tenant tables).
- **Migration model:** Rivet ⇒ `removed` entries + `replayWorkflowFromStep`; openworkflow ⇒ EditOps (probably similar).
- **Versioning:** Rivet TS ⇒ implicit (`HistoryDivergedError`); openworkflow ⇒ likely explicit version pins.
- **Cross-workflow:** Rivet TS ⇒ via queue messages only; openworkflow ⇒ likely first-class.

So `world-rivetkit-engine` is a **legitimate adapter target**, not a mis-shaped peg. The work isn't huge (~1-2 weeks for a competent TS dev to write the Postgres `EngineDriver` + the primitive shim + tests). The maintenance burden is real (you're tracking `@rivetkit/workflow-engine`'s API, which is in 2.x release-candidate territory and still has ~10 entries on its TODO.md as of this review). For Thodare's value prop ("self-hostable, headless workflow orchestration"), the adapter buys you optionality without forcing you onto Rivet's Rust engine, FDB, or hosted service.

---

## Executive Summary

Rivet is two distinct durable-execution implementations stitched together: a Rust engine (`gasoline` + `pegboard` + `epoxy` + `universaldb` + `workflow-worker`) that runs Rivet's own control-plane workflows on Postgres-or-RocksDB-or-FDB-flavored KV, and a separate TypeScript library `@rivetkit/workflow-engine` (~3K LOC, 11-method `EngineDriver` interface, 8 entry kinds) that user actors host inside their own process for application-level workflows. They share concepts but no code, no schema, no protocol — they connect only at a wire boundary (`runner-protocol` over BARE-encoded WebSocket, `PROTOCOL_VERSION = 7`) where the Rust engine treats the TS engine's persisted bytes as opaque actor KV.

For Thodare, the relevant artifact is `@rivetkit/workflow-engine` alone. It is genuinely peer-shaped to `@thodare/openworkflow` — same problem (durable async functions), same primitives (step, loop, sleep, message, join, race, rollback, removed), same architectural insight (replay from history). The contract differences are storage (KV vs. event-log), isolation (external vs. central), and inspectability (CBOR blobs vs. structured rows). A `world-rivetkit-engine` adapter is realistic: implement `EngineDriver` over Thodare's Postgres, write a thin shim mapping Thodare primitives to `WorkflowContextInterface`, ship as a peer-dep package — no Rivet binary, no FoundationDB, no docker-compose required. There is **no FDB in the open-source tree**; self-host runs on Postgres + NATS.

The biggest verbatim lift Thodare should take from Rivet is **the `removed` entry kind** (`src/context.ts:2535-2585`) for graph-migration tombstones — exactly the semantics Thodare's EditOp `remove` needs. Also lift: per-instance isolated KV, location-as-NameIndex-paths, `onHistoryUpdated` callback fan-out, `replayWorkflowFromStep` semantics, and the `recover()` admin op. Reject: KV-byte-budget tuning (CF-DO heritage), CBOR blob storage, exposed `workerPollInterval`, live-mode in-process sleep timing.

Report file: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/rivet.md`
