# Use case: Sales funnel platform (ClickFunnels / GoHighLevel / Systeme.io class)

## 1. The product premise

A SaaS that lets entrepreneurs and marketing agencies build sales funnels — multi-page journeys that turn cold traffic into paying customers. The customer (a course creator, agency, info-product seller) drags pages onto a canvas: landing → opt-in → upsell → checkout → thank-you → drip emails. Each page is a hosted webpage; transitions between pages are conditional on the visitor's actions; abandonment triggers email/SMS recovery flows. The funnel is the product the customer designs; the SaaS runs it.

Real-world examples: ClickFunnels, GoHighLevel (HighLevel), Systeme.io, Kajabi (funnel side), Kartra, FunnelKit (WP), GrooveFunnels.

## 2. Why this is workflow-shaped

A sales funnel is **literally a state machine over visitor sessions** that ClickFunnels et al. built bespoke runtime infrastructure for. The runtime needs:

- **HTTP triggers** for page views + form submits (every page request is a workflow event)
- **Conditional routing** (segmentation by UTM, geo, device, prior purchase)
- **Wait + timeout patterns** (cart abandonment = "wait for purchase event, timeout after 1h, send recovery email")
- **External system integration** (Stripe / Square for payment; Mailgun / SendGrid for email; Twilio for SMS)
- **Per-visitor state** (cookie + session carrying through the funnel)
- **A/B testing of page variants** at every step
- **Affiliate tracking** with deferred commission payouts
- **Multi-product upsell paths** with skip logic ("if they bought the bump, skip Upsell #2")

This is one of the cleanest workflow-engine fits in the SaaS landscape. ClickFunnels' platform IS a workflow engine with a vertical UI on top.

## 3. The founder's POV — what they define

A team of 4-5 founds "FunnelForge." They use Thodare as the durable backend + state engine. They write the page renderer, the funnel canvas, and the connector library.

### 3.1 The "page" is itself a connector

The unique twist for this use case: **funnel "pages" are not external — they're connectors that render HTML responses**. The visitor's browser hits a URL; the URL maps to a workflow run; the run's first block renders a page; subsequent visitor actions (form submit, button click) advance the run.

```ts
// connectors/serve-landing-page.ts
import { defineConnector } from "@thodare/engine";
import { z } from "zod";

export const serveLandingPage = defineConnector({
  type: "serve_landing_page",
  kind: "trigger",                              // entrypoint — visitor hits the page URL
  name: "Serve Landing Page",
  category: "page",
  params: z.object({
    template: z.string().describe("FunnelForge template id (chosen in their visual builder)"),
    headline: z.string(),
    subheadline: z.string().optional(),
    ctaText:  z.string().default("Get Started"),
    abTestVariant: z.enum(["A", "B"]).optional(),  // assigned by FunnelForge's A/B engine
  }),
  outputs: z.object({
    visitorId:   z.string(),                    // cookie-based, set on first visit
    sessionId:   z.string(),
    utmSource:   z.string().optional(),
    utmMedium:   z.string().optional(),
    utmCampaign: z.string().optional(),
    deviceType:  z.enum(["mobile", "tablet", "desktop"]),
    geoCountry:  z.string().length(2),
    referrer:    z.string().url().optional(),
  }),
  // No execute() — this is a trigger. FunnelForge's edge worker matches the
  // URL to this block, renders the HTML server-side, sets visitor cookies,
  // POSTs to /api/workflows/:id/run with the visitor context as input.
});
```

### 3.2 Capture-then-route pattern

```ts
// connectors/capture-lead.ts
export const captureLead = defineConnector({
  type: "capture_lead",
  kind: "compute",
  name: "Capture Lead Form",
  category: "form",
  params: z.object({
    requireEmail: z.boolean().default(true),
    requirePhone: z.boolean().default(false),
    customFields: z.array(z.object({ name: z.string(), required: z.boolean() })).optional(),
  }),
  outputs: z.object({
    leadId: z.string(),
    email:  z.string().email().optional(),
    phone:  z.string().optional(),
    custom: z.record(z.string(), z.string()),
  }),
  // This block "blocks" until the visitor submits the form. The run is paused;
  // FunnelForge's frontend POSTs the form data to /api/runs/:runId/resume?step=<this>
  // → openworkflow's step.waitForSignal resumes with the form payload as the result.
  async execute(params, ctx) {
    // The execute() returns a PauseInfo that maps to a wait-for-form-submit signal
    return {
      __paused: true,
      reason: "wait_for_event",
      resumeOnEvent: "form_submit",
      correlationKey: ctx.input.sessionId,         // correlation = visitor session
      resumeToken: crypto.randomUUID(),
    };
  },
});
```

### 3.3 Branching on visitor action

```ts
// connectors/branch-on-purchase.ts
export const branchOnPurchase = defineConnector({
  type: "branch_on_purchase",
  kind: "compute",
  name: "Branch on Purchase Outcome",
  category: "logic",
  params: z.object({}),
  outputs: z.object({
    purchased: z.boolean(),
    productSku: z.string().optional(),
    amountCents: z.number().int().optional(),
  }),
  // Two sourceHandles: "purchased" and "abandoned"
  // The block expects ctx.input to carry the previous step's payment result
  async execute(_, ctx) {
    const prev = ctx.input as { stripePaymentStatus?: string };
    if (prev.stripePaymentStatus === "succeeded") {
      return { purchased: true, productSku: prev.productSku, amountCents: prev.amountCents };
    }
    return { purchased: false };
  },
});

// connectors/wait-for-cart-abandonment.ts
export const waitForCartAbandonment = defineConnector({
  type: "wait_for_cart_abandonment",
  kind: "wait",
  name: "Wait for Purchase or Abandonment",
  category: "logic",
  params: z.object({
    timeoutMinutes: z.number().int().min(1).max(10080).default(60),  // up to 1 week
  }),
  outputs: z.object({
    outcome: z.enum(["purchased", "abandoned"]),
    payload: z.unknown(),
  }),
  async execute(params, ctx) {
    return {
      __paused: true,
      reason: "wait_for_event",
      resumeOnEvent: "stripe_payment_completed",
      correlationKey: ctx.input.sessionId,
      timeoutMs: params.timeoutMinutes * 60_000,
      resumeToken: crypto.randomUUID(),
    };
  },
});
```

### 3.4 Process payment as a connector

```ts
// connectors/process-payment.ts
export const stripeProcessPayment = defineConnector({
  type: "stripe_process_payment",
  kind: "compute",
  name: "Stripe: Process Payment",
  category: "payment",
  credential: { required: true, type: "stripe-restricted-key", requiredScopes: ["payment_intents"] },
  params: z.object({
    amountCents:  z.number().int().min(50),
    currency:     z.string().length(3).default("usd"),
    description:  z.string(),
    customerEmail: z.string().email(),
    paymentMethodId: z.string(),                  // collected by FunnelForge's checkout iframe
  }),
  outputs: z.object({
    stripePaymentStatus: z.enum(["succeeded", "requires_action", "failed"]),
    chargeId: z.string().optional(),
    failureReason: z.string().optional(),
  }),
  async execute(params, ctx) {
    const stripe = createStripeClient(ctx.credential.secretKey);
    const intent = await stripe.paymentIntents.create({
      amount: params.amountCents,
      currency: params.currency,
      payment_method: params.paymentMethodId,
      confirm: true,
      description: params.description,
      receipt_email: params.customerEmail,
    });
    return mapStripeStatus(intent);
  },
});
```

## 4. The end user's POV — what the marketer sees

A course creator, "Acme Coaching," logs into FunnelForge and drags this funnel:

```
[Trigger: Serve Landing Page]
   template = "long-form-vsl-1"
   headline = "Make Your First $10k as a Coach"
   ↓
[Capture Lead Form]
   requireEmail = true
   ↓
[Branch on Form Submit]
   ├─ (submitted) ↓
   │  [Serve Page: Order Form]   template = "order-form-1"
   │     ↓
   │  [Process Payment]   amountCents = 19700  // $197 main offer
   │     ├─ (succeeded) ↓
   │     │  [Serve Page: Upsell #1]   template = "upsell-1", amountCents = 9700
   │     │     ↓
   │     │  [Branch on Purchase]
   │     │     ├─ (purchased) → Upsell #2
   │     │     └─ (abandoned) → Confirmation page
   │     │  [Serve Page: Confirmation]
   │     │     ↓
   │     │  [Send Email Sequence]   sequenceId = "post-purchase-onboarding"
   │     │     ↓ END
   │     └─ (failed) → "Payment Failed" page → END
   │
   └─ (abandoned) ↓
      [Wait: 30 minutes]
        ↓
      [Send Email]   template = "abandoned-cart-1", subject = "You forgot something..."
        ↓
      [Wait: 4 hours]
        ↓
      [If Email Opened]
        ├─ (opened) → END
        └─ (not opened) ↓
           [Send SMS]   message = "Quick reminder: your coaching spot is reserved..."
           → END
```

That entire diagram is one workflow JSON. Visitors enter at the top; their state propagates through the connections. Behind the scenes:

- Each visitor session = one Thodare run.
- Page connectors are triggers OR compute blocks that pause via `wait_for_event` until the visitor advances.
- Cart abandonment is a `wait_for_event` with `timeoutMs: 30 * 60_000`.
- The funnel's "page renderer" (FunnelForge's edge worker) maps `https://funnel.acme-coach.com/vsl-1` → `runWorkflow("vsl-funnel", { sessionId, ... })`, holds the HTTP response open, and pipes the first `serve_landing_page` block's render to the visitor.
- Subsequent visitor actions (form submit, payment) call `signal(runId, eventName, payload)` on Thodare to advance the run.

## 5. Deployment recommendation

This use case is **edge-heavy** — the workflow runtime serves user-facing webpages, not just background automation. Latency matters.

**Recommended: `backend-cloudflare`.**

- Pages serve from the edge (Workers); the runtime walker IS the request handler.
- D1 stores funnel JSON + visitor sessions; DO holds per-session state.
- CF Queues handles the email/SMS dispatch (`__wkf_step_*`).
- No regional latency for the page-serving path.
- Scales to zero off-hours; pay-per-visitor.

**Alternative: `backend-vercel`.**

- Vercel Edge Functions for page rendering.
- Vercel Postgres for state.
- Simpler if FunnelForge already uses Vercel for their dashboard.
- Slightly higher latency than CF but better DX.

**NOT recommended for this use case: `backend-self-host-postgres`.**

- Funnel hosting needs global edge to keep page-load times below the threshold where conversion drops. A single-region Postgres + worker pod adds 100-300ms per page load for international visitors. Acceptable for the marketer dashboard; unacceptable for the visitor-facing pages.

## 6. What Thodare provides vs. what FunnelForge builds

| Concern | Thodare provides | FunnelForge builds |
|---|---|---|
| Workflow definition + storage | ✅ | — |
| Trigger → run dispatch | ✅ | URL matcher + ingestion edge worker |
| Conditional routing via `sourceHandle` | ✅ | — |
| `wait_for_event` with timeout | ✅ | — |
| Credential vault (Stripe key per customer) | ✅ (v1.0) | — |
| Run state persistence + replay | ✅ | — |
| Multi-tenant (per-customer org) | ✅ T11 | — |
| Page renderer (HTML templating + CDN) | — | their domain |
| Drag-and-drop funnel canvas | — | their domain |
| A/B testing engine + variant assignment | — | their domain (built on top of Thodare's `random_split` block) |
| Affiliate tracking | — | their domain |
| Stripe / Mailgun / Twilio integrations | — | as Thodare connectors |
| Visitor analytics dashboard | — | their domain (queries Thodare's `Storage.steps.list` for funnel drop-off) |
| Subscription billing | — | their Stripe wiring |
| Hosted custom domains for customer funnels | — | their CF Workers Custom Domains config |

The unique twist for FunnelForge: their page renderer + their canvas are bigger pieces of their value than for the notification platform. Thodare provides ~40% of the engineering here vs. ~60% for the notification platform — because pages-as-state-machines is half the product.

## 7. Open gaps in Thodare today

| Gap | Why this use case needs it | Severity |
|---|---|---|
| Synchronous block return for page rendering | Today Thodare runs are fire-and-forget. For "render the next page in the funnel" the runtime needs `runWorkflow` to *block* the HTTP response until the first compute block returns its render output. | **P1** for this use case |
| Per-step input/output streaming | Page rendering wants to stream HTML; today Thodare's `Storage.steps.list` returns final outputs only. | **P2** (lift WDK's `getWritable<T>()` pattern) |
| HTTP-as-trigger (URL → workflow) routing | Today `POST /api/workflows/:id/run` is the trigger. For URL-based funnel pages, FunnelForge needs an extension that matches arbitrary URL patterns to workflows. | **P1** — could ship as a separate `@thodare/router` package |
| Conditional resume by correlation key | `wait_for_event` already supports correlation keys; the implementation needs to be airtight at funnel scale (millions of concurrent waiting runs, each correlated by `sessionId`). | **P2** — the openworkflow runtime already does this; `backend-cloudflare` adapter needs to verify behavior at scale |
| Affiliate-style "schedule-this-later" side effect block | Affiliate commission payouts need to fire 30 days after purchase (refund window). A `wait_duration("30d")` block + `pay_affiliate` works but ties up a run slot for 30 days. Worth optimizing as a "schedule-detached" pattern in v1.1. | **P3** |
| Branching on payment outcome | Already supported via `sourceHandle`; just needs documentation pattern. | works today |
| Cart-abandonment `wait_for_event` with timeout | Already supported via `PauseInfo.timeoutMs`. | works today |

## 8. The five-line pitch FunnelForge puts on its homepage

> **FunnelForge** is the open way to build sales funnels. Drag pages onto a canvas. Conditional logic. Cart-abandonment recovery. Stripe checkout. Hosted on your own domain at the edge. No vendor lock-in.
>
> *Built on Thodare — the open-source headless workflow engine. We focus on the page-serving + funnel canvas; the durable orchestration is handled.*

ClickFunnels charges $97-297/mo per customer. FunnelForge running on `backend-cloudflare` pays roughly $0.0006 per visitor at full conversion-funnel load (per `research/cloudflare-as-world.md` math). At a 1% margin against ClickFunnels' price, FunnelForge is profitable from customer #1.

That margin is the headless-substrate value proposition. It exists because Thodare absorbs the engineering that would otherwise be "reimplement Temporal / Inngest / openworkflow internally."
