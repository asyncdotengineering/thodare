# Thodare World Abstraction — Proposal

> **Status:** research-grade proposal, not an RFC. Author: Claude (this session, 2026-05-02). Audience: Mithushan + the next session that opens an RFC at `rfcs/world-abstraction/`. Scope: architectural, not implementation.

**One-line summary.** Refactor Thodare's hard dependency on `@thodare/openworkflow` into a thin **World** port (≤10 methods + capability flags), ship 5 first-party adapters that cover serverless / managed / self-host / dev, keep the JSON+EditOp surface untouched, and inherit the runtime track records of every serious durable-execution engine in the ecosystem.

---

## 0. Vision (restated for this proposal)

Thodare is a **self-hostable, open-source, headless workflow orchestration engine** for durable workflows + background tasks + deferred jobs. The bet is the **JSON+EditOp surface that LLMs can build, edit, run, and read back** ([SPEC §2](../SPEC.md#2-the-bets)) — not the durable runtime underneath.

Today the runtime is hardcoded to `@thodare/openworkflow` (vendored Postgres-backed substrate). The next architectural move is to **swap "openworkflow" for an abstract World contract**, so the same workflow JSON + LLM patch loop runs against:

- **Postgres self-host** (the current default, no behavior change for existing users)
- **SQLite** for local dev / `thodare dev`
- **Cloudflare Workflows** for serverless-managed
- **AWS Lambda + SQS** (or any FaaS + queue pair) for "I'm already on AWS"
- **Vercel WDK** (free inheritance of Vercel's `world-vercel` / `world-postgres` / `world-local` / community worlds)
- **Inngest** for managed-serverless users on Inngest already
- *(later)* **Rivet's `@rivetkit/workflow-engine`** for embedded high-scale

The competitive frame is not "we built a better Temporal." It's: **Thodare is the LLM-native control plane that runs on the durable-execution substrate you already have**, and brings durable-execution to the substrate you don't yet, with one DSL, one API surface, one DX.

---

## 1. Why now (the convergence finding)

This is the load-bearing observation of the research and it justifies the timing:

> **Three independent codebases — Thodare's T5, Cloudflare's `dynamic-workflows` (shipped 2026-05-01), Rivet's `@rivetkit/workflow-engine` — converged on the same architectural pattern: one registered orchestrator + per-instance isolated KV + external dispatcher metadata that routes back to per-tenant logic.**

| Thodare T5 (locked Dec 2025) | CF `dynamic-workflows@0.1.1` (May 2026) | Rivet `workflow-engine@2.3.0-rc.4` |
|---|---|---|
| ONE registered openworkflow workflow (`wfkit-runtime`) | ONE registered `WorkflowEntrypoint` (the dispatcher) | ONE engine instance per workflow, KV-isolated by host |
| Workflow JSON pinned in run input (T4) | Routing metadata stashed via `wrapWorkflowBinding({ tenantId })` | `EngineDriver` operates in an isolated namespace; host provides isolation |
| Runtime walker reads JSON, dispatches blocks to tools | `dispatchWorkflow` reads metadata, calls `loadRunner`, delegates `run(event, step)` | Dispatcher loads the workflow function for the namespace |
| Generic dispatcher serves every workflow | Generic dispatcher serves every tenant | Generic engine serves every workflow instance |

Three teams. Different problem framings. Same answer.

This is the right architectural moment to formalize the World port: the pattern is now industry-validated, the contract is well-understood, and Thodare is small enough that the refactor is bounded (the openworkflow coupling surface is ~5 files, ~700 LOC out of ~5k engine LOC — see `_scratch-interface-design.md`).

---

## 2. What's wrong with the current state

Three concrete problems with hardcoded `@thodare/openworkflow`:

### 2.1 The runtime story is "Postgres + worker, full stop"

Existing serverless users (Vercel / Cloudflare / Lambda) cannot adopt Thodare without spinning up a Postgres + a long-lived worker pod. That's the wrong shape for them and they leave.

### 2.2 The DX story leaks the substrate

`createWfkit({ backend })` requires the user to instantiate `BackendPostgres.connect(...)` or `BackendSqlite.open(...)` themselves. Substrate decisions should be a deploy-time concern, not an SDK call.

### 2.3 We can't credibly recommend Thodare to users who already have a durable-execution engine

A user on Inngest, Trigger, or Vercel already has the durability layer. Forcing them to add Postgres + openworkflow alongside is a tax. The right pitch is "Thodare runs on top of what you have."

The World abstraction solves all three with the same change.

---

## 3. The interface — Alternative B with capability flags

Three alternatives were sketched in `_scratch-interface-design.md`. The recommendation is **Alternative B** ("thin DurableExecutionAdapter — wrap an existing engine") with a small **capability flag bag** borrowed from Alternative C.

### 3.1 Why B and not A or C

- **Alternative A (WDK-shaped, ~30 methods, owns storage+queue+streamer)** is wrong because Thodare doesn't own a runtime today. Adopting A means **building Thodare's own replay-deterministic orchestrator + vm-sandbox + event-sourcing storage** — a quarter of work that competes head-on with WDK without a clear differentiator beyond JSON+EditOp. **Strategic blunder dressed as engineering rigor.**
- **Alternative C (capability bag, separate traits)** is wrong because the matrix grows multiplicatively (which traits compose? which combinations are valid?). Punishes the common 95% case to support a 5% case nobody asked for.
- **Alternative B** is right because (a) every serious durable engine already has step.run/sleep/wait, (b) the seam is tiny (Thodare's `walk.ts` already takes `step: any`), (c) it inherits the runtime track record of every engine in the ecosystem, (d) it matches the convergence finding above (one orchestrator + per-instance namespace + dispatcher metadata).

### 3.2 The `World` interface (informative — not a code change)

```ts
interface ThodareWorld {
  readonly id: string;                       // "openworkflow-pg" | "wdk-vercel" | "cloudflare-dynamic" | ...
  readonly capabilities: WorldCapabilities;

  // Workflow lifecycle (orchestrator-side)
  defineWorkflow(spec: WorkflowSpec, handler: ThodareHandler): Promise<RegisteredWorkflow>;
  runWorkflow(name: string, input: unknown, opts?: RunOpts): Promise<RunHandle>;
  signal(runId: string, signalName: string, payload?: unknown): Promise<void>;

  // Run inspection / control
  getRun(runId: string): Promise<RunDescription | null>;
  listRuns(filter?: RunFilter, page?: Page): Promise<RunPage>;
  cancel(runId: string): Promise<void>;

  // Worker lifecycle (a no-op for serverless adapters)
  start(opts?: { concurrency?: number }): Promise<void>;
  stop(): Promise<void>;
}

// What the orchestrator function receives
type ThodareHandler = (ctx: ThodareCtx) => Promise<unknown>;

interface ThodareCtx {
  input: unknown;
  step: ThodareStep;
  runId: string;
  signal: AbortSignal;
  log: ThodareLogger;
}

// The step shim — every adapter implements these three
interface ThodareStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;     // memoized, idempotent on replay
  sleep(name: string, duration: string | number): Promise<void>;
  waitForSignal<T>(opts: { name: string; signalName: string; timeoutMs?: number }): Promise<T>;
}

// Capability flags — each adapter declares what's true
interface WorldCapabilities {
  maxStepDurationMs: number;            // 15min Lambda, 30s Workers, ∞ self-host
  maxRunDurationMs: number;             // ∞ for most managed; matters for cost-capped tiers
  signalPrecision: "exact" | "best-effort";
  exactlyOnceSteps: boolean;            // true for openworkflow + WDK; false for some queues
  serverless: boolean;                  // true for cf/lambda; false for self-host
  supportsHooks: boolean;
  supportsStreams: boolean;
  pricingModel: "self-host" | "per-invocation" | "per-second" | "managed-flat";
  maxStepOutputBytes?: number;          // CF Workflows = 1 MiB, openworkflow = ∞
  maxPersistedStateBytes?: number;      // CF Workflows = 1 GB/run
}
```

**Total surface: 8 methods on `World` + 3 on `Step` + a capability bag.** Documentable on a single page.

### 3.3 Contract test suite (the load-bearing operational discipline)

Every adapter must pass the same vitest suite (`@thodare/world-contract-tests`), parameterized over the adapter under test. The suite covers:

1. **Happy-path** — define → run → step → result → assert output.
2. **Replay determinism** — crash mid-run, restart, assert no duplicate side effects.
3. **Sleep precision** — `step.sleep("60s")` resumes within `[60s, 60s + capabilities.signalPrecision-allowed slack]`.
4. **Signal delivery** — `world.signal(runId, "name", payload)` resumes a `step.waitForSignal` within slack.
5. **Cancellation** — `world.cancel(runId)` causes `ctx.signal.aborted === true` in the orchestrator.
6. **Multi-tenant isolation** — runs from different `organizationId`s never cross.
7. **Idempotency** — same `idempotencyKey` returns the same `runId`.
8. **Capability honesty** — assertions in the suite are gated by the adapter's declared capabilities (e.g., the streams test is skipped when `capabilities.supportsStreams === false`).

This is how Thodare avoids "looks like it works on the demo, breaks on Black Friday." Every adapter ships with a green contract-test report, every PR runs them.

---

## 4. The adapter roster

### 4.1 Ships in v0.2 (the headline release)

| Package | Purpose | Substrate | Surface complexity | Position |
|---|---|---|---|---|
| `@thodare/world-openworkflow-pg` | **Default**, no behavior change for existing users | Postgres + openworkflow | trivial wrapper; ~150 LOC | "Production self-host" |
| `@thodare/world-openworkflow-sqlite` | `thodare dev` ergonomics — single-binary local | SQLite + openworkflow | trivial wrapper; shares 90% with above | "Zero-config dev" |
| `@thodare/world-cloudflare-dynamic` | **Serverless-managed**, lifts CF Workflows + `cloudflare/dynamic-workflows` | CF Workflows + D1 + Queues | ~600 LOC; non-trivial because of `vm.Context` absence | "Pay-per-use serverless" |
| `@thodare/world-wdk` | **Inheritance play** — wraps Vercel's WDK so all 7 official + community Worlds become Thodare backends | Whatever WDK can use (Vercel/Postgres/Local/Turso/MongoDB/Redis/Jazz) | ~400 LOC + WDK peer dep | "Pick any WDK World" |
| `@thodare/world-inngest` | Managed-serverless via Inngest | Inngest + their queue | ~300 LOC; SDK already exposes `step.run/sleep/waitForEvent` | "I'm already on Inngest" |

**v0.2 ships seven backends total** through five packages (because `world-wdk` lifts WDK's seven worlds). That's the value proposition.

### 4.2 Ships in v0.3+ (validated by user demand, not assumption)

| Package | When | Why deferred |
|---|---|---|
| `@thodare/world-rivetkit-engine` | A user asks for it | Rivet's `@rivetkit/workflow-engine` is a peer; pluggable but not strategic for v1 |
| `@thodare/world-temporal` | A user with Temporal asks | Temporal's worker model is the "we don't want this" reference; only build if a real customer pays for it |
| `@thodare/world-lambda-sqs` | A user without CF or Vercel asks | Wider adoption depends on it; deferred until v0.2 lands and signals point this way |
| `@thodare/world-native` | Probably never | The native runtime is the "Alternative A" trap. Build only if a clear gap nothing else fills emerges. |

### 4.3 What each adapter looks like at the seam

Sketched at the level of "what's the impedance mismatch and how do you hide it" — implementation will discover details.

#### `@thodare/world-openworkflow-pg` (the trivial case — current behavior)

Wraps the `OpenWorkflow` class + `BackendPostgres`. `defineWorkflow` calls `ow.defineWorkflow(name, fn)`. `runWorkflow` calls the compiled handle's `.run(input)`. `step.run` / `step.sleep` / `step.waitForSignal` pass through unchanged — they're already openworkflow's primitives. **Capability flags:** `serverless: false, signalPrecision: "exact", exactlyOnceSteps: true, maxStepDurationMs: ∞`.

#### `@thodare/world-cloudflare-dynamic` (the interesting case)

This is where the May 2026 `cloudflare/dynamic-workflows` library substantially changes the picture from `cloudflare-as-world.md`'s Option A vs. B framing.

**Architecture:** Thodare's runtime walker is registered as **the** `WorkflowEntrypoint` for the deployed Worker (the dispatcher). At Thodare workflow-define time, the workflow JSON is stored in D1 keyed by `workflowName`. At run time, `defineWorkflow(name, handler)` is a no-op against CF (the dispatcher is already registered); `runWorkflow(name, input)` calls `env.WORKFLOWS.create({ params: { name, input } })` through `wrapWorkflowBinding({ workflowName: name, organizationId: orgId })`. The CF Workflows engine persists the metadata, replays it on every step. When the engine calls `dispatcher.run(event, step)`, the dispatcher unwraps the metadata, fetches the workflow JSON from D1 by name, and walks it — hitting `step.do(blockId, fn)` for compute blocks, `step.sleep(blockId, duration)` for waits, `step.waitForEvent(blockId, eventType, { timeout })` for signals.

**Step API mapping:**

| `ThodareStep` | CF Workflows |
|---|---|
| `step.run(name, fn)` | `step.do(name, opts?, fn)` |
| `step.sleep(name, "60s")` | `step.sleep(name, "60s")` |
| `step.waitForSignal({ name, signalName, timeoutMs })` | `step.waitForEvent(name, signalName, { timeout })` |

**Capability flags:** `serverless: true, maxStepDurationMs: ~30s (CPU) / 30 min (wall, with retries), signalPrecision: "exact", exactlyOnceSteps: true, maxStepOutputBytes: 1_048_576, maxPersistedStateBytes: 1_073_741_824, pricingModel: "per-invocation"`.

**Risks:** the `maxStepOutputBytes: 1 MiB` cap is real — Thodare needs a documented "spill to R2 if oversize" pattern, or refuse the step at validation time. Capability flag carries the limit; the contract-test suite asserts the validator catches it.

**Hidden value:** because `world-cloudflare-dynamic` uses CF Workflows directly (not a custom orchestrator on Queues+DO+D1), pricing collapses from `cloudflare-as-world.md`'s Option B (~$10.7k/mo) toward Option A (~$6.1k/mo) at 10M runs/day. **The `dynamic-workflows` library is the architectural unlock that makes the CF adapter affordable at Black Friday scale.**

#### `@thodare/world-wdk` (the inheritance play)

Trivial in spirit, careful in detail. `defineWorkflow(name, handler)` registers a function with the WDK SWC plugin's `step` mode (or — if the SWC transform isn't available at runtime — uses WDK's `runtime.registerWorkflow` + `runtime.registerStep` programmatic APIs). `runWorkflow(name, input)` calls `start(workflowFn, [input])`. The `step` shim maps to WDK's primitives.

| `ThodareStep` | WDK |
|---|---|
| `step.run(name, fn)` | `"use step"` function (proxied) |
| `step.sleep(name, dur)` | `sleep(dur)` |
| `step.waitForSignal({...})` | `createHook<T>({ token })` → `await hook` |

**Capability flags:** depend on the underlying WDK World. The adapter introspects the World instance and forwards `world.specVersion`, then sets `serverless: true` for `world-vercel`, `false` for `world-postgres`, etc.

**Subtle gotcha:** WDK's runtime is **code-first** (TS files + SWC plugin); Thodare workflows are **JSON-first**. The adapter's `defineWorkflow` registers a single generic Thodare runtime walker function with WDK (Thodare's T5 pattern, again — same architectural insight at every layer of the stack). Per-Thodare-workflow JSON is loaded from Thodare's own `WorkflowStore`, not from the WDK side.

#### `@thodare/world-inngest`

`defineWorkflow(name, handler)` registers an Inngest function with `inngest.createFunction({ id: name }, { event: "thodare/run.requested" }, async ({ event, step }) => handler({ ...event.data, step }))`. `runWorkflow` sends an event. Step shim maps cleanly:

| `ThodareStep` | Inngest |
|---|---|
| `step.run(name, fn)` | `step.run(name, fn)` (identical) |
| `step.sleep(name, dur)` | `step.sleep(name, dur)` |
| `step.waitForSignal({...})` | `step.waitForEvent(name, { event: signalName, timeout })` |

**Capability flags:** `serverless: true, maxStepDurationMs: 15min (Lambda) or per-host, signalPrecision: "exact", exactlyOnceSteps: true (per Inngest), pricingModel: "per-invocation"`.

**Citation note:** Inngest's published SDK Spec is the most copyable artifact in the durable-engines survey. If Thodare ever ships a wire-protocol World instead of an in-process one, this is the prior art.

---

## 5. Migration path from openworkflow-coupled

The refactor is bounded because the seam is small. Five steps, each independently shippable.

### Phase 1 — Define the contract (~1 week)

- `packages/world/` (new) — pure types + the `ThodareWorld` interface + `WorldCapabilities` + `ThodareStep` + `ThodareCtx`. No runtime code, no dependencies. Mirror `@workflow/world` from WDK in structure (it's been validated by the public).
- `packages/world-contract-tests/` (new) — the parameterized vitest suite. Imports `@thodare/world` types only. Provides `runContractTests(world, options?)`.
- RFC at `rfcs/world-abstraction/README.md` — restate this proposal in RFC form. Lock the interface and capability list in v0 contract; bump in v1+ with explicit semver discipline.

### Phase 2 — Extract the openworkflow adapter (~1 week)

- `packages/world-openworkflow-pg/` (new) — wraps `OpenWorkflow` + `BackendPostgres`. ~150 LOC. Passes contract tests.
- `packages/world-openworkflow-sqlite/` (new) — same code, different `Backend`. Trivial alias package.
- `packages/engine/src/runner/openworkflow.ts` and `runtime-workflow.ts` and `handle.ts` — refactor to take a `World` instead of an `OpenWorkflow` + `Backend` pair. Internal change; the `walk.ts` walker is already abstract (`step: any`). **Backward-compatible**: `createWfkit({ backend })` continues to work, but is documented as deprecated in favor of `createWfkit({ world })`.
- `packages/api/src/runtime-host.ts` — rewrite in terms of `world.runWorkflow`. ~30 LOC change.
- All existing tests pass with no behavior change.

### Phase 3 — Ship the second adapter (~1 week)

- `packages/world-cloudflare-dynamic/` (new) — uses `cloudflare/dynamic-workflows@0.1.1` + `@cloudflare/workers-types` + a D1 client. ~600 LOC.
- New `examples/cloudflare-deploy/` workspace — full deploy story end to end.
- New docs page: `apps/docs/src/content/docs/how-to/deploy-cloudflare.md`.

This is the **proof point** — once a second adapter passes contract tests, the abstraction is real.

### Phase 4 — Ship the rest (~3 weeks)

- `packages/world-wdk/` (~400 LOC + WDK peer dep)
- `packages/world-inngest/` (~300 LOC + Inngest SDK peer dep)
- Per-adapter docs page in the deploy quadrant.

### Phase 5 — Deprecate the direct openworkflow API (~v0.3, separate release)

- `createWfkit({ backend })` removed.
- `createWfkit({ world })` is the only path.
- Migration codemod + changelog.

**Total: ~6 weeks of focused work, each phase independently shippable, no behavior change for existing users until phase 5.**

---

## 6. The deploy story — what we steal from Astro Flue

Per `flue-deep-dive.md`, Flue's CLI is **three verbs (`dev`, `run`, `build`) and one load-bearing axis (`--target`)** — there is **no `deploy` command**. Flue stops at producing `dist/` and lets the platform tool (`wrangler deploy`, `node dist/server.mjs`) handle the actual ship.

This is the right shape for Thodare too. A proposed `thodare` CLI for v0.2:

```sh
thodare init                                  # scaffold a new project (one of the few one-shot verbs)
thodare dev                                   # local SQLite world; hot-reload on workflow JSON change
thodare run <workflow> [--input '{...}']      # one-shot CI-style run; reads result from stdout
thodare build --target=<world>                # produce the deployable artifact for the target
```

**Critically: no `thodare deploy`.** The output of `thodare build --target=cloudflare` is a directory with a `wrangler.jsonc` and a worker bundle; the user runs `wrangler deploy` themselves. Output of `thodare build --target=postgres-self-host` is a Docker Compose file + migrations; the user runs `docker compose up`. Output of `--target=lambda` is a SAM template + bundled Lambda zip.

**Why this matters:** the platform's own deploy tools have the auth, the credential cache, the rollback story, the team permissions. Thodare wrapping `wrangler deploy` is one bug class away from disaster. Flue figured this out; we should too.

**`BuildPlugin` interface** (mirror Flue): each `world-*` package exports a `BuildPlugin` with five methods (`generateEntryPoint`, `bundle?`, `entryFilename?`, `esbuildOptions?`, `additionalOutputs?`). The CLI `--target` flag dispatches to the matching plugin. Third parties can write their own targets without touching the CLI.

**Merge-don't-replace** (also from Flue): when `thodare build --target=cloudflare` finds an existing `wrangler.jsonc`, it merges the workflow binding into the user's config — never overwrites it. Same for `serverless.yml`, `sam.yaml`, `compose.yaml`. Users keep their own platform config; we add what we need.

---

## 7. Risks and alternatives considered

### 7.1 Adapter capability variance — the real risk

Different engines disagree on:

- **Sleep precision** — Postgres + worker can wake within 1s; CF Workflows is exact-to-the-hibernation-cycle (~5s slack); Inngest is per-host.
- **Signal semantics** — Inngest's `waitForEvent` matches by event type only; Thodare needs `signalName` matching by run id.
- **Step output size** — CF Workflows caps at 1 MiB; openworkflow has no cap.
- **Retry policy** — adapters vary on default retries, backoff shape, max attempts.

**Mitigation:** capability flags carry the truth; the validator at `applyOperations` time refuses to register a workflow whose declared step output exceeds the active World's `maxStepOutputBytes`; the contract-test suite asserts the per-adapter behavior against documented slack windows.

**The honest framing in docs:** "Thodare unifies the surface, not the substrate. Pick the World whose tradeoffs match your workload."

### 7.2 The "make Thodare a WDK World instead" alternative

**The temptation:** instead of wrapping WDK as one of many Worlds, *be* a WDK World — implement the `@workflow/world` interface (Storage + Queue + Streamer) backed by openworkflow + Thodare's stores. Then any `"use workflow"` TS code from the WDK ecosystem runs on Thodare's substrate.

**Why we shouldn't:** this is the inverse of the right direction. WDK's surface is **code-first**; Thodare's bet is **JSON+EditOp** (LLM-native). Becoming a WDK World means adopting WDK's surface and burying ours. The right read of WDK is "they're a peer to openworkflow at the durability layer; we wrap them like any other engine."

**Note in the RFC's "alternatives considered" section** so it doesn't get re-litigated under deadline pressure later.

### 7.3 The "build the native runtime (Alternative A)" alternative

Discussed at length in `_scratch-interface-design.md` §A. **Wrong** for v0.2 — quarters of work, competes with WDK without differentiation. **Door stays open** for v1+ if a clear gap emerges that nothing else fills (probably never, but the contract is decoupled enough to add it later as `@thodare/world-native` without breaking other adapters).

### 7.4 "Just use one of these existing engines, scrap Thodare's runtime layer entirely"

**The framing:** if WDK / Inngest / CF Workflows already exist, why does Thodare exist?

**The answer:** because none of them ship the JSON+EditOp+multi-tenant-API+Diataxis-docs-discipline+`hidden()`-secret-boundary surface. Thodare is the **LLM-native control plane on top of any of them**. The World abstraction makes that pitch credible — adopters can use the substrate they already trust.

This is the strategic positioning the World abstraction unlocks.

### 7.5 Adapter pricing transparency

CF Workflows at 10M runs/day = ~$6.1k/mo (per `cloudflare-as-world.md`). Self-hosted Postgres + workers at the same load = ~$300/mo (one beefy box + standby). The 20× pricing delta is the user's tradeoff, not ours, but **we owe them honest math in each adapter's README** — pricing examples at small / medium / Black-Friday scale, no marketing.

---

## 8. Success metrics — Black Friday is the benchmark

For v0.2 to ship as "done":

### Functional

- [ ] Five adapters in the workspace, all green on `@thodare/world-contract-tests`.
- [ ] Existing `pnpm test` (currently 209 tests across the workspace) continues to pass with no regressions.
- [ ] Backward compatibility: `createWfkit({ backend })` continues to work in v0.2; deprecation warning only.
- [ ] Migration codemod from `{ backend }` → `{ world }` ships in the same release.
- [ ] Every adapter ships a `examples/deploy-<adapter>/` workspace that boots with `pnpm install && pnpm dev` and runs a real workflow end-to-end.

### Operational (the real bar)

- [ ] **10,000 concurrent workflow runs** sustained for 1 hour against `world-openworkflow-pg`, with p99 step latency ≤ 200ms and zero data loss on a single worker pod restart mid-run.
- [ ] **1,000 concurrent runs** sustained for 1 hour against `world-cloudflare-dynamic`, with p99 step latency ≤ 1s and zero replay-divergence errors.
- [ ] **Adapter swap test:** the same `examples/full-llm-loop/` workflow runs identically on every adapter — only the deploy target changes.
- [ ] **Black Friday simulation** — single 10M-run scripted scenario across all five adapters, posted as `bench/black-friday-2026.md` with the actual numbers.

### Strategic

- [ ] At least one external adopter writes a third-party World adapter using the public `@thodare/world` types within 90 days of v0.2 release. (If nobody can write a third-party adapter, the abstraction is wrong.)
- [ ] At least one adopter migrates from openworkflow + Postgres to Cloudflare Workflows without changing their workflow JSON or their EditOp loop. (Demonstrates the substrate-swap promise.)
- [ ] HackerNews / X reach: post-launch front-page on HN ("Show HN: Thodare runs the same workflow on Postgres, Cloudflare, Vercel, and your laptop").

### DX

- [ ] `thodare init` → `thodare dev` → first workflow runs in < 60 seconds on a fresh laptop.
- [ ] CLI surface ≤ 4 verbs (`init`, `dev`, `run`, `build`) — no `deploy`.
- [ ] Each adapter's README documents pricing at three scales (10k / 1M / 10M runs/day) with verifiable math.

---

## 9. Open decisions — the maintainer needs to pick

Before this becomes an RFC, three decisions are load-bearing:

1. **Capability flags vs. trait composition.** This proposal recommends capability flags (Alternative B). If the maintainer prefers traits (Alternative C), the World interface and the contract-test suite need to be rebuilt around traits — meaningful redesign, not a tweak.
2. **`thodare deploy` or not.** This proposal recommends "no, we ship `build` only and delegate to platform tools" (per Flue). Some users will demand `deploy`. The maintainer should decide whether to hold the line.
3. **License posture for community adapters.** Vendored CF `dynamic-workflows` is MIT (compatible). WDK is Apache-2.0 (already vendored as `@thodare/openworkflow`). Inngest SDK is Apache-2.0. Rivet is Apache-2.0. The default policy ("MIT for our work, Apache-2.0 for vendored, document in NOTICE per T19") covers everything. **No new license decisions needed** unless a community World ships under SSPL or BSL.

---

## 10. References

- [`flue-deep-dive.md`](./flue-deep-dive.md) — CLI shape + multi-target deploy patterns
- [`cloudflare-as-world.md`](./cloudflare-as-world.md) — primitive-by-primitive feasibility + pricing math at Black Friday scale (NOTE: Option A's economics improve substantially in light of the `cloudflare/dynamic-workflows` finding, see §4.3 above)
- [`durable-engines-survey.md`](./durable-engines-survey.md) — Inngest, Hatchet, Trigger, Temporal, CF Workflows, DBOS, Quirrel; comparison matrix + what to copy / what to avoid
- [`rivet-deep-dive.md`](./rivet-deep-dive.md) — actor/workflow-engine/queue split + the convergence finding (§7 lessons for Thodare)
- [`_scratch-interface-design.md`](./_scratch-interface-design.md) — three interface alternatives + openworkflow coupling map
- [`../SPEC.md`](../SPEC.md) — locked decisions T1–T19 (this proposal honors all of them; no SPEC change required)
- [`../.internal/HANDOFF.md`](../.internal/HANDOFF.md) — current state
- [`../.internal/next-up.md`](../.internal/next-up.md) — work queue (this proposal slots in above the existing items)
- [`../discussions/serverless-workflow-pg-workers-runners.md`](../discussions/serverless-workflow-pg-workers-runners.md) — the original Grok exploration that seeded this direction
- External: `cloudflare/dynamic-workflows@0.1.1` (MIT, ~300 LOC) — clone at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/dynamic-workflows/`
- External: `vercel/workflow` — clone at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/workflow/`
- External: `vercel/workflow-examples` — clone at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/workflow-examples/`
- External: `vercel-labs/workflow-builder-template` — clone at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/workflow-builder-template/`
- External: `withastro/flue` — clone at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/flue/`
- External: `rivet-gg/rivet` — clone at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/rivet/`

---

**End of proposal.** Open the RFC at `rfcs/world-abstraction/README.md` when ready.
