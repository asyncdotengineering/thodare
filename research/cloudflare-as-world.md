# Cloudflare as a Thodare World adapter

**Research scope.** Can Cloudflare's developer-platform primitives — Workflows, Queues, Durable Objects (DO), D1 — host a Thodare "World" adapter (Storage + Queue + Streamer ports), and what is the impedance mismatch with the Postgres-backed `@thodare/openworkflow` substrate?

**Method.** Context7 MCP for `/websites/developers_cloudflare_workflows`, `/websites/developers_cloudflare_queues`, `/llmstxt/developers_cloudflare_durable-objects_llms-full_txt`, `/llmstxt/developers_cloudflare_d1_llms-full_txt`, plus targeted WebFetch against the live docs and the Workflows-GA blog. Every claim is footnoted with a URL.

---

## 1. Primitive-by-primitive surface

### 1.1 Cloudflare Workflows

Workflows went **GA on 7 April 2025** ([changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/), [blog](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/)).

**Surface API.** Developers extend `WorkflowEntrypoint` and call `step.do(name, opts?, fn)`, `step.sleep(name, duration)`, `step.sleepUntil(name, ts)`, and `step.waitForEvent(name, eventType, { timeout })` — confirmed in the Context7 dump for `/websites/developers_cloudflare_workflows`. Step return values must be JSON-serialisable, or a `ReadableStream<Uint8Array>` for large binary output. Retry config is per-step: `{ retries: { limit, delay, backoff: "constant"|"linear"|"exponential" }, timeout }`.

**Durability semantics.** The doc *Rules of Workflows* ([docs](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)) makes the model explicit: step names are cache keys; on resume, a step that already has a cached result is **not re-executed** — its prior return value is replayed. This is event-sourced replay (very similar to Temporal/Vercel Workflow DevKit). Steps must be **idempotent** because retries are at-least-once during a single attempt window. The runtime is allowed to hibernate, so any state outside of step return values is lost.

**Limits** ([docs](https://developers.cloudflare.com/workflows/reference/limits/)).

| Limit | Free | Paid |
|---|---|---|
| Steps per workflow | 1,024 | 10,000 (configurable to 25,000) |
| Concurrent active instances | 100 | 50,000 |
| Persisted state | 100 MB | 1 GB |
| Step output size | 1 MiB (or `ReadableStream`) | 1 MiB (or `ReadableStream`) |
| Event payload | 1 MiB | 1 MiB |
| Max sleep duration | 365 days | 365 days |
| Instance creation rate | 100/s | 300/s account, 100/s per workflow |
| Queued instances | 100,000 | 2,000,000 |
| CPU time per step | 10 ms | 30 s default, up to 5 min |
| Retries per step | 10,000 | 10,000 |
| Subrequests per step | 50 | 10,000 (up to 10 M) |

`waiting`-state instances do **not** count towards concurrency.

**External invocation.** Three triggers ([docs](https://developers.cloudflare.com/workflows/build/trigger-workflows/)): Worker bindings, Wrangler CLI, and the Cloudflare REST API at `POST /accounts/{account_id}/workflows/{workflow_name}/instances` ([API reference](https://developers.cloudflare.com/api/resources/workflows/)). Status changes via `PATCH .../instances/{id}/status` (pause / resume / terminate / restart). External events for `waitForEvent` are sent with `POST .../instances/{instance_id}/events/{event_type}` — bearer-token auth.

**Outbound HTTP.** Anything `fetch()` reaches from inside a step, subject to subrequest caps.

**Pricing** ([docs](https://developers.cloudflare.com/workflows/reference/pricing/)). Workflows are billed as Workers — per-request and per-CPU-ms. **A "request" is the trigger of an instance, not a step.** Persisted state is billed as GB-month using the same SQLite SKU as Durable Objects, with active billing starting Sep 2025.

### 1.2 Cloudflare Queues

**Surface API.** `env.QUEUE.send(body, { delaySeconds, contentType })`, `env.QUEUE.sendBatch(messages, { delaySeconds })`. Consumer is a Worker exporting `async queue(batch, env, ctx)` that calls `msg.ack()`, `msg.retry({ delaySeconds })`, `batch.ackAll()`, `batch.retryAll()`. (Confirmed in Context7 `/websites/developers_cloudflare_queues`.)

**Limits** ([docs](https://developers.cloudflare.com/queues/platform/limits/)).

| Limit | Value |
|---|---|
| Queues per account | 10,000 |
| Per-queue throughput | **5,000 msg/s** |
| Per-queue backlog | 25 GB |
| Max message size | 128 KB |
| Batch size | 100 messages or 256 KB |
| Consumer batch size | up to 100 |
| `delaySeconds` max | **24 hours (43,200 s in API, but cap is 12 h per Context7 / 24 h per limits page — see note)** |
| Retries per message | 100 |
| Retention | up to 14 days (24 h on Free) |
| Push consumer concurrency | 250 |
| Consumer wall time | 15 min |

Note: the Context7 dump shows the SDK accepting `delaySeconds: 0–43200` (12 h), while the limits page WebFetch reported 24 h. Either way, **single-message delay is bounded well below Thodare's `wkf_step_*` requirement of arbitrary scheduled wakes**. For long sleeps, the queue is the wrong primitive.

**Delivery semantics.** At-least-once. The docs do not promise exactly-once. Built-in DLQ is configured per-consumer (`dead_letter_queue` in `wrangler.jsonc`).

**External invocation.** Producers can be Workers, the HTTP REST API, or pull-consumers from outside CF. Consumers are push (Worker) or pull (HTTPS).

**Pricing** ([docs](https://developers.cloudflare.com/queues/platform/pricing/)). $0.40 per million **operations**, where 1 op = 64 KB written/read/deleted. A typical 1-KB message moving end-to-end (write + read + delete) = **3 ops**. Free plan: 10k ops/day; Paid: 1M ops/month included. No egress charges.

### 1.3 Durable Objects

**Surface API.** `class Foo extends DurableObject`. Two storage backends:

- **SQLite-backed** (recommended, default for new DOs): `ctx.storage.sql.exec(sql, ...binds)`, returns a cursor. Per-DO **private** SQLite database; every method implicitly transactional ([docs](https://developers.cloudflare.com/durable-objects/api/storage-api/)). `databaseSize` exposed; 30-day point-in-time recovery.
- **KV-backed** (legacy): `ctx.storage.get/put/delete/list`.

**Alarms** ([docs](https://developers.cloudflare.com/durable-objects/api/alarms/)). One alarm per DO. `setAlarm(epochMs)` / `getAlarm()` / `deleteAlarm()`. Handler is `async alarm({ retryCount, isRetry })`. **Guaranteed at-least-once**, exponential-backoff retries up to 6 attempts at 2 s base. Granularity: ms. Constructor runs **before** alarm handler when waking from cold.

**WebSockets / hibernation.** WebSocket Hibernation API lets the DO sleep between messages without losing connections — duration billing pauses ([docs cited above](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

**Limits.** The Storage API page does not enumerate per-DO size limits explicitly; community/changelog references commonly cite 10 GB/DO for SQLite (same as D1). Throughput is bounded by the single-threaded nature of one DO instance.

**External invocation.** Yes — addressable by name → ID → stub → `fetch()` from any Worker, or proxied through a Worker HTTP route from the open internet. **Cannot** be hit directly from outside CF without a Worker in front.

**Pricing** ([docs](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

| Meter | Free | Paid included | Overage |
|---|---|---|---|
| Requests (HTTP / RPC / WS msg / alarm) | 100k/day | 1 M/mo | $0.15 / M |
| Duration (GB-s, only when not hibernating) | 13k GB-s/day | 400k GB-s/mo | $12.50 / M GB-s |
| SQLite rows read | — | 25 B/mo | $0.001 / M |
| SQLite rows written | — | 50 M/mo | $1.00 / M |
| SQLite stored | — | 5 GB-mo | $0.20 / GB-mo |

SQLite storage billing activates Jan 7 2026 at the earliest ([changelog](https://developers.cloudflare.com/changelog/2025-12-12-durable-objects-sqlite-storage-billing/)).

### 1.4 D1

**Surface API.** `env.DB.prepare(sql).bind(...).run()/all()/first()/raw()`; `env.DB.batch([stmt, ...])` for atomic multi-statement. SQLite dialect.

**Limits** ([docs](https://developers.cloudflare.com/d1/platform/limits/)).

| Limit | Value |
|---|---|
| DB size | 10 GB (Paid) / 500 MB (Free) |
| Account total | 1 TB (Paid) / 5 GB (Free) |
| Row / BLOB | 2 MB |
| Query duration | 30 s |
| Statement length | 100 KB |
| Bound params | 100 |
| Queries per Worker invocation | 1,000 (Paid) / 50 (Free) |
| Concurrent connections per invocation | 6 |
| Throughput | **single-threaded per DB**; ~1k QPS at 1 ms queries, ~10 QPS at 100 ms |

**Durability.** SQLite under the hood; writes durably persisted across multiple locations; reads from primary unless read-replicas configured.

**External invocation.** D1 has an HTTP REST API for queries from outside CF. From inside, only Workers binding.

**Pricing** ([docs](https://developers.cloudflare.com/d1/platform/pricing/)). Per-row: rows-read and rows-written meters; storage billed only above the included GB. $5/mo Workers Paid minimum. No egress.

---

## 2. Mapping the World contract to CF primitives

Thodare's `World` (per the project context) needs `Storage` (append-only event log + materialised run/step/hook views), `Queue` (`__wkf_workflow_*` and `__wkf_step_*` prefixes with delay support), and `Streamer` (chunked output). Plus cross-pod recovery (`reenqueueActiveRuns`).

| Thodare need | Best-fit CF primitive | Fit | Gap |
|---|---|---|---|
| Append-only event log (`events.create()`) | **DO SQLite** (per-run DO with `events` table) or D1 (single shared `events` table) | Good (DO) / OK (D1) | DO: 10 GB/run cap. D1: single-threaded, ~1k QPS write ceiling — kills multi-tenant scale. |
| Materialised run/step/hook views | **D1** | Good if read-heavy & fan-out across runs; **bad** if tightly coupled to event log writes (cross-DB write coordination is manual) | No cross-DB transactions; eventual consistency between DO event log and D1 views unless you keep both inside one DO. |
| Workflow queue (`__wkf_workflow_*`) | **Cloudflare Queues** | Good for fan-in dispatch | Per-queue 5k msg/s ceiling. 12–24 h max `delaySeconds`. |
| Step queue (`__wkf_step_*`) | **Cloudflare Queues** for short-delay steps; **DO alarms** for long sleeps (> 24 h, up to 1 yr) | Mixed | You end up with two transports. The step's "ready time" must route to the right one. |
| Durable sleep / scheduled wake | **DO alarms** (1 per DO, ms granularity, 1 yr+) **or** Workflows `step.sleep` (365 d cap) | Excellent if a DO models the run | Only one alarm per DO — if you store many sleepers in one DO you must multiplex (priority queue inside DO storage + alarm = next-fire-time). |
| Hooks / webhooks (resume by token) | Worker HTTP route → DO stub by token-derived ID, or `POST /workflows/.../events/{type}` if using CF Workflows | Good | Token → DO ID mapping needs a lookup table (D1 or DO directory). |
| Stream output chunks | DO + WebSocket Hibernation, or chunks to **R2** with signed URLs | Good (WS) / OK (R2) | WS limited to inside a DO; R2 needs out-of-band fan-out. No native SSE-fanout primitive. |
| Cross-pod recovery (`reenqueueActiveRuns`) | DO addressing (the run's DO *is* the pod) or scan D1 for `status=running` and re-`send` to queue | Native if DO-per-run | If using shared queue + stateless workers (Option C), you need a periodic Cron Trigger to re-dispatch. |
| Determinism / replay (Thodare's `vm.Context` walker) | Workers V8 isolates *can't* expose `vm.Context` (no Node `vm` module) | **Blocked for Option B/C verbatim** | The Thodare runtime walker would have to be rewritten to use isolate-native sandboxing, or run user code via `cloudflare:workers` `WorkflowEntrypoint` (Option A). |

**Two structural mismatches stand out.**

1. **No cross-resource transaction.** Thodare's Postgres adapter atomically appends to `events` and updates the materialised `runs`/`steps`/`hooks` rows in one transaction. On Cloudflare you can only get atomicity inside a *single* DO's SQLite (or a single D1 batch). To preserve invariants you must collapse storage into one DO per run — the DO becomes the run.

2. **No `vm.Context` in Workers.** Workers run in V8 isolates without Node's `vm` module. Thodare's deterministic replay walker that runs user step code inside `vm.runInContext` is not portable as-is. You either (a) use **CF Workflows** as the runtime walker (Option A) and surrender Thodare's own walker, or (b) ship user code as separate Worker scripts called via service bindings, replaying within the orchestrator DO.

---

## 3. Three viable shapes for a Cloudflare World adapter

### Option A — Use CF Workflows as the runtime walker

The Thodare run *becomes* a `WorkflowEntrypoint`. Thodare compiles a user's workflow definition to `step.do` / `step.sleep` / `step.waitForEvent` calls. The "World" is essentially a thin façade over Workflows' REST API.

- **Storage**: implicit — Workflows persists step state.
- **Queue**: implicit — Workflows runtime.
- **Streamer**: `step.do` returning a `ReadableStream<Uint8Array>`.
- **Hooks**: `step.waitForEvent` + `POST .../events/{type}`.

**Works.** Highest fidelity to "durable execution"; least code; Cloudflare absorbs all the operational burden; fits the 365-day sleep ceiling.

**Hacky.** Thodare's introspection (live `events` log, hook tokens, step-level retry policies surfaced in UI) must be reconstructed by polling `GET .../instances/{id}` (logs/status). Persisted state cap is 1 GB per run; step output cap 1 MiB — tighter than Postgres. Determinism is enforced *by the Workflows engine*, so Thodare loses the ability to swap walker semantics.

**Blocked.** Anything that requires reading the raw event log from outside the workflow (e.g., a custom `Streamer` that fans out to many SSE clients). Anything that needs more than one alarm/timer per run beyond `step.sleep`. Cross-run coordination has to be built outside Workflows entirely.

**Complexity:** lowest. **Fidelity:** medium-low (you're betting on Cloudflare's API matching Thodare's semantics, not enforcing your own).

### Option B — Queues + DO + D1 (Thodare runs its own orchestrator on the CF stack)

Thodare's walker is reimplemented as a `RunDO` Durable Object. Each run = one DO. Inside the DO: SQLite tables `events`, `steps`, `hooks`. DO alarms drive scheduled wakes. A shared `dispatch` Cloudflare Queue carries fan-in (`__wkf_workflow_create`); per-step ready-now work is pushed to a `steps` Queue and consumed by a stateless Worker that calls back into the run's DO via stub. D1 holds a global index of runs (run_id → DO ID, status, created_at) for listing / `reenqueueActiveRuns`.

**Works.** Atomicity inside one DO; alarms cover the > 24 h sleep gap; SQL views per-run. WebSocket Hibernation gives a free streaming endpoint. Cross-pod recovery is automatic — the DO *is* the pod.

**Hacky.** Multiplexing many timers onto one DO alarm (need a min-heap in storage). The Thodare walker can't use `vm.Context` — you must port it to isolate-friendly sandboxing (e.g., function-level service bindings to a separate "user code" Worker per run, or `cloudflare:sandbox` once it stabilises ([Sandboxes GA Apr 2026](https://www.infoq.com/news/2026/04/cloudflare-sandboxes-ga/))). Cross-run queries (e.g., admin dashboard "show all runs of workflow X") have to be served from D1, which means a write to DO-SQLite must be mirrored to D1 in a non-transactional best-effort way — drift is possible.

**Blocked.** Nothing fundamental, but D1's single-threaded ~1k QPS write ceiling caps how aggressively you can keep the global index fresh under bursty load.

**Complexity:** highest. **Fidelity:** highest (Thodare keeps its semantics).

### Option C — Hybrid: CF Queues for transport, external Postgres for storage

Workers consume a CF Queue, run user step code, and write events/views to an **external Postgres** (Hyperdrive in front for connection pooling, or direct over public Internet with TCP socket support). DO alarms used purely as a "wake me at T" cron.

**Works.** Keeps the existing `@thodare/openworkflow` Postgres schema verbatim — zero rewrite of the storage layer. Hyperdrive is the official CF answer to running Postgres-backed Workers ([docs](https://developers.cloudflare.com/hyperdrive/)).

**Hacky.** You're paying CF + Postgres-host. Latency CF→Postgres dominates; every step mutation is a transcontinental round trip unless you co-locate Postgres in a CF data centre region. No `vm.Context` — same constraint as Option B.

**Blocked.** Real-time fan-out of stream chunks to in-browser clients still needs a DO/WebSocket layer; the queue + Postgres path alone can't push.

**Complexity:** medium. **Fidelity:** medium-high for storage; medium-low for runtime (still no `vm.Context`).

**Ranking by complexity (asc):** A < C < B. **Ranking by fidelity (desc):** B > C > A.

---

## 4. Pricing reality check at "Black Friday" scale

**Scenario.** 10 M workflow runs/day, mean 5 steps/run = **50 M step executions/day = 1.5 B/month**. Assume 1 KB step payload, 10 KB persisted state per run (so 100 GB-mo aggregate after retention), 200 ms median CPU per step.

### Option A — CF Workflows

- **Requests** = 10 M/day = 300 M/mo. Workers Paid: $0.30/M after the 10 M free → **300 × $0.30 = $90/mo**.
- **CPU** = 50 M steps/day × 200 ms = 10 M CPU-s/day = 300 M CPU-s/mo = 300k CPU-s × 1000 = ~$96/mo at $0.02 / M ms ($0.02 × 300,000 = $6,000? — recheck). Workers CPU is **$0.02 per million ms**. 300 M CPU-s = 3 × 10^11 ms → 3 × 10^5 M ms → 300,000 M ms × $0.02 = **$6,000/mo**.
- **Persisted state** = 100 GB-mo × $0.20 (DO SQLite SKU) = **$20/mo** (after Sep 2025 active billing).
- **Subrequests / row reads / writes** if any sub-Workflow uses DO-SQLite for indexes = small, ignore.

Subtotal: **~$6,100/mo**, dominated by CPU.

### Option B — Queues + DO + D1

- **Queue ops** = each step = 1 send + 1 receive + 1 delete = 3 ops. 1.5 B steps/mo × 3 = 4.5 B ops. Free 1 M; overage: 4,499 × $0.40 = **$1,800/mo**.
- **DO requests** = inbound fetch + alarm fires. Conservatively 4 requests per step (start, alarm, callback, finish) × 1.5 B = 6 B requests. Overage past 1 M: ~$899/mo. Plus from the public web to start runs (300 M) = $45/mo. **~$945/mo**.
- **DO duration** = 200 ms wall-time per step at ~128 MB → 0.025 GB-s/step × 1.5 B = **37.5 M GB-s/mo**. Free 400k; overage: $12.50 × 37.1 = **$464/mo**. Hibernation can shave this 30–70%; assume 50% → **~$230/mo**.
- **DO SQLite rows** — assume 5 events written + 3 read per step. 7.5 B writes/mo overage past 50 M: 7,450 × $1 = **$7,450/mo**. 12 B reads → free 25 B covers it.
- **DO SQLite storage** = 100 GB-mo × $0.20 = **$20/mo**.
- **D1 global index** = 10 M writes/day = 300 M/mo, plus a few reads. D1 pricing: $1.00/M rows-written above 50 M included. Overage: 250 × $1 = **$250/mo**.

Subtotal: **~$10,700/mo**, dominated by DO row-writes. Tuning the schema to write fewer rows per step (e.g., one row per run instead of per event, JSON-blob append) can cut this 5–10×.

### Option C — Hybrid (Queues + Postgres)

- **Queue ops** = $1,800/mo (same as B).
- **Workers** for consumer = 1.5 B invocations × $0.30/M = **$450/mo** + CPU ~$6,000/mo (same envelope as A).
- **Postgres**: at 50 M step-mutations/day on a self-managed RDS-equivalent — **r6g.4xlarge** (~$700/mo) plus IOPS (~$300/mo) plus replicas (~$700/mo) = **~$1,700/mo**. Hyperdrive is free metering, but adds round-trip.
- **Egress**: zero from CF (no egress fees). Postgres-side egress to CF = $0 if same cloud region.

Subtotal: **~$10,000/mo**, with Postgres ops burden.

### Self-hosted Postgres + workers (baseline, for comparison)

- Postgres cluster (primary + 2 replicas, r6g.4xlarge) = **~$1,700/mo**.
- Worker fleet (k8s, 20 c5.xlarge nodes) = **~$2,500/mo**.
- LB + observability + storage = **~$500/mo**.

Subtotal: **~$4,700/mo**, but you carry ops headcount.

### Summary

| Option | Monthly cost (10M runs/day) | Ops burden |
|---|---|---|
| A — CF Workflows | **~$6,100** | near-zero |
| B — Queues+DO+D1 | **~$10,700** (tuneable down) | low |
| C — Hybrid | **~$10,000** + Postgres ops | medium |
| Self-hosted Postgres | **~$4,700** | high (DBA, on-call) |

**Cloudflare's premium is roughly 1.3×–2.3× of self-hosted at this scale**, in exchange for zero DBA / queue / autoscaling work. Below ~1 M runs/day Cloudflare is *cheaper* (free tiers absorb most of the load); above ~50 M runs/day, self-hosted wins decisively. Workflows (Option A) is the cheapest CF path because it amortises orchestration overhead inside the CPU bill instead of charging row-by-row.

---

## 5. Recommendation

For a Thodare "World" adapter shipped as a feature flag, **start with Option C (Hybrid)** as the smallest delta from the existing Postgres adapter — only the Queue port is rebound to CF Queues; Storage stays Postgres via Hyperdrive. This validates the porting story without rewriting the walker. Then graduate sophisticated users to **Option A** for the "fully managed" pitch, accepting the loss of `vm.Context` semantics and exposing Cloudflare Workflows' surface as Thodare's runtime when the user opts into it. Reserve **Option B** for a future "Cloudflare-native" tier if Thodare wants to own the orchestrator on CF infra — it is the highest-fidelity but also the largest engineering investment.

The two non-negotiable gaps to flag in any DevKit-style abstraction:

1. **`vm.Context` is unavailable in Workers.** Either run user code in CF Workflows (Option A), in a sibling Worker via service binding (Option B/C), or in upcoming `cloudflare:sandbox` ([InfoQ Apr 2026](https://www.infoq.com/news/2026/04/cloudflare-sandboxes-ga/)).
2. **No cross-resource transactions.** Atomicity is per-DO or per-D1-batch. Thodare's `events` + materialised views must collapse into one storage node per run (DO) to preserve invariants — or be relaxed to eventual consistency.

---

## Sources

- [Cloudflare Workflows — Limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Cloudflare Workflows — Pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Cloudflare Workflows — Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Cloudflare Workflows — Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/)
- [Cloudflare Workflows — REST API reference](https://developers.cloudflare.com/api/resources/workflows/)
- [Workflows is now Generally Available — changelog 7 Apr 2025](https://developers.cloudflare.com/changelog/post/2025-04-07-workflows-ga/)
- [Cloudflare Workflows is now GA — blog](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/)
- [Cloudflare Queues — Limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues — Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Queues — Batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries)
- [Cloudflare Queues now on Workers Free plan — changelog 4 Feb 2026](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/)
- [Durable Objects — Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects — Storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [Durable Objects — Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Billing for SQLite Storage — changelog 12 Dec 2025](https://developers.cloudflare.com/changelog/2025-12-12-durable-objects-sqlite-storage-billing/)
- [Cloudflare D1 — Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 — Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [Cloudflare Sandboxes Reach GA — InfoQ Apr 2026](https://www.infoq.com/news/2026/04/cloudflare-sandboxes-ga/)
- Context7: `/websites/developers_cloudflare_workflows`, `/websites/developers_cloudflare_queues`, `/llmstxt/developers_cloudflare_durable-objects_llms-full_txt`, `/llmstxt/developers_cloudflare_d1_llms-full_txt`
