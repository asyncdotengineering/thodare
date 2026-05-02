# Durable-Execution Engines: A Comparative Survey for Thodare

> Audience: Thodare maintainers evaluating which engines could plausibly sit behind a "World" port (Ports & Adapters), and what to copy / what to avoid.
> Scope: substrate, serverless model, pluggability. No code changes recommended — research only.
> Sources: cited inline against canonical files, repos, and docs (line numbers where stable). Marketing pages are *not* used as primary evidence for structural claims.

---

## 1. Inngest (`inngest/inngest`)

### What it is
A serverless-first durable function platform: you write `inngest.createFunction(...)` with `step.run`/`step.sleep`/`step.waitForEvent`, deploy to *your* HTTP host (Vercel, Lambda, a Go server, anywhere), and a separate Inngest server (cloud or self-hosted) calls back into your endpoint to drive each step.

### Substrate
The Inngest server is Go. The README architecture section (`inngest/inngest/README.md`, "Project Architecture" block) lists distinct components: **Event API**, **Event stream** (buffer between API and Runner), **Runner** (schedules, resumes, cancels), a multi-tenant aware **Queue**, an **Executor**, a **State store** for in-flight run state, and a **Database** for system data and history.

The OSS server can run with embedded SQLite/in-memory backends (the dev server) or with external PostgreSQL/Redis/NATS in production. The repo's `pkg/` layout (`pkg/eventstream`, `pkg/pubsub`, `pkg/history_drivers`, `pkg/run`, `pkg/execution`, `pkg/connect`) mirrors that decomposition; `history_drivers` and `pubsub` being separate packages is the visible hint that backends are abstracted via Go interfaces internally — though only a small set of concrete drivers ship.

### Execution model
Two-process model: **Executor** (Inngest-side, Go) ↔ **SDK** (user's process, anywhere). Per `docs/SDK_SPEC.md` §4.4, every step is delivered as an HTTP **Call Request** from the Executor to the SDK. The SDK runs *one* step, returns a `206 Partial Content` (or completes), and the Executor enqueues the next call.

Replay is *not* deterministic-VM replay (Temporal-style). Per the spec §5.1–5.2 and the official "How functions are executed" doc, the SDK re-runs the function body from the top on every Call Request, but `step.run("id", fn)` consults the **memoized step state** keyed by hashed step ID — completed steps short-circuit and inject the cached return value, undone steps either execute (one of them per request, then return) or yield a sleep/wait command.

`step.sleep` and `step.waitForEvent` return commands; the Executor honors them without keeping any process alive on the SDK side. Sleeps are durable on the server.

### Serverless story
This *is* the model. Because the SDK side is invoked one HTTP request per step, the host's per-invocation timeout (Lambda 15 min, Vercel 60s/300s, Cloudflare 30s CPU, etc.) only has to fit *the longest single step*, not the whole workflow. The Inngest docs explicitly note each step gets a fresh invocation budget and Inngest supports steps up to ~2h. Long-running workflows that exceed Lambda's 15-minute limit work natively, *without* CRIU/checkpointing.

There's also an optional `pkg/connect/` path (gRPC long-poll worker mode) for users who want push-based dispatch without exposing public HTTPS, but the canonical model remains "your code is an HTTP handler."

### DX surface
Code-first, decorator-free TypeScript / Python / Go / Kotlin. No DSL, no JSON config — workflow shape emerges from `await step.run(...)` calls inside an async function.

### Pluggability
- **Substrate**: partially. The Go server has internal driver interfaces (`pkg/history_drivers`, `pkg/pubsub`, `pkg/eventstream`) but the public matrix of supported backends is small (in-process for dev, Postgres + Redis + NATS-ish for prod). It is not designed for the user to swap in their own queue.
- **Runtime / SDK**: very pluggable — the SDK Spec (`docs/SDK_SPEC.md`) is explicitly an open spec so anyone can write a new SDK. This is the deepest "pluggability" surface in Inngest: the **execution wire protocol is public**.
- **Queue**: not user-swappable in the OSS distribution.

### Self-host vs managed
OSS server (Go) is licensed **SSPL with delayed open publication under Apache-2.0** (`LICENSE.md`). SDKs are Apache-2.0. Self-hosting is supported and documented but the Cloud is the primary commercial product. The SSPL prevents Thodare from rebranding the Inngest server as a hosted product without legal grief.

### What Thodare can learn
1. **Publish the wire protocol** before the engine. Inngest's SDK Spec is the most copyable artifact — future Thodare SDKs build against a doc, not a codebase.
2. **One-step-per-HTTP-call** is the cleanest answer to serverless time limits. No CRIU, no DOs — the host's per-invocation timeout no longer constrains the workflow.
3. **Memoization-by-step-ID** is simpler than deterministic replay and works on hosts you don't control.

---

## 2. Hatchet (`hatchet-dev/hatchet`)

### What it is
A Postgres-first, MIT-licensed background-task + durable-workflow platform — the closest peer to where Thodare sits today.

### Substrate
PostgreSQL is the source of truth. Per `frontend/docs/pages/v1/architecture-and-guarantees.mdx` ("Architecture overview" + "Storage (and optional messaging)" sections): "PostgreSQL is the durable store for workflow definitions and execution state … In self-hosted deployments, you can start with PostgreSQL-only and add components like RabbitMQ if you need higher throughput." The Hatchet-Lite docker compose in `frontend/docs/pages/self-hosting/hatchet-lite.mdx` ships RabbitMQ + Postgres for higher tiers; the bare-Postgres setup is supported up to ~hundreds of tasks/sec/engine.

### Execution model
Three-piece architecture (`architecture-and-guarantees.mdx`, "Core components"): **API server** (HTTP), **Engine** (scheduling, dispatch, policy enforcement, durable state writes), **Workers** (your processes). Workers connect to the Engine over **bidirectional gRPC** for low-latency dispatch and status updates.

Workflow shape is either a pre-declared **DAG** (parents declared statically; outputs flow to children) or **Durable Tasks** which can spawn other tasks dynamically and store full history for cache/replay (`README.md` "Task Orchestration" block, Python/TS/Go examples). `DurableContext.aio_sleep_for` and `aio_wait_for` provide durable sleep + event waits respectively (Context7 snippet from `sdks/python/docs/context.md`).

There is no "execute one step per HTTP request" model — workers are long-lived gRPC clients. Replay determinism: Hatchet stores the full execution history of a durable task, and intermediate step results are cached so re-execution after worker crash skips completed work.

### Serverless story
**Explicitly not the target.** The architecture doc lists "Serverless-only runtimes (e.g. AWS Lambda / Cloud Functions) as your primary worker model" under "Not a good fit for". Workers are stateful gRPC clients; they need to stay connected. You *can* run them on long-lived containers (Fly Machines, Cloud Run, Fargate) but Lambda-with-15-min-cap is not the design center.

### DX surface
Code-first, language-native: Python decorators (`@hatchet.task(...)`), TS factory calls (`hatchet.task({...})`), Go factories (`factory.NewTask(...)`). DAG topology is declared via `parents=[task1]`. Concurrency, rate-limit, sticky routing, and event waits are first-class config-on-task.

### Pluggability
- **Substrate**: low. Postgres is hard-required; the optional RabbitMQ slot is the only swap point and it's a tier toggle (`SERVER_MSGQUEUE_KIND: rabbitmq` in the lite compose), not a "bring your own backend" port.
- **Runtime**: workers can be any language with an SDK (Python, TS, Go, Ruby today) — but they all speak the same gRPC engine protocol. The protocol is in `proto/` in the repo.
- **Queue**: only the message bus is swappable (Postgres ↔ RabbitMQ).

### Self-host vs managed
**MIT licensed**, full self-host parity. Hatchet Cloud exists but is operationally equivalent to OSS — no feature gating mentioned. This is the friendliest license/parity story in the survey.

### What Thodare can learn
1. **Postgres-only is real and shippable** if you cap at ~100s/sec and add a broker for higher tiers.
2. **Be explicit about what you're not** ("Not a good fit for: serverless-only runtimes"). Trust > aspiration.
3. **Bidirectional gRPC dispatch** beats long-poll on latency (~25ms P95 claimed) but precludes pure-serverless workers — a trade Thodare must make consciously.

---

## 3. Trigger.dev v3+ (`triggerdotdev/trigger.dev`)

### What it is
Apache-2.0 managed run queue with **CRIU-checkpointed** warm workers, code-first TS tasks declared via `task({ id, run })`, primarily targeting "long-running AI pipelines on someone else's containers."

### Substrate
Postgres + Redis. Per `internal-packages/run-engine/README.md` "Run execution" section: "The execution state of a run is stored in the `TaskRunExecutionSnapshot` table in Postgres." That same README's "Run locking" section says "RedLock to create a distributed lock … Postgres locking is not enough on its own because we have multiple API instances and Redis is used for the queue." So: **Postgres for state-of-record, Redis for the queue and distributed locking**. The schedule engine's README confirms Prisma + Redis as the two required infra deps.

### Execution model
A multi-layer hierarchy from the Run Engine README "Glossary":
**Platform** (API + dashboard + DB) → **Worker group** (queue partition, e.g. region) → **Worker** (server) → **Supervisor** (pulls runs, manages containers) → **Deploy container** (per user-deploy image) → **Run controller** + **Run executor** (the actual user task).

Replay model: **checkpoint/restore via CRIU** (per the v3 announcement post and `trigger.dev/docs/how-it-works`). When a run hits `wait.for(...)` or `triggerAndWait(...)`, the supervisor freezes the entire process (memory, CPU regs, FDs) to disk; resources are released; on resume the checkpoint is restored into a new container. Determinism is not enforced at the language level — there's nothing to enforce, because the *exact same process state* comes back.

State machine: per `TaskRunExecutionSnapshot` (internal, log-of-state-events) vs `TaskRun` (user-visible status). The README explicitly notes the optimistic-concurrency pattern of "read the current state and check that the passed in `snapshotId` matches the current `snapshotId`." Waitpoints (`RUN`, `DATETIME`, `MANUAL`) are the synchronization primitive.

### Serverless story
Trigger.dev v3 deliberately does **not** run user code on Lambda. The build system (`docs/how-it-works`) packages user task code into a Docker image deployed to Trigger.dev infra. Self-hosted v4 docker-compose runs both webapp and worker containers (`docs/self-hosting/docker.mdx`). On self-hosted, the docs explicitly note "self-hosted workers can't use checkpoints so machines won't spin to zero when you use wait functions" — CRIU is a managed-only optimization.

So: serverless is the *platform shape* (you don't manage workers), but the *execution substrate* is managed long-lived containers with CRIU, not FaaS.

### DX surface
Code-first TS:
```ts
export const myTask = task({
  id: "my-task",
  run: async (payload, { ctx }) => {
    await wait.for({ seconds: 10 });
    return result;
  },
});
```
Plus `triggerAndWait`, `batchTriggerAndWait`, `wait.until`, `wait.forRequest`, `wait.forWaitpoint`. Configuration extends to `onWait`/`onResume` hooks.

### Pluggability
- **Substrate**: not user-swappable. Postgres + Redis are hard deps.
- **Runtime**: self-hosted workers replace managed CRIU workers, but the worker process protocol (gRPC + Run Engine snapshots) is fixed.
- **Queue**: internal `RunQueue` resource (see Run Engine architecture diagram in the README) is not pluggable — it's a Redis-backed fair multi-tenant queue.

### Self-host vs managed
Apache-2.0, fully self-hostable via docker-compose / Helm. The Cloud has the CRIU checkpointing optimization that self-host can't replicate, plus warm-worker pooling. No feature gating; "unlimited runs" on self-host per the v3 open-access announcement.

### What Thodare can learn
1. **Snapshots are a DB concept.** The `TaskRunExecutionSnapshot` (internal log) vs `TaskRun` (user-visible status) split is the cleanest state separation in the survey — Thodare should mimic it.
2. **Waitpoints as a unifying primitive.** RUN, DATETIME, MANUAL share one resume mechanism — clean port surface.
3. **CRIU is a trap for OSS.** Locks you to Linux, blocks self-host parity, optimization not feature. Skip.
4. **Fair multi-tenant queue is a real subsystem** (`internal-packages/run-engine/`). Defer until tenancy matters.

---

## 4. Temporal (`temporalio/temporal`)

### What it is
The OG durable-execution engine: a stateful self-hosted cluster (frontend, history, matching, worker services) that drives long-lived language workers via gRPC, with deterministic event-history replay as the correctness model.

### Substrate
**Pluggable persistence layer.** Per `temporal_io` docs ("Persistence"): supported backends are **Apache Cassandra, MySQL, PostgreSQL, and SQLite** for the default store, plus Elasticsearch (or SQL with Advanced Visibility 1.20+) for visibility. This is the only engine in the survey with genuinely first-class swappable backends — driven by an in-tree persistence interface.

### Execution model
Four service roles per `docs/references/configuration.mdx`: **frontend**, **matching**, **worker**, **history**. Workflow code runs on **language workers** (Go/Java/TS/Python/.NET/PHP), polling task queues over gRPC. Activities (the I/O bits) run on the same workers but in a separate context.

Replay correctness comes from **Event History** (`docs/encyclopedia/event-history/event-history.mdx`): every command (start activity, start timer, etc.) is durably persisted as an event by the History service. On worker crash or restart, the worker re-executes the workflow function from the top, *but* every API call returns the same result it returned originally because it's looked up in the persisted history. This requires **strict workflow determinism** — no `Math.random()`, no `Date.now()`, no I/O outside activities.

`workflow.sleep(timedelta(hours=24))` is a durable timer (per the DBOS migration guide comparison); it's a command, not a `setTimeout`.

### Serverless story
**Anti-target.** Temporal workers are designed to be long-lived gRPC clients holding sticky workflow caches. There is no first-class Lambda-style story. Temporal Cloud is managed-Temporal but workers are still your problem; you cannot sensibly run a workflow worker on Lambda because the worker must outlive any single workflow invocation and maintain a sticky cache.

### DX surface
Code-first, deeply opinionated. Workflow code must be deterministic; SDK provides `workflow.executeActivity`, `workflow.sleep`, `workflow.signal`, `workflow.query`, etc. This is the *most demanding* DX surface — you have to learn what determinism means. In return you get the most expressive replay model.

### Pluggability
- **Substrate**: yes, genuinely — persistence is a first-class plugin point. Five backends supported in tree.
- **Runtime**: workers are user-supplied processes, but they must speak Temporal's gRPC protocol and respect determinism.
- **Queue**: matching service is the queue; not user-swappable.

### Self-host vs managed
Self-host is the canonical mode (`docs/self-hosted-guide/deployment`). Temporal Cloud is the SaaS. Helm charts (`temporalio/helm-charts`) exist for production deploys. The OSS surface is the entire engine.

### What Thodare can learn
1. **Pluggable persistence is the gold standard** — Temporal's interface is the reference for the `World` port. Read `temporal/common/persistence/` before designing yours.
2. **Determinism is a tax users won't pay** unless the audience is enterprise infra. Inngest/Trigger/DBOS all chose memoization or checkpoint instead.
3. **Long-lived sticky workers** is the wrong default for Thodare's audience. Reference Temporal as **what we are deliberately not**.

---

## 5. Cloudflare Workflows

### What it is
A managed serverless durable execution engine that runs *inside* Cloudflare Workers, with each workflow instance backed by a SQLite-Durable-Object "Engine."

### Substrate
**SQLite-backed Durable Objects.** Per Cloudflare's "Building Workflows: durable execution on Workers" blog (`blog.cloudflare.com/building-workflows-durable-execution-on-workers/`): each running workflow instance has its own dedicated Engine DO, backed by SQLite, that executes steps, persists state, and manages the instance lifecycle. The control plane (configuration, account management) is also a set of SQLite-backed DOs.

### Execution model
The "game loop model" — the workflow function is a loop that re-runs from the top every time the engine wakes up, with `step.do(...)` results memoized in the SQLite-DO. State *outside* `step.do` is not preserved across hibernations (per `developers.cloudflare.com/workflows/build/rules-of-workflows`, "Avoid Storing State Outside of Steps"). The engine can hibernate when there's no pending work and wake up on alarm (sleep complete) or external signal.

`step.sleep` uses Durable Object alarms for long sleeps. `step.do` runs the inner callback if uncached, otherwise injects the cached value. The "in-memory state will be lost across hibernations" warning in the docs makes the model explicit — only step returns survive.

### Serverless story
This *is* serverless to its core. Workflow code only runs inside a Worker invocation; between steps the Engine DO can hibernate (zero cost). No 15-minute timeout — the loop is naturally chunked by `step.do` boundaries, much like Inngest, but the orchestrator is co-located inside the same Cloudflare network rather than calling back to user-managed HTTP.

### DX surface
Code-first, class-based:
```ts
export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const data = await step.do("fetch", async () => ...)
    await step.sleep("pause", "20 seconds")
  }
}
```

### Pluggability
- **Substrate**: zero. SQLite-DO is non-negotiable, and DOs are Cloudflare-only.
- **Runtime**: Cloudflare Workers only (V8 isolate, no Node).
- **Queue**: not exposed.

### Self-host vs managed
**Not open source, not self-hostable.** No source repo. `workerd` (Cloudflare's OSS runtime) does not yet support durable on-disk DOs sufficient to host Workflows.

### What Thodare can learn
1. **"Game loop" framing** is the cleanest mental model for memoized step replay — more honest than Inngest's because CF admits in-memory state dies. Adopt verbatim.
2. **One-Engine-DO-per-workflow** is a great isolation primitive. Thodare's `World` port could expose `getOrCreateRunActor(runId)` as the analog.
3. **Don't copy what's not in reach.** Recreating DOs on commodity infra collapses to either Inngest's HTTP callback or DBOS's library model.

---

## 6. DBOS (`dbos-inc/dbos-transact-ts`)

### What it is
An MIT-licensed **library** (no separate orchestrator service) that turns ordinary TypeScript / Python / Go / Java functions into durable workflows by checkpointing state to your existing Postgres.

### Substrate
**Postgres only.** Per the README ("What is DBOS?"): "DBOS is entirely contained in this open-source library, there's no additional infrastructure for you to configure or manage." Per the DBOS docs and DeepWiki summaries: workflow state lives in two tables — `dbos.workflow_status` (one row per workflow execution: ID, function name, status, serialized inputs, outcome) and `operation_outputs` (one row per completed step: workflow ID, step ID, step name, outcome).

### Execution model
**Library-in-process.** `DBOS.registerWorkflow(fn)` and `DBOS.runStep(fn)` are the only primitives. When `runStep` is called, DBOS checks `operation_outputs` for an existing row keyed by `(workflowID, stepID)`; if present, returns the cached outcome; if not, runs the function and writes the result. On process restart, DBOS scans `workflow_status` for in-flight rows and re-invokes the workflow function — re-execution short-circuits completed steps via the same memoization.

Durable sleep: `DBOS.sleep(ms)` writes a wakeup row and the workflow resumes after the deadline regardless of restarts. Notifications: `DBOS.recv` blocks the workflow until a matching `DBOS.send` arrives, also durably.

### Serverless story
DBOS runs *inside* your serverless function. Per `docs/integrations/vercel.md`: register workflows in a Vercel API route, call `DBOS.runStep(...)` inside. The 15-minute Lambda timeout still applies to the *single invocation* — so for long-running workflows, the model relies on:
1. Fast steps (each `runStep` should be quick).
2. Background recovery: a separate long-lived process (or a scheduled cron Lambda) periodically wakes up and continues in-flight workflows by reading `workflow_status` and calling them.

This is a **degraded** serverless story compared to Inngest — DBOS's replay-on-restart works great when *something* will eventually restart. On pure FaaS with no warm worker, you need a recovery cron.

### DX surface
The lightest in the survey. No DSL, no decorators required (TS uses `registerWorkflow`; Python uses `@DBOS.workflow()`). No deployment of a separate engine. Programmatic management via `DBOS.listWorkflows`, `forkWorkflow`, etc. — workflows are just rows you can SQL-query.

### Pluggability
- **Substrate**: zero. Postgres is the only backend, and the schema is fixed.
- **Runtime**: it *is* your runtime — there's nothing to swap.
- **Queue**: `WorkflowQueue` is implemented as Postgres rows with concurrency / rate-limit columns; not pluggable but conceptually clean.

### Self-host vs managed
MIT-licensed library. DBOS Cloud exists for hosted Postgres + workers + dashboard, but the library is fully usable standalone with any Postgres.

### What Thodare can learn
1. **"Workflows are Postgres rows"** unlocks full programmatic control (query, fork, batch-resume) without a mandatory UI. Make every run a row from day one.
2. **Library-in-process is a viable World adapter** — a `LocalLibraryWorld` that just talks to Postgres, no engine, ideal for self-host minimalism.
3. **Recovery-on-restart ≠ execution-on-demand.** DBOS nails the first, punts on the second (needs a recovery loop). Thodare must own both.

---

## 7. Quirrel (archived)

### What it is
A small, archived OSS deferred-job runner for Next.js / serverless: schedule "in N minutes, call me back at this URL with this payload."

### Substrate
**Redis** via a custom library called **Owl** (`quirrel-dev/owl` on GitHub) — sorted sets for time-indexed scheduling, pub/sub for dispatch.

### Execution model
HTTP callback. The Quirrel server holds the schedule; when a job is due, it makes an HTTP POST to the registered URL (e.g. `pages/api/queues/email`). User code lives entirely in the serverless function; Quirrel never holds any of it. No multi-step workflows, no waitpoints, no determinism — just delayed/cron job dispatch.

### Serverless story
The whole point. Designed for Next.js on Vercel, where you can't keep workers alive. Cron + delayed + fanout jobs only.

### DX surface
```js
export default Queue("api/queues/email", async (payload) => { ... })
```
A queue *is* the API route's default export, and `.enqueue(payload, { delay })` triggers a server call.

### Pluggability
- **Substrate**: Redis only (Owl is Redis-coupled).
- **Runtime**: any HTTP host.
- **Queue**: Owl is pluggable as a library but Quirrel embeds it.

### Self-host vs managed
**MIT.** Hosted Quirrel was shut down July 2022 (acquired by Netlify per The New Stack); self-host remains. Repo is archived.

### What Thodare can learn
1. **The simplest possible adapter shape** for "deferred work on serverless" is just URL + payload + delay. Thodare's entry-level adapter should look like this.
2. **Owning the schedule but not the code** is a clean separation — the orchestrator never needs to import user functions, only their URL. This reduces coupling for the JSON-workflow path.
3. **Archived ≠ wrong.** Quirrel was acquired and the code lives on as Netlify Scheduled Functions. The model worked; the standalone product didn't.

---

## 8. Vercel Workflow DevKit (`vercel/workflow`)

(User indicated they've already studied this; brief here.)

### What it is
Apache-2.0 TypeScript framework using **`"use workflow"` and `"use step"` directives** to make functions durable. Compile-time transform extracts step boundaries; runtime persists event log and intercepts `Math.random()` / `Date.now()` for replay determinism. Backend on Vercel uses Vercel Functions + Vercel Queues + managed persistence; OSS runtime is portable.

### Key takeaways for Thodare
1. **Directives compile to the same shape** as `step.run(...)` — a higher-level surface that doesn't change the underlying memoization model.
2. **Build-time + runtime split**: compile workflow files into handler files at build, mount handlers at runtime. This is a third axis of pluggability (build pipeline) Thodare hasn't considered.
3. **Determinism via interception** (Math.random, Date.now) is feasible in TS where you control the bundler — much harder in polyglot worlds.

---

## 9. Synthesis

### Comparison matrix

| Engine | Primary substrate | Serverless-native? | Pluggable substrate? | Surface | OSS license | Self-host parity |
|---|---|---|---|---|---|---|
| **Inngest** | Postgres + Redis (Go server) | Yes (HTTP callback per step) | Partial (internal Go interfaces) | Code-first, public wire spec | SSPL + delayed Apache-2.0 | Good but SSPL-restricted |
| **Hatchet** | Postgres (+ optional RabbitMQ) | No (long-lived gRPC workers) | No (Postgres mandatory) | Code-first, decorator/factory | MIT | Full parity |
| **Trigger.dev v3** | Postgres + Redis | Platform-shape only; CRIU containers | No | Code-first `task({...})` | Apache-2.0 | Yes, minus CRIU |
| **Temporal** | Cassandra / MySQL / Postgres / SQLite + ES | No (sticky workers) | **Yes — first-class** | Code-first, deterministic | MIT | Full parity (the canonical mode) |
| **CF Workflows** | SQLite-backed Durable Objects | Yes (Worker isolate + DO) | No | Code-first class extends | Closed | None |
| **DBOS** | Postgres only | Library-inside-FaaS (with caveats) | No | Library, decorator | MIT | Library = self-host |
| **Quirrel** | Redis (Owl) | Yes (HTTP callback) | No | URL + payload + delay | MIT (archived) | Full parity |
| **Vercel WDK** | Vercel Queues + managed persistence; OSS runtime portable | Yes | Partial (build-time mountable) | Directives + steps | Apache-2.0 | Partial |

### What to copy

1. **Inngest's wire-protocol-as-spec** (`docs/SDK_SPEC.md`). Publish a Thodare execution protocol *before* you publish an engine. This unlocks polyglot SDKs without coordinating a shared codebase.
2. **Inngest's one-step-per-HTTP-call serverless model.** Solves Lambda's 15-minute cap without CRIU, without DOs, without anything proprietary. Pair this with a long-lived-worker mode for hosts that prefer it (like Hatchet's gRPC option) and you span the whole spectrum.
3. **DBOS's "workflows are Postgres rows" rule.** Every run is a row. Every step output is a row. No bespoke binary state files. Programmatic management (list, fork, replay) becomes free.
4. **Trigger.dev's `TaskRunExecutionSnapshot` vs `TaskRun` split.** Internal execution log ≠ user-facing status. Two tables, two purposes. Avoids the "your dashboard lies because it shows internal state" trap.
5. **Cloudflare's "game loop model" framing.** It's the most honest description of memoized step execution. Use it in Thodare's docs verbatim — it makes the "in-memory state dies between hibernations" rule pre-emptively obvious.
6. **Hatchet's bare-Postgres self-host story** with an explicit "add a broker for tier 2" upgrade path. Don't pretend you need Redis from day zero; don't pretend Postgres scales to 10k/sec either.
7. **Temporal's persistence interface** as the *shape* of Thodare's `World` port. Read `temporal/common/persistence/` for the canonical "what does a swappable backend interface even look like" prior art — even if Thodare ships only a Postgres adapter at v1.

### What to avoid

1. **Temporal-style deterministic replay.** The DX tax (no `Math.random()`, no `Date.now()`, no I/O outside activities) is too high for the Thodare audience. Memoize step outputs instead.
2. **CRIU checkpointing.** Locks you to Linux containers, blocks self-host parity, and the savings are an optimization not a feature. Trigger.dev needed it for sub-second wait pricing; Thodare doesn't.
3. **SSPL.** Inngest's choice limits commercial reuse and is a turn-off for some buyers. Pick MIT (Hatchet, DBOS, Quirrel) or Apache-2.0 (Trigger.dev, Vercel WDK).
4. **"Can't self-host" as a default.** Cloudflare Workflows has the cleanest model on paper but the second your audience asks "can I run this on my own infra," you have nothing. Self-host parity is the price of credibility in the OSS workflow space.
5. **Long-lived sticky workers as the only model.** Hatchet and Temporal both make this choice and explicitly disqualify the serverless audience. Thodare has explicitly chosen the opposite — don't drift.
6. **Two DSLs for the same idea.** Vercel WDK introduces directives that compile down to the same step-and-memoize model. Pick one surface (JSON or code), not both with adapters between them, until the JSON path is proven.
7. **Pretending the substrate doesn't matter.** Cloudflare Workflows' "managed persistence" line elides that you cannot ever leave Cloudflare. If Thodare's premise is portability, the substrate must *actually* be swappable — even if v1 ships only one adapter.

### Ranked: which engines could plausibly *be* a Thodare backend

1. **DBOS** — already a library; could become a `DbosWorld` adapter that takes Thodare workflow JSON and lowers it to `DBOS.runStep` calls. Postgres-shared, no new infra.
2. **Inngest (self-hosted)** — public wire protocol means a `InngestWorld` adapter is well-scoped: Thodare emits step calls over Inngest's HTTP protocol against an Inngest server you operate.
3. **Hatchet** — gRPC protocol is in `proto/`; an adapter could shovel Thodare workflow steps into Hatchet tasks. Loses the serverless story but gains the dashboard, alerting, multi-tenancy.
4. **Trigger.dev** — possible but the API surface is task-centric, not step-centric; mapping Thodare's step-graph onto `triggerAndWait` chains is awkward.
5. **Temporal** — possible (Temporal does have JSON-driven workflow definitions via SDK extensions) but the determinism contract is a poor match for arbitrary user code, and self-host weight is huge.
6. **Cloudflare Workflows** — managed-only; viable only as a "if user is on CF, use CF" adapter, never as the default.
7. **Quirrel** — too narrow (no multi-step) to back Thodare, but a useful reference for the simplest possible HTTP-callback adapter.

---

## Sources

- Inngest server: `inngest/inngest/README.md` (Project Architecture); `inngest/inngest/docs/SDK_SPEC.md` (§1.1, §4.4, §5.1–5.2); `inngest/inngest/docs/DEVSERVER_ARCHITECTURE.md`; `inngest/inngest/LICENSE.md`; `pkg/{history_drivers,pubsub,connect}/`.
- Hatchet: `hatchet-dev/hatchet/README.md`; `frontend/docs/pages/v1/architecture-and-guarantees.mdx`; `frontend/docs/pages/self-hosting/hatchet-lite.mdx`; `sdks/python/docs/context.md`.
- Trigger.dev v3: `triggerdotdev/trigger.dev/internal-packages/run-engine/README.md`; `internal-packages/schedule-engine/README.md`; `docs/self-hosting/docker.mdx`; `docs/how-it-works`; `docs/tasks/overview.mdx`; v3 announcement blog (`trigger.dev/blog/v3-announcement`).
- Temporal: `temporalio/documentation/docs/encyclopedia/event-history/event-history.mdx`; `docs/references/configuration.mdx` (services); `docs/temporal-service/persistence`; `docs/self-hosted-guide/deployment`; `docs/develop/typescript/best-practices/testing-suite.mdx`.
- Cloudflare Workflows: `developers.cloudflare.com/workflows/build/rules-of-workflows`; `developers.cloudflare.com/workflows/get-started/guide`; `blog.cloudflare.com/building-workflows-durable-execution-on-workers/`.
- DBOS: `dbos-inc/dbos-transact-ts/README.md`; `dbos-inc/dbos-docs/docs/why-dbos.md`; `docs/python/tutorials/workflow-tutorial.md`; `docs/integrations/vercel.md`; `docs/explanations/migrating-from-temporal.md`.
- Quirrel: `quirrel-dev/quirrel` README + `quirrel-dev/owl` README; `docs.quirrel.dev/how-quirrel-works/`; The New Stack acquisition coverage.
- Vercel WDK: `vercel/workflow` repo + `vercel.com/blog/introducing-workflow`, `vercel.com/blog/inside-workflow-devkit-how-framework-integrations-work`.
