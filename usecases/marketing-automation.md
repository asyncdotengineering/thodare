# Use case: Marketing automation (Klaviyo / Customer.io / Iterable / Braze class)

## 1. The product premise

A SaaS that lets ecommerce brands and B2C apps run **behavior-triggered customer journeys** across email + SMS + push. The customer (a Shopify brand, a fitness app, a meditation startup) ingests events from their platform — product views, purchases, signups, abandoned carts, content consumption — and uses the SaaS to design "flows" that respond. The flows can run for months: welcome series → engagement → re-engagement → win-back. The platform handles segmentation, deliverability, A/B testing, predictive analytics, and the brand's compliance with email regulations.

Real-world examples: Klaviyo (public, ~$2B revenue), Customer.io, Iterable, Braze (public, ~$500M revenue), MoEngage, Bloomreach Engagement (formerly Exponea).

This is the largest of the three use-case categories by market size — and the most workflow-heavy.

## 2. Why this is workflow-shaped

Marketing automation is **the canonical workflow-as-product domain.** Klaviyo's "Flows" are literally drag-and-drop workflows. Every flow is:

- **Triggered by an event** (`order_placed`, `cart_created_with_value_over_50`, `session_idle_for_7_days`, `birthday`)
- **Branches by user properties** (lifecycle stage, RFM segment, engagement score, last channel responded to)
- **Waits between sends** (drip cadence: welcome series spaced 1d / 3d / 7d / 14d)
- **Listens for downstream events** (sent email → wait for `email_opened` / `purchase_made`; branch accordingly)
- **Renders templated content** with personalization tokens
- **Respects user preferences** (frequency caps, channel opt-outs, quiet hours, GDPR basis)
- **Reports on conversion at every step** (drop-off analytics: "50% open rate, 8% click, 1.2% revenue")

A Klaviyo flow with 30+ blocks is normal. Some sophisticated brands run flows with 100+ blocks across multiple channels. The runtime requirements are the deepest of any vertical:

- Multi-month runs
- Millions of concurrent waiting subscribers
- Per-subscriber state (which flows are they in? what's their engagement score?)
- Predictive ML integration (LTV scoring, churn risk, send-time optimization)
- Tight observability (drop-off analysis is the marketer's whole job)

## 3. The founder's POV — what they define

A team of 6-8 founds "JourneyHQ." Klaviyo-class product. They use Thodare for the orchestration core + build the email rendering, SMS gateway, predictive layer, and marketer canvas.

### 3.1 Event-shape connectors (the trigger layer)

```ts
// connectors/triggers.ts
import { defineConnector } from "@thodare/engine";
import { z } from "zod";

export const onCustomerEvent = defineConnector({
  type: "trigger_customer_event",
  kind: "trigger",
  name: "On Customer Event",
  category: "triggers",
  params: z.object({
    eventName: z.string()
      .describe("e.g. 'placed_order', 'viewed_product', 'started_checkout', 'unsubscribed'"),
    filter: z.array(z.object({
      field: z.string(),                              // dot-path e.g. "order.value"
      op:    z.enum(["eq","neq","gt","gte","lt","lte","contains","exists","in"]),
      value: z.unknown().optional(),
    })).optional(),
    deduplicate: z.object({
      keyField: z.string(),                            // e.g. "customer.id"
      windowMinutes: z.number().int().default(60),     // suppress re-entry for N minutes
    }).optional(),
  }),
  outputs: z.object({
    customerId: z.string(),
    customerEmail: z.string().email(),
    customerProperties: z.record(z.string(), z.unknown()),
    eventName: z.string(),
    eventProperties: z.record(z.string(), z.unknown()),
    timestamp: z.string(),
  }),
});

export const onSegmentEntry = defineConnector({
  type: "trigger_segment_entry",
  kind: "trigger",
  name: "On Segment Entry",
  category: "triggers",
  params: z.object({
    segmentId: z.string(),
    triggerOnExit: z.boolean().default(false),         // also fire when leaving
  }),
  outputs: z.object({
    customerId: z.string(),
    enteredAt: z.string(),
    direction: z.enum(["entered", "exited"]),
  }),
});
```

### 3.2 The send-then-wait pattern (the workflow's core)

```ts
// connectors/send-email.ts
export const sendEmailCampaign = defineConnector({
  type: "send_email_campaign",
  kind: "compute",
  name: "Send Email",
  category: "messaging",
  credential: { required: true, type: "sendgrid" },
  params: z.object({
    templateId: z.string(),                            // JourneyHQ template id
    subject: z.string(),
    fromName: z.string(),
    fromEmail: z.string().email(),
    replyTo:  z.string().email().optional(),
    personalize: z.record(z.string(), z.string()),     // template tokens
  }),
  outputs: z.object({
    messageId: z.string(),                             // ESP-side id, used for tracking
    sentAt: z.string(),
    suppressed: z.boolean(),                           // true if frequency cap / preference suppressed
    suppressionReason: z.string().optional(),
  }),
  async execute(params, ctx) {
    // 1. Check frequency cap
    if (await frequencyCapExceeded(ctx.input.customerId)) {
      return { messageId: "", sentAt: "", suppressed: true, suppressionReason: "frequency_cap" };
    }
    // 2. Check channel opt-in
    if (!await isOptedIn(ctx.input.customerId, "email")) {
      return { messageId: "", sentAt: "", suppressed: true, suppressionReason: "channel_optout" };
    }
    // 3. Render template
    const html = await renderTemplate(params.templateId, params.personalize);
    // 4. Send via ESP
    const result = await sendgridClient(ctx.credential).send({ to: ctx.input.customerEmail, ... });
    return { messageId: result.messageId, sentAt: new Date().toISOString(), suppressed: false };
  },
});

// connectors/wait-for-email-event.ts
export const waitForEmailEvent = defineConnector({
  type: "wait_for_email_event",
  kind: "wait",
  name: "Wait for Email Open / Click / Conversion",
  category: "logic",
  params: z.object({
    eventType: z.enum(["opened", "clicked", "converted", "any"]),
    timeoutMinutes: z.number().int().min(1).default(60 * 24),  // default 24h
  }),
  outputs: z.object({
    triggered: z.boolean(),                            // false if timed out
    eventType: z.string().optional(),
    occurredAt: z.string().optional(),
  }),
  async execute(params, ctx) {
    return {
      __paused: true,
      reason: "wait_for_event",
      // The previous send_email_campaign block put messageId in ctx.input.prevOutput
      resumeOnEvent: `email_${params.eventType}`,
      correlationKey: ctx.input.prevOutput.messageId,
      timeoutMs: params.timeoutMinutes * 60_000,
      resumeToken: crypto.randomUUID(),
    };
  },
});
```

### 3.3 Predictive blocks (the moat)

```ts
// connectors/predict-ltv.ts
export const predictLTV = defineConnector({
  type: "predict_ltv",
  kind: "compute",
  name: "Predict Lifetime Value",
  category: "ai",
  description: "Returns a predicted 12-month LTV for the customer. Updates daily.",
  params: z.object({
    horizon: z.enum(["3m", "6m", "12m", "24m"]).default("12m"),
  }),
  outputs: z.object({
    ltv: z.number(),                                   // in customer's account currency
    confidence: z.enum(["low", "medium", "high"]),
    percentile: z.number().min(0).max(100),            // vs. all customers in account
  }),
  async execute(params, ctx) {
    return await journeyHqMlService.predictLTV(ctx.input.customerId, params.horizon);
  },
});

export const branchOnLTV = defineConnector({
  type: "branch_on_ltv",
  kind: "compute",
  name: "Branch by LTV Percentile",
  category: "logic",
  params: z.object({
    threshold: z.number().min(0).max(100).default(80),
  }),
  outputs: z.object({ isHighValue: z.boolean() }),
  // Two sourceHandles: "high_value" and "standard"
  async execute(params, ctx) {
    return { isHighValue: ctx.input.prevOutput.percentile >= params.threshold };
  },
});

// connectors/optimal-send-time.ts
export const waitForOptimalSendTime = defineConnector({
  type: "wait_for_optimal_send_time",
  kind: "wait",
  name: "Wait for Optimal Send Time",
  category: "ai",
  description: "Waits until the customer's predicted-best send time today.",
  params: z.object({
    fallbackHourLocal: z.number().int().default(10),
  }),
  outputs: z.object({ sentAt: z.string() }),
  async execute(params, ctx) {
    const customer = await fetchCustomer(ctx.input.customerId);
    const optimal = await journeyHqMlService.predictOptimalSendTime(customer.id);
    return {
      __paused: true,
      reason: "wait_until_timestamp",
      resumeAt: optimal.toISOString(),
      resumeToken: crypto.randomUUID(),
    };
  },
});
```

### 3.4 Container blocks for the journey graph

These don't exist in Thodare today (P1 in proposal v2 §2.4). JourneyHQ would extend with:

```ts
// connectors/foreach-segment-member.ts — needs container-block primitive
export const foreachSegmentMember = defineConnector({
  type: "foreach_segment_member",
  kind: "container",                                    // NEW kind, not yet in Thodare
  name: "For Each Customer in Segment",
  category: "logic",
  params: z.object({
    segmentId: z.string(),
    parallelism: z.number().int().min(1).max(1000).default(100),
  }),
  // Body of the loop runs per customer; one workflow run per iteration
});

// connectors/parallel-channels.ts — fan-out across email + SMS + push
export const parallelChannels = defineConnector({
  type: "parallel_channels",
  kind: "container",
  name: "Send via All Channels in Parallel",
  category: "logic",
  // Forks into N parallel branches; collects when all complete
});
```

## 4. The end user's POV — what the marketer sees

A retention marketer at "Acme Apparel" (Shopify brand, $20M revenue, 200k subscribers) logs into JourneyHQ and builds the post-purchase flow:

```
[Trigger: placed_order]
   filter: order.value >= 50
   ↓
[Predict LTV]
   horizon = "12m"
   ↓
[Branch by LTV Percentile]   threshold = 80
   ├─ (high_value) ↓
   │  [Wait: 1 hour]
   │     ↓
   │  [Send Email]   template = "vip-thank-you", subject = "Welcome to the VIP family"
   │     ↓
   │  [Wait: 7 days]
   │     ↓
   │  [Wait for Optimal Send Time]
   │     ↓
   │  [Send Email]   template = "vip-second-purchase-incentive", subject = "Your exclusive 25% off"
   │     ↓
   │  [Wait for Email Event]   eventType = "converted", timeoutMinutes = 7d
   │     ├─ (converted) → END
   │     └─ (timeout) ↓
   │        [Send SMS]   message = "Hey {{firstName}}, your 25% off expires tomorrow"
   │        → END
   │
   └─ (standard) ↓
      [Wait: 3 hours]
        ↓
      [Send Email]   template = "thank-you-standard", subject = "Order confirmed"
        ↓
      [Wait: 14 days]
        ↓
      [If In Segment: "engaged_subscribers"]
        ├─ (in_segment) ↓
        │  [Send Email]   template = "cross-sell-1", subject = "You might also love..."
        │     ↓
        │  [Wait for Email Event]   eventType = "clicked", timeoutMinutes = 3d
        │     ├─ (clicked) ↓
        │     │  [Send Email after 1d]   template = "cross-sell-followup"
        │     │  → END
        │     └─ (timeout) → END
        └─ (out_of_segment) → END
```

Behind the scenes:

- The flow is one workflow JSON in Thodare scoped to Acme Apparel's org.
- When a Shopify webhook fires `order_placed` for an Acme customer, JourneyHQ's ingestion endpoint POSTs to `/api/workflows/post-purchase/run` with `{ input: { customerId: "c_abc", order: {...} } }`.
- Thodare creates one run per qualifying purchase. **Multiple thousand concurrent runs** at peak Shopify traffic.
- Each `wait_duration` block parks the run via `step.sleep` — no compute consumed during the wait.
- Each `wait_for_email_event` parks via `step.waitForSignal` correlated to the message id; when SendGrid's webhook reports an open/click/conversion, JourneyHQ's ingestion calls `backend.signal(runId, "email_clicked", payload)` to advance.
- The marketer's drop-off dashboard queries `Storage.steps.list({ workflowId, organizationId })` to compute "50% reach this step, 12% convert" per node.

## 5. Deployment recommendation

Three-stage scaling. JourneyHQ would document this for self-hosting customers + run all three internally for their managed cloud.

### Stage 1 — Pilot / first 50 customers

`backend-self-host-postgres`. Single Postgres + 2 worker pods. ~$300/mo. Suitable up to ~10M workflow events/day.

### Stage 2 — Growth / 50-500 customers

`backend-self-host-postgres` with Postgres scaled out (Aurora Serverless v2 or Neon Pro at ~$500/mo) + 6-12 worker pods. Up to ~100M events/day. Read replicas for the analytics dashboard.

### Stage 3 — Scale / 500+ customers, billions of events/month

`backend-aws` for high throughput + cost control:
- RDS Postgres (db.r6g.4xlarge multi-AZ) for state + analytics.
- SQS for queue (FIFO per-customer org for ordering).
- Lambda for step execution (scales to zero between bursts).
- DynamoDB for per-subscriber state (frequency caps, opt-ins).
- ClickHouse (separate from Thodare; queried for customer-facing analytics).

OR `backend-cloudflare` if global edge ingestion is the priority (CF Workers at the SDK ingestion endpoint). The two adapters are not mutually exclusive — JourneyHQ could run `backend-cloudflare` for the trigger ingestion + `backend-aws` for the heavy backend orchestration via Thodare's queue federation (deferred to v0.3).

## 6. What Thodare provides vs. what JourneyHQ builds

| Concern | Thodare | JourneyHQ |
|---|---|---|
| Workflow definition + persistence | ✅ | — |
| EditOp patch loop (LLM + canvas) | ✅ | — |
| Run state + replay + retries | ✅ | — |
| Long durable sleeps (months) | ✅ via `step.sleep` | — |
| `wait_for_event` with correlation + timeout | ✅ | — |
| Multi-tenant per-org isolation | ✅ T11 | — |
| Credential vault (SendGrid, Twilio, ESP) | ✅ v0.2 | — |
| Live SSE for run timeline | ✅ | — |
| Step IO for drop-off analytics | ✅ via `Storage.steps.list` | drop-off dashboards |
| Predictive ML (LTV, churn, send-time) | — | their domain — exposed as connectors |
| Email rendering engine (MJML / MFML) | — | their domain |
| ESP integrations (SendGrid / Mailgun / SES / SparkPost) | — | as connectors |
| SMS gateway (Twilio / Vonage / Bandwidth) | — | as connectors |
| Frequency caps + opt-in tracking | — | their domain (consulted inside `send_email`) |
| Subscription billing | — | their Stripe |
| Customer-facing canvas + reporting UI | — | their frontend |
| Deliverability (DKIM, SPF, DMARC, dedicated IPs) | — | their domain (massive engineering effort) |
| List hygiene (bounce handling, suppression) | — | their domain |
| GDPR / CAN-SPAM compliance tooling | — | their domain |

This is the use case where **Thodare provides the smallest fraction of the engineering** (~25%) — because email/SMS/SMS deliverability is a huge separate engineering domain. But Thodare provides **the right 25%**: the part that's hardest to build from scratch and that nobody else open-sources.

## 7. Open gaps in Thodare today

This use case stresses Thodare more than any other. The proposal v2 already has many of these as P0/P1 items; this use case validates priority.

| Gap | Why this use case needs it | Severity |
|---|---|---|
| **Container blocks (loop, parallel, branch)** | "For each customer in segment", "send via parallel channels", "branch by LTV bucket". Klaviyo flows ARE container-heavy. | **P0** for this use case (P1 in proposal) |
| **Per-subscriber state outside the run** | Frequency caps, opt-in status, last-engagement-time live OUTSIDE individual runs (cross-flow visibility). Workflows need a `read_subscriber_state` block + transactional update. | **P0** for this use case — JourneyHQ would build this as their domain DB; document the pattern |
| **`wait_until_timestamp` with timezone awareness** | "Send at 9am in customer's local timezone" is the most common pattern in marketing automation. Thodare's `wait_duration` is timezone-naive. | **P1** — extension that takes (timezone, hour, minute) and computes a Date |
| **Trigger deduplication** | A customer who triggers `viewed_product` 50 times in 5 minutes shouldn't enter the journey 50 times. Need built-in dedupe with windowing. | **P1** — could be a trigger-level option `deduplicate: { keyField, windowMinutes }` |
| **Frequency cap enforcement** | Cross-flow: "this customer already got 3 emails today, suppress". Currently each `send_email` block must check externally. Could be an engine-level concern. | **P2** — best left to JourneyHQ's domain layer |
| **High-cardinality fan-out (segment → millions of runs)** | "Run this flow for every customer in segment X" can mean millions of run dispatches in seconds. Thodare's `runWorkflow` API isn't shaped for that throughput. | **P2** — likely needs a dedicated `runWorkflowBatch(name, inputs[])` API for v0.3 |
| **Drop-off analytics queries at scale** | Marketer dashboard wants "for this flow over the last 30 days, how many subscribers reached step N, how many converted at step N+1, average time between, etc." Thodare's `Storage.steps.list` returns rows; analytics need OLAP queries. | **P3** — JourneyHQ pipes `step_completed` events to ClickHouse; document the pattern |
| **A/B testing primitive** | Currently can be expressed via a custom `random_split` block; could be an engine-level concept that auto-tracks variant performance. | **P3** — leave to userland |
| **Send-time scheduling at the queue layer** | "Schedule this email for delivery at exactly 2026-05-15T14:00:00Z" needs the queue to honor `delaySeconds` precisely. Both `backend-self-host-postgres` and `backend-cloudflare` support this. | works today |

## 8. The five-line pitch JourneyHQ puts on its homepage

> **JourneyHQ** is the open marketing-automation platform. Behavior-triggered customer journeys. AI-predicted send time and LTV. Email + SMS + push. Self-host on AWS or run on our managed cloud — same workflows, same UI, your data.
>
> *Built on Thodare — the open-source headless workflow engine. We focus on deliverability, predictive ML, and the marketer canvas; the durable orchestration is handled.*

Klaviyo is a $2B revenue company with thousands of engineers. JourneyHQ launches a credible competitor with 8 engineers because Thodare absorbs the orchestration layer. The vertical layer (rendering / deliverability / predictive / canvas) is still 8 engineers' worth of work — but it's the work that's actually *defensible*, not the workflow runtime that everyone keeps reinventing.

That's the multi-billion-dollar headless-substrate value proposition.
