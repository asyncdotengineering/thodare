# Cross-cutting patterns from the use cases

> This file consolidates the patterns that show up across **notification-platform.md**, **sales-funnel-platform.md**, and **marketing-automation.md**. The header pattern: each is a "drag-and-drop workflows over user behavior" SaaS. The substrate they need is the same.

If we built Thodare for OneSignal-class only, the resulting engine would still serve ClickFunnels-class and Klaviyo-class. The patterns below are **the load-bearing primitives the proposal v2 must close gaps on** for any of these verticals to be feasible on Thodare.

---

## 1. The "workflow per subscriber" pattern

All three categories instantiate **one workflow definition × N concurrent runs**, where each run represents one user/visitor/customer flowing through the journey.

```
Workflow definition: "abandoned-cart-recovery"  (lives once, in Thodare)
Concurrent runs:
  ├── run wrun_aaa for customer c_001 — paused at "wait 1h"
  ├── run wrun_bbb for customer c_002 — running "send_email"
  ├── run wrun_ccc for customer c_003 — paused at "wait_for_email_open"
  ├── run wrun_ddd for customer c_004 — completed
  ├── ...
  └── run wrun_zzz for customer c_999_999 — paused at "wait 24h"
```

**What this needs from Thodare:** scaling `runWorkflow(name, input)` to **millions of concurrent runs per workflow definition** while keeping per-run state cheap. Each adapter has different scaling characteristics here:

- `backend-self-host-postgres`: each run = ~5 KB in `workflow_runs` + N rows in `workflow_steps`. ~200 GB at 100M concurrent runs. Manageable with partitioning + retention policies.
- `backend-cloudflare`: each run = a CF Workflows instance. CF currently caps at 50,000 concurrent active instances per account on the paid tier. At 100M concurrent waiting subscribers, this isn't viable on a single account — need account sharding (see proposal v2 §4.3 noisy-neighbor mitigation).
- `backend-aws`: SQS queue depth + Lambda concurrency. RDS row count is fine; the bottleneck is Lambda concurrency at burst (default 1000/region, raisable).

**v0.3 follow-up needed:** `runWorkflowBatch(name, inputs[])` API for the "fan out to a segment of N users" case where N can be millions.

## 2. Long durable sleeps as the load-bearing wait primitive

Marketing-automation flows routinely wait **months** between sends. Notification-platform drip campaigns wait days-to-weeks. Sales-funnel cart-abandonment waits hours-to-days.

Thodare's `wait_duration` block (T1) maps to `step.sleep` on every adapter:

| Adapter | Max contiguous sleep | Approach |
|---|---|---|
| `backend-self-host-postgres` | unbounded | openworkflow's `step.sleep` — the row sits in `workflow_waits` with `resume_at` |
| `backend-self-host-sqlite` | bounded by single-process uptime; not for production | same primitive |
| `backend-cloudflare` | **365 days** (per CF Workflows docs) | `step.sleep` directly |
| `backend-vercel` | unbounded (Postgres-backed) | same as self-host |
| `backend-aws` | unbounded (DynamoDB TTL or RDS row) | SQS `delaySeconds` chains for >15min |

**Pattern requirement:** sleeps must consume zero compute while waiting. Verified: every adapter does this — the run is suspended, no Lambda / Worker / pod stays alive for the duration.

## 3. The `wait_for_event` + `correlationKey` pattern

Marketing-automation: "wait for `email_clicked` correlated to this send's `messageId`."
Sales-funnel: "wait for `payment_completed` correlated to this session's `sessionId`."
Notification-platform: "wait for `push_clicked` correlated to this notification's `deliveryId`."

```
ctx.input.prevOutput.messageId = "msg_abc123"
   ↓
[wait_for_email_event]
   correlationKey: "msg_abc123"
   timeoutMs: 86400000
   ↓
   Run is paused. The DB has a row in workflow_hooks (token = correlation key).
   ↓
... external system (SendGrid) reports email open via webhook ...
   ↓
JourneyHQ ingestion calls: backend.signal(runId, "email_opened", { messageId: "msg_abc123" })
   OR
JourneyHQ ingestion calls: thodare.hooks.resume(token = "msg_abc123", payload)
   ↓
Run resumes from the wait_for_event block with payload as output.
```

**Implementation reality across adapters:**

- All five v0.2 adapters support this via `step.waitForSignal`.
- The lookup-by-token cost matters at scale. `backend-self-host-postgres` needs an index on `workflow_hooks(token)`; `backend-cloudflare` uses DO addressing (constant lookup).
- Timeouts must be honored even if no signal ever arrives — verified by the contract test suite (proposal v2 §3.7 test #4).

## 4. The "send via channel honoring user preferences" pattern

All three categories need: "send Slack/email/SMS/push **unless** the user has opted out of that channel, **unless** quiet hours, **unless** frequency cap exceeded."

This is **not** an engine concern. It belongs in the connector itself:

```ts
async execute(params, ctx) {
  // 1. Frequency cap
  if (await rateLimit.exceeded(ctx.input.userId, "email", "1d")) {
    return { sent: false, suppressionReason: "frequency_cap" };
  }
  // 2. Channel opt-in
  if (!await preferences.isOptedIn(ctx.input.userId, "email")) {
    return { sent: false, suppressionReason: "channel_optout" };
  }
  // 3. Quiet hours (timezone-aware)
  if (isQuietHours(await user.getTimezone(ctx.input.userId))) {
    // Either: defer (return PauseInfo), or: suppress and continue
    return { sent: false, suppressionReason: "quiet_hours" };
  }
  // 4. Send
  return await actuallySend(...);
}
```

**Pattern requirement:** the connector's `outputs` schema needs to expose suppression reason, so downstream blocks can branch on `if (output.sent === false) → END` vs. continue. Already supported.

**Architectural note:** Thodare's docs should document this as the "Send Discipline Pattern" — every messaging connector should expose `outputs.sent: boolean` + `outputs.suppressionReason?: string`. Validators on the workflow-spec side could enforce.

## 5. A/B testing as a `random_split` branch primitive

Klaviyo, OneSignal, ClickFunnels all ship A/B testing. Implementation is identical across:

```
[Random Split: 50/50]
  ├─ (variant_a) ↓
  │  [Send Email: subject = "Save 25% today"]
  │  → CONTINUE
  └─ (variant_b) ↓
     [Send Email: subject = "Your exclusive 25% offer"]
     → CONTINUE
```

The `random_split` block is a connector that returns `{ variant: "a" | "b" }` based on a deterministic hash of `runId` (so the variant is stable on replay — important for replay determinism). Multiple `sourceHandle` values route downstream.

**v0.3 nice-to-have:** an engine-level `random_split` primitive that auto-instruments variant performance metrics, so the marketer dashboard can show "variant A converted at 3.2%, variant B at 4.1%" without the founder building it. **For v0.2 leave it to userland connectors.**

## 6. The "drop-off analytics" pattern (Storage.steps.list at scale)

Every visual-builder customer wants this dashboard:

> "Out of 10,000 subscribers who entered this flow, 6,500 reached the second send, 4,200 reached the third, 870 converted, 312 unsubscribed."

This is `Storage.steps.list({ workflowId, organizationId, since })` aggregated by `stepId` and `status`. At Klaviyo scale (billions of steps), this is an OLAP problem.

**Pattern recommendation:** Thodare's API exposes raw step rows. Customers pipe `step_completed` events to a separate analytics warehouse (ClickHouse, BigQuery, DuckDB, Snowflake, Postgres-with-TimescaleDB) for the dashboard. **Don't put OLAP in Thodare's hot path.** Document the recommended pipe in `apps/docs/src/content/docs/how-to/wire-analytics.md`.

## 7. The "trigger ingestion at high throughput" pattern

OneSignal-class: ~100k events/sec at peak.
Klaviyo-class: similar.
ClickFunnels-class: lower (page views, not telemetry events) but still spikey.

Thodare's `POST /api/workflows/:id/run` is one HTTP request → one workflow run. Fine at moderate scale; **breaks** at vertical-SaaS scale.

**The pattern that scales:**

1. Customer's SDK sends events to the founder's ingestion endpoint (their domain — JourneyHQ owns this).
2. The ingestion endpoint matches against trigger filters and decides which workflows to fire.
3. Triggers are **batched** and sent to Thodare via a `runWorkflowBatch(name, inputs[])` API or via a queue-shaped trigger ingest endpoint.
4. Thodare creates N runs; each runs independently.

**v0.3 follow-up:** `POST /api/workflows/:id/run-batch` accepting `{ inputs: Array<{ input, idempotencyKey? }> }` returning `{ runIds: string[], skipped: [...] }`. The patch endpoint already supports the `?stream=ndjson` mode (proposal v2 §6); the batch run endpoint should as well so the caller can read each runId as it lands.

## 8. The connector-set per vertical

Each use case ships ~20-50 vertical-specific connectors. Common categories:

| Category | Notification | Sales Funnel | Marketing Automation |
|---|---|---|---|
| Triggers | event triggers (`app_opened`, etc.) | page views, form submits | event triggers (`order_placed`, etc.) |
| Sends | push, email, SMS | (built-in: serve-page) | email, SMS, push |
| Personalization | template renderer | template renderer | template renderer + tokens |
| Branching | segment membership, RFM, behavior | UTM, geo, prior-purchase | LTV percentile, engagement score |
| Waits | duration, until-time, until-quiet-end | duration, for-event-with-timeout | duration, until-optimal-time |
| External | analytics, CRM sync | Stripe, affiliate tracking, CRM | analytics, CDP, ML services |
| Compliance | opt-out check | (less relevant) | opt-out, frequency cap, GDPR |

**Pattern recommendation:** these are NOT shipped as part of Thodare core. Each vertical SaaS ships its own connector library as their proprietary IP. Thodare only ships the substrate + a tiny set of primitive connectors (HTTP, transform, schedule, wait_*).

That keeps Thodare's core small + lets the vertical SaaS differentiate.

## 9. The "deploy your customer's funnel under their domain" pattern

Sales-funnel + notification platforms often need to host customer-facing endpoints under the customer's branded domain (`go.acme-coach.com` not `funnels.funnelforge.com`).

This is platform-specific:

- **Cloudflare:** Cloudflare for SaaS — Thodare's adapter declares the catch-all route; CF SaaS handles the SSL + domain routing.
- **Vercel:** Vercel Custom Domains API — JourneyHQ's frontend adds customer domains via API.
- **AWS:** API Gateway custom domains + ACM certificates.

**Pattern recommendation:** the founder's frontend handles domain CRUD; Thodare's API doesn't get involved. The trigger-ingestion endpoint just needs to know which org a request belongs to (resolved by the edge layer via SNI / Host header).

## 10. The "subscriber state outside the run" pattern

Both notification-platform and marketing-automation need **per-subscriber state that lives outside any single run**:

- Frequency caps: "this user has gotten 3 emails today; suppress."
- Engagement scores: "this user opens 80% of emails."
- Channel opt-ins: "this user opted out of SMS but kept email."
- Last-flow-entry timestamps: "this user entered the welcome flow 5 min ago; don't re-enter."

This state is queried *during* runs (inside connector `execute()`s) and updated *after* events.

**Pattern recommendation:** the founder builds a separate domain DB for subscriber state. Thodare's connectors call out to it. **Don't use Thodare's run state for this** — runs are per-journey-instance, not per-subscriber.

The founder might consider:

- One Postgres for Thodare's state (`workflow.*` schema).
- One Postgres for their subscriber state (`subscribers`, `events`, `engagement_scores`, etc.).
- (Or: same database, separate schemas.)

This is a documentation pattern, not a Thodare feature.

---

## What this means for the proposal

The use cases collectively validate **most of the v2 proposal's prioritized gaps** + add a handful of v0.3-targeted asks:

**Proposal v2 features already prioritized that these use cases need:**

- ✅ First-class `Credential` primitive (v0.2 Phase 2) — every use case
- ✅ `wait_until_timestamp` accepting absolute Date (v0.2 — lifted from WDK) — every use case
- ✅ Container blocks (v0.2 P1) — marketing-automation especially
- ✅ Dynamic schema endpoint (v0.2 P1) — every use case
- ✅ NDJSON op-streaming (v0.2 §6) — every visual-builder canvas
- ✅ `resumeFromStep` + `recover` (v0.2 §3.1) — drop-off recovery
- ✅ `removed` entry kind (v0.2 §3.6) — graph-evolution against in-flight runs

**v0.3 follow-ups specifically motivated by these use cases:**

- 🆕 `runWorkflowBatch(name, inputs[])` API — segment fanout
- 🆕 `POST /api/workflows/:id/run-batch?stream=ndjson` — batched trigger ingestion
- 🆕 Trigger-level deduplication (`deduplicate: { keyField, windowMinutes }`)
- 🆕 Native A/B-split block with auto-tracked variant performance (deferred from userland)
- 🆕 Account-sharding strategy for `backend-cloudflare` (noisy-neighbor mitigation at vertical-SaaS scale)
- 🆕 Documented pattern for per-subscriber state in a separate DB (docs only)
- 🆕 Documented pattern for piping `step_completed` to ClickHouse/BigQuery for analytics (docs only)

**These use cases prove the headless-substrate goal is real.** Three multi-hundred-million-dollar verticals all collapse to "drag-and-drop workflows over user behavior." Thodare can serve all three without changing its core abstractions, with a focused gap-closure effort that's already on the proposal's roadmap.
