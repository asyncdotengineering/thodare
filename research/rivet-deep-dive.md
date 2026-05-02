# Rivet — actors, queues, workflows

**Source:** `rivet-gg/rivet` (cloned shallow to `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/rivet/`).
**Lens:** Could Rivet be a Thodare World? Could Thodare adopt any of Rivet's primitives or patterns?

> Note: written from direct source-tree exploration after the auto-research agent stalled mid-grep. Tighter than the other research files; depth focused on the parts that materially change the World abstraction proposal.

---

## 1. What Rivet is, in one paragraph

Rivet is a **two-stack project**: a Rust **engine** (`engine/packages/`, ~80 crates including `engine`, `pegboard`, `gasoline`, `epoxy`, `workflow-worker`, `guard`) and a TypeScript **rivetkit** runtime (`rivetkit-typescript/packages/`, ~13 packages). The engine talks to **FoundationDB** as the primary durability substrate (`foundationdb-tuple` in `engine/packages/pegboard/Cargo.toml:18` confirms it). The pitch is **stateful actors as the primitive** — long-running, lightweight, in-memory state with automatic persistence — with workflows, queues, scheduling, and websockets layered on top of the actor model. Apache-2.0.

This is a *different shape of compute* from Thodare. Thodare's workflows are **stateless code over a JSON DAG**; Rivet's actors are **stateful processes addressed by id**. The two models intersect at the workflow primitive — Rivet ships a separate `@rivetkit/workflow-engine` npm package that's directly comparable to `@thodare/openworkflow`.

---

## 2. The actor primitive

From the README example (verbatim):

```typescript
const agent = actor({
  state: { messages: [] as Message[] },                 // in-memory, auto-persisted
  run: async (c) => {
    for await (const msg of c.queue.iter()) {           // queue lives ON the actor
      c.state.messages.push({ role: "user", content: msg.body.text });
      const response = streamText({ model: openai("gpt-5"), messages: c.state.messages });
      for await (const delta of response.textStream) {
        c.broadcast("token", delta);                    // realtime broadcast to clients
      }
      c.state.messages.push({ role: "assistant", content: await response.text });
    }
  },
});
```

**Shape:**
- Actor is defined as `{ state, run }`. State is plain mutable JS, persisted automatically.
- One actor instance per id; client addresses with `client.agent.getOrCreate("agent-123")`.
- Inputs arrive on `c.queue.iter()` — a per-actor message queue, async-iterable.
- Outputs go to `c.broadcast(event, payload)` — fan-out to all connected clients.
- `c.state` is the source of truth; the runtime persists it via `ActorDriver.kvBatchPut` after mutations.

**`ActorDriver` interface** (`rivetkit-typescript/packages/rivetkit/src/actor/driver.ts:17`) is what Rivet exposes for backend pluggability at the actor layer:

```ts
interface ActorDriver {
  loadActor(actorId: string): Promise<AnyActorInstance>;
  getContext(actorId: string): unknown;

  kvBatchPut(actorId, entries: [Uint8Array, Uint8Array][]): Promise<void>;
  kvBatchGet(actorId, keys: Uint8Array[]): Promise<(Uint8Array|null)[]>;
  kvBatchDelete(actorId, keys: Uint8Array[]): Promise<void>;
  kvDeleteRange(actorId, start, end): Promise<void>;
  kvListPrefix(actorId, prefix, opts?): Promise<[key, value][]>;
  kvListRange(actorId, start, end, opts?): Promise<[key, value][]>;

  setAlarm(actor, timestamp): Promise<void>;
  cancelAlarm?(actorId): void;

  overrideDrizzleDatabaseClient?(actorId): Promise<DrizzleDatabaseClient|undefined>;  // experimental
  getNativeDatabaseProvider?(): NativeDatabaseProvider | undefined;                   // experimental
  startSleep?(actorId): void;
  // ... a few more for hibernation/eviction
}
```

This is a cleaner driver contract than openworkflow exposes. The KV is per-actor (no actorId in keys), so the driver only needs prefix-isolated KV semantics — easy to implement on FoundationDB, on Postgres, on a Durable Object, on disk. Worth studying as a pattern.

---

## 3. The workflow primitive — `@rivetkit/workflow-engine`

A **separate** Apache-2.0 npm package (`rivetkit-typescript/packages/workflow-engine/package.json:1` — version `2.3.0-rc.4`, "Durable workflow engine with reentrant execution").

`packages/workflow-engine/architecture.md` is unusually candid; the highlights:

### Isolation model

> "Each workflow instance operates on an isolated KV namespace … the host system (e.g., Cloudflare Durable Objects, dedicated actor processes) provides the isolation boundary."

That is the same architectural insight Cloudflare's `dynamic-workflows` library shipped on 2026-05-01 — and the same one Thodare's T5 (one generic runtime workflow) bakes in. **Three independent codebases converging on "durable workflow runtime + per-instance isolated KV namespace + external dispatcher."**

### `EngineDriver` (the abstraction the engine actually depends on)

```ts
interface EngineDriver {
  get(key: Uint8Array): Promise<Uint8Array | null>;
  set(key, value): Promise<void>;
  delete(key): Promise<void>;
  deletePrefix(prefix): Promise<void>;
  deleteRange(start, end): Promise<void>;
  // + list, batch, alarms
}
```

**This is the smallest substrate interface I've seen for a durable execution engine.** Five reads, four writes (incl. batch/alarm), prefix isolation, sorted lex order. Implementable on Postgres + a single bytea-keyed table, on FoundationDB natively, on a Durable Object, on RocksDB, on a remote KV. The engine itself doesn't know which.

### Entry types — the workflow vocabulary

| Entry | Purpose |
|---|---|
| `step` | Execute arbitrary async code |
| `loop` | Iterate with durable state |
| `sleep` | Wait for a duration or timestamp |
| `message` | Wait for external events |
| `join` | Execute branches in parallel, wait for all |
| `race` | Execute branches in parallel, first wins |
| `removed` | Placeholder for migrated-away entries |

`removed` is a nice migration affordance — older versions of a workflow that referenced an entry that no longer exists can still replay safely.

### Location system — name-indexed paths

Each entry is identified by a **location** = path through the execution tree, encoded as numeric indices into a per-workflow `nameRegistry: string[]`. So `step("a"); step("b")` becomes `Location[0], Location[1]` and the strings live once. Reduces storage and replay cost when the same names appear many times (loops, recursion). `WorkflowEntryMetadataSnapshot` + `WorkflowHistorySnapshot` are the wire shapes.

### Replay model

Standard event-sourcing. `runWorkflow()` calls `loadStorage()` (driver KV scan), then re-runs the workflow function. Each `ctx.step("name", async () => ...)` checks history first; if found with output, returns immediately without invoking the callback. Determinism is the user's responsibility (same as Temporal, Cloudflare Workflows, WDK).

---

## 4. Queues

There is **no separate queue primitive** as far as I traced. Queues are a per-actor capability surfaced via `c.queue.iter()` / `agent.queue.send(...)`. The actor's KV holds the queue's tail; messages are appended by external `WorkflowHandle.message()` (architecture.md:44 — "Messages are delegated to the runtime message driver, then read with `messageDriver.receiveMessages()` during execution"). FIFO ordering relies on the driver's lex-sorted list contract.

This means Rivet doesn't have a "deferred jobs" primitive in the Quirrel sense. If you want a job queue, you make an actor that does `for await (const job of c.queue.iter()) { ... }`. Same primitive, different shape.

---

## 5. Storage substrate

The Rust engine uses **FoundationDB** (`engine/packages/pegboard/Cargo.toml:18`: `foundationdb-tuple.workspace = true`). FDB gives Rivet:
- ACID transactions across keys (the bedrock of correctness)
- Lexicographic key ordering (drives the `EngineDriver` contract)
- Per-key versionstamps (used for ordering + dedup)
- Operationally heavy to self-host — usually 3+ machines minimum.

For self-host on a single box, Rivet's TypeScript stack supports SQLite via `better-sqlite3` (`pnpm-workspace.yaml:25`), and the workflow-engine's `EngineDriver` is small enough that any KV works.

This is a **two-tier deploy story**: FoundationDB for the cloud / serious self-host, SQLite for development. Cleaner than Thodare's current "Postgres or bust."

---

## 6. Deployment model

- **Rivet Cloud** — managed; the Rust engine runs there, you ship actor/workflow code via the SDK.
- **Rivet self-host** — Docker Compose template at `self-host/compose/template/`, Caddy + the engine. FDB is the production durability story.
- **`@rivetkit/workflow-engine`** as an npm package — embeddable. You bring your own `EngineDriver`. This is the part Thodare can lift directly.

**License:** Apache-2.0 throughout. Compatible with Thodare's MIT workspace via `NOTICE` (per T19).

---

## 7. Lessons for Thodare

### Steal these

1. **`EngineDriver` interface as the storage port.** Five-method KV contract is the smallest substrate Thodare could possibly require. If Thodare ever ships its own native runtime (Alternative A in the interface design scratch), this is the shape to copy. Even if it doesn't, the lesson — *don't model storage as event log + materialized views, model it as prefix-isolated KV* — informs the World abstraction. (WDK does the opposite and pays for it with ~30 methods.)

2. **`removed` entry kind.** Migration affordance. When Thodare patches a workflow JSON via `EditOp` and a block disappears mid-run, the block id should leave a tombstone so replay doesn't fail. Adopt this idea in `SerializedBlock` semantics (e.g., a `block.tombstone?: true` flag) for in-flight runs.

3. **Per-instance isolated KV namespace + external dispatcher.** This is the same pattern Thodare's T5 + CF dynamic-workflows + Rivet workflow-engine all converge on. Lock it into the proposal as a first-class architectural assumption.

4. **Two-tier deploy story.** SQLite for `thodare dev`, Postgres/FDB/CF for `thodare deploy`. Same primitives; different drivers. Mirrors what `world-local` vs. `world-postgres` is in WDK.

5. **Async-iterable queue handle on the run itself.** `c.queue.iter()` is more ergonomic than imperative `step.waitForSignal({ name, signalName })`. If Thodare ever exposes a "wait for many messages" pattern (drip campaigns, batch collectors), the iter shape is the right surface — not "one signal at a time."

### Don't adopt

1. **Actor-as-primitive.** Thodare's bet is the JSON+EditOp surface; actors are a different shape of compute. Adding actors as a first-class concept doubles the surface area for ~5% of additional value at this stage. Note in the proposal that `world-rivet` is *plausible*, not *strategic*.

2. **FoundationDB requirement.** Operationally too heavy for v1 self-host. Postgres is the right default; FDB-via-Rivet is a future "high-scale" adapter, not a baseline.

### Could Rivet be a Thodare World?

**Yes, two ways:**

- **`@thodare/world-rivetkit-workflow-engine`** — wrap Rivet's `@rivetkit/workflow-engine` npm package. Implement the Thodare `WorldDispatcher` interface in terms of `runWorkflow`/`ctx.step`/`ctx.sleep`/`ctx.queue`. Bring your own `EngineDriver`. This works on Lambda, on Cloudflare DO, on a Postgres-backed driver — anywhere Rivet's engine runs. **Strong candidate** for the embedded-substrate adapter.
- **`@thodare/world-rivet-cloud`** — push to managed Rivet Cloud. Closer to a SaaS adapter than an embedded runtime. Skip in v0.2; revisit if there's user demand.

### Could Thodare's surface sit on top of Rivet?

Topologically yes. Thodare's runtime walker would become a Rivet actor whose `run(c)` reads `SerializedWorkflow` from `c.state.workflow` and dispatches blocks. But this is conceptually backwards — Thodare's value is the patch loop + multi-tenant API + JSON DSL, not the runtime — so adapting Thodare *to be a Rivet client* is the wrong direction. Adapting Rivet to be a Thodare backend is the correct direction (the World adapter pattern).

---

## 8. Citations

- `engine/packages/pegboard/Cargo.toml:18` — FoundationDB dependency
- `rivetkit-typescript/packages/workflow-engine/package.json:1` — `@rivetkit/workflow-engine@2.3.0-rc.4`, Apache-2.0
- `rivetkit-typescript/packages/workflow-engine/architecture.md:14-56` — Isolation Model
- `rivetkit-typescript/packages/workflow-engine/architecture.md:90-99` — Entry types table
- `rivetkit-typescript/packages/workflow-engine/architecture.md:104-130` — Location system
- `rivetkit-typescript/packages/workflow-engine/architecture.md:177-200` — Replay model
- `rivetkit-typescript/packages/workflow-engine/src/driver.ts:33` — `EngineDriver` interface
- `rivetkit-typescript/packages/rivetkit/src/actor/driver.ts:17` — `ActorDriver` interface
- `pnpm-workspace.yaml:25` — `better-sqlite3` workspace dependency
- `Cargo.toml` — Rust workspace member layout (~80 crates)
- `README.md:24-50` — Actor primitive example (queue.iter / state / broadcast)
