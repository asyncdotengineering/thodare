# Interface design scratch — three alternatives

## Coupling map (the seam to abstract)

After grepping `packages/engine/src/runner/*` and `packages/api/src/runtime-host.ts`, the openworkflow surface Thodare actually uses is small and well-bounded:

**From `@thodare/openworkflow`:**
- `OpenWorkflow` class — constructed with a `Backend`
  - `.defineWorkflow({ name }, async ({ input, step }) => {...})` — register a handler
  - `.newWorker({ concurrency })` — start the polling loop
  - The returned compiled handle has `.run(input, opts?)` → `WorkflowRunHandle`
- `WorkflowRunHandle` — `.id`, `.result(opts?)`, `.cancel()`
- `Backend` (`BackendPostgres` / `BackendSqlite`) — `.connect()`, `.stop()`
  - `.getWorkflowRun({ workflowRunId })`
  - `.cancelWorkflowRun({ workflowRunId })`

**Inside the orchestrator (the `step` parameter):**
- `step.run({ name }, async () => result)` — memoized, idempotent on replay
- `step.sleep(name, "60s")` — durable timed wait
- `step.waitForSignal({ name, signalName, timeoutMs })` — durable named-signal wait

**Already abstracted (good news):**
- `runner/walk.ts` takes `step: any` — the walker doesn't import openworkflow at all. Half the seam is already built.
- `tools/waits.ts` returns `PauseInfo` sentinels — backend-agnostic.
- `runner/cron.ts` takes a `runWorkflow` callback — already pluggable.

**The actual coupled files:**
- `client.ts` (createWfkit) — owns `OpenWorkflow` + `Backend` + worker lifecycle
- `runner/openworkflow.ts` (326 LOC) — calls `ow.defineWorkflow`
- `runner/runtime-workflow.ts` (90 LOC) — same
- `runner/handle.ts` (148 LOC) — calls `backend.getWorkflowRun` / `cancelWorkflowRun`

Everything else is engine-pure.

---

## Alternative A — "Thick World" (WDK-shaped)

Mirror Vercel's WDK contract. Thodare owns the runtime; the World owns storage, queue, streaming, lifecycle.

```ts
interface ThodareWorld extends Queue, Storage, Streamer {
  specVersion?: number;
  start?(): Promise<void>;
  close?(): Promise<void>;
}

interface Storage {
  runs: { get, list };           // read-only
  steps: { get, list };
  hooks: { get, getByToken, list };
  events: { create, get, list, listByCorrelationId }; // ONLY mutation
}

interface Queue {
  queue(name, payload, opts): Promise<{ messageId }>;
  createQueueHandler(prefix, handler): (req: Request) => Promise<Response>;
  getDeploymentId(): Promise<string>;
}

interface Streamer {
  streams: { write, close, get, list, getChunks, getInfo };
}
```

Surface: ~30 methods.

**Pros:** Total control over durability semantics. Can guarantee identical behavior across backends. Future-proof.

**Cons:** Massive scope. Thodare doesn't own a runtime today — it delegates to openworkflow. Adopting A means **building Thodare's own replay-deterministic orchestrator**, vm-sandbox semantics, event-sourcing storage, etc. That's a quarter of work, easy. And it competes head-on with WDK without a clear differentiator beyond the JSON+EditOp surface.

---

## Alternative B — "Thin DurableExecutionAdapter" (wrap an engine)

Treat any **durable execution engine that already exists** (openworkflow, WDK, Inngest, Temporal, CF Workflows, Rivet) as a peer, and abstract over their common shape.

```ts
interface ThodareWorld {
  readonly id: string;                       // "openworkflow-pg" | "wdk-vercel" | "cloudflare" | ...
  readonly capabilities: WorldCapabilities;  // see below

  // Workflow lifecycle (orchestrator-side)
  defineWorkflow(spec: WorkflowSpec, handler: ThodareHandler): Promise<RegisteredWorkflow>;
  runWorkflow(name: string, input: unknown, opts?: RunOpts): Promise<RunHandle>;
  signal(runId: string, signalName: string, payload?: unknown): Promise<void>;

  // Run inspection (sync + reactive)
  getRun(runId: string): Promise<RunDescription | null>;
  listRuns(filter?: RunFilter, page?: Page): Promise<RunPage>;
  cancel(runId: string): Promise<void>;

  // Lifecycle
  start(opts?: { concurrency?: number }): Promise<void>;
  stop(): Promise<void>;
}

// What the orchestrator function receives — the step API is itself abstract
type ThodareHandler = (ctx: ThodareCtx) => Promise<unknown>;

interface ThodareCtx {
  input: unknown;
  step: ThodareStep;
  runId: string;
  signal: AbortSignal;        // canceled when the user cancels the run
  log: ThodareLogger;
}

interface ThodareStep {
  // Memoized step — idempotent across replays
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  // Durable sleep
  sleep(name: string, duration: string | number): Promise<void>;
  // Park until a named signal arrives, optionally with a timeout
  waitForSignal<T>(opts: { name: string; signalName: string; timeoutMs?: number }): Promise<T>;
}

// Capability flags — the adapter declares what's possible
interface WorldCapabilities {
  maxStepDurationMs: number;        // 15min for Lambda, 30s for Workers, ∞ for self-host
  maxRunDurationMs: number;         // ∞ for most, but matters for managed
  signalPrecision: "exact" | "best-effort";
  exactlyOnceSteps: boolean;        // true for openworkflow + WDK, false for some queues
  serverless: boolean;              // true for cf/lambda; false for self-host
  supportsHooks: boolean;
  supportsStreams: boolean;
  pricingModel: "self-host" | "per-invocation" | "per-second";
}
```

Surface: ~10 methods + the step shim.

**Pros:**
- Thodare's value (JSON DSL + EditOp + LLM-feedable patches + multi-tenant API) stays where it is. The World abstraction inherits the runtime track records of mature engines.
- Five compelling adapters out of the box: `world-openworkflow-pg` (current default), `world-openworkflow-sqlite` (dev), `world-wdk-postgres` (Postgres via WDK), `world-cloudflare`, `world-inngest`.
- No need to ship/maintain a custom runtime.
- Clean ports & adapters: the seam matches existing internal `step: any` boundary.

**Cons:**
- Capability variance — engines disagree on sleep precision, signal semantics, retry models. Solved with capability flags + a contract-test suite that runs against every adapter.
- Performance varies — Inngest's network hop per step is ~50ms; openworkflow on PG is ~5ms. Documented per-adapter.
- Some engines won't expose `signal` as a primitive (e.g., CF Workflows) — must be emulated via hooks/webhooks. Capability flag warns the user.

---

## Alternative C — "Capability bag" (mix-and-match traits)

Decompose into separate traits the adapter opts into. Negotiation at boot time.

```ts
interface ThodareBackend {
  readonly id: string;
  readonly traits: BackendTrait[];  // ["dispatcher", "step-runner", "signaler", "scheduler", "inspector"]
}

// Each trait is an independent capability:
interface WorkflowDispatcher { defineWorkflow, runWorkflow }
interface StepRunner { stepRun, stepSleep }            // step.run + step.sleep
interface Signaler { signal, waitForSignal }
interface Scheduler { scheduleCron, scheduleAt, cancel }
interface Inspector { getRun, listRuns, listSteps }
interface Streamer { writeStream, readStream }
interface SecretVault { storeCredential, fetchCredential }
```

A "complete" World implements all traits. A degraded backend (e.g., a pure queue + nothing else) implements only what it can. Thodare detects missing traits and either degrades gracefully or refuses to register the workflow.

**Pros:** Maximum flexibility. Can support odd backends (a pure SQS World? a pure DO World?).

**Cons:** Complexity explosion. Hard to write coherent docs ("which traits do I need for X?"). Hard to test (matrix grows multiplicatively). Hard to keep consistent across engines. Punishes the common 95% case to support a 5% case nobody asked for.

---

## Recommendation

**Alternative B** with a small capability flag bag from C.

- The seam is at the right level: Thodare wraps existing durable engines instead of competing with them.
- Surface is small enough to document on one page.
- Five strong adapters can ship in v0.2:
  - `@thodare/world-openworkflow-pg` (current default, no behavior change for existing users)
  - `@thodare/world-openworkflow-sqlite` (dev / local — for `thodare dev` ergonomics)
  - `@thodare/world-cloudflare` (CF Workflows + Queues + DO storage)
  - `@thodare/world-vercel-wdk` (lifts WDK's Vercel/Postgres/Local worlds for free)
  - `@thodare/world-inngest` (managed serverless story for users on Inngest already)
- Capability flags solve adapter-variance pragmatically without trait explosion.
- Door stays open for Alternative A later — a `@thodare/world-native` that owns its own durability — but only when there's a clear gap nothing else fills (probably never).

The crucial insight: **Thodare's bet is the JSON+EditOp+multi-tenant-API surface, not the durable runtime.** Adopting B keeps the bet pure and inherits the runtime work of every engine in the ecosystem. Adopting A would be a strategic blunder dressed as engineering rigor.
