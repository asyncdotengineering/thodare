# Use case: Notification platform (OneSignal / Pushwoosh / Iterable class)

## 1. The product premise

A SaaS that lets app developers send push notifications + emails + SMS to their users, triggered by user behavior or schedule. Customers integrate the SaaS's SDK into their mobile/web apps; the SaaS captures events (`app_opened`, `purchase_completed`, `cart_abandoned`); marketers at the customer's company drag "journey" workflows in a visual builder ("user opens app 3 days in a row → wait 24h → send re-engagement push → if not opened in 48h → send email"); the SaaS runs those journeys reliably across millions of subscribers.

Real-world examples: OneSignal, Pushwoosh, Iterable, Braze, Airship.

## 2. Why this is workflow-shaped

Every product feature in the category collapses to "user-defined workflow."

- **Drip campaigns** = linear sequences with `wait_duration` blocks between sends.
- **Behavior triggers** = workflows whose entrypoint is a `trigger_event` block matching a named event from the customer's app.
- **Branching journeys** = blocks with `sourceHandle: "engaged" | "ignored"` based on whether the user opened the previous message.
- **A/B testing** = a `random_split` block that routes 50/50 to two downstream branches.
- **Quiet hours** = a `wait_until_local_time` block that holds the user until 9am in their timezone.
- **Segmentation** = workflows whose audience is "everyone in segment X"; one workflow definition × N user runs.
- **Multi-channel orchestration** = a single workflow with `send_push` + `send_email` + `send_sms` blocks gated by user channel preferences.

This is **exactly** what Thodare's runtime walker + EditOp surface is designed for. The category exists because there isn't yet a great open-source headless engine for it; OneSignal et al. each built one.

## 3. The founder's POV — what they define

A team of 3-4 engineers founds "PushKit." They use Thodare as the durable backend. Here's what they write.

### 3.1 Vertical-specific connectors

```ts
// connectors/send-push.ts
import { defineConnector, defineCredentialType } from "@thodare/engine";
import { z } from "zod";

export const fcmCredentials = defineCredentialType({
  id: "fcm",
  type: "custom",
  displayName: "Firebase Cloud Messaging",
  properties: [
    { id: "serviceAccountJson", title: "Service Account JSON",
      type: "long-input", required: true },
    { id: "projectId",          title: "Firebase Project ID",
      type: "short-input", required: true },
  ],
  test: { /* declarative ping to FCM API */ },
});

export const sendPushNotification = defineConnector({
  type: "send_push",
  name: "Send Push Notification",
  category: "messaging",
  icon: "bell",
  credential: { required: true, type: "fcm", requiredScopes: [] },
  params: z.object({
    audienceMode: z.enum(["this-user", "segment", "topic"]).default("this-user"),
    segmentId:    z.string().optional(),       // when audienceMode === "segment"
    topic:        z.string().optional(),       // when audienceMode === "topic"
    title:        z.string(),                  // supports {{trigger.userName}} templating
    body:         z.string(),
    deepLink:     z.string().url().optional(),
    badge:        z.number().int().optional(),
    sound:        z.string().optional(),
  }),
  outputs: z.object({
    sent:        z.number().int(),
    failed:      z.number().int(),
    delivered:   z.array(z.object({ userId: z.string(), messageId: z.string() })),
  }),
  async execute(params, ctx) {
    const audience = await resolveAudience(params, ctx);  // queries the SaaS's user store
    const sa = JSON.parse(ctx.credential.serviceAccountJson);
    return await sendViaFcm(sa, params.projectId, audience, params);
  },
});
```

### 3.2 Custom trigger blocks

```ts
// connectors/triggers.ts
export const onUserEvent = defineConnector({
  type: "trigger_user_event",
  kind: "trigger",
  name: "On User Event",
  category: "triggers",
  params: z.object({
    eventName: z.string().describe("e.g. 'app_opened', 'purchase_completed'"),
    filter: z.object({
      property: z.string(),
      op: z.enum(["eq", "neq", "gt", "lt", "contains", "exists"]),
      value: z.unknown().optional(),
    }).array().optional(),
  }),
  outputs: z.object({
    userId:    z.string(),
    eventName: z.string(),
    properties: z.record(z.string(), z.unknown()),
    timestamp: z.string(),
  }),
  // Triggers don't have execute(); they're entrypoints. The PushKit ingestion
  // pipeline matches incoming events against this block's filters and triggers
  // the workflow with the event as input.
});
```

### 3.3 Vertical-specific blocks (built on Thodare primitives)

```ts
// connectors/wait-quiet-hours.ts — composes Thodare's wait_until block
export const waitQuietHours = defineConnector({
  type: "wait_quiet_hours",
  kind: "wait",
  name: "Wait until Quiet Hours End",
  description: "Holds the run until the user's local time is between 9am and 9pm.",
  params: z.object({
    earliestHourLocal: z.number().int().min(0).max(23).default(9),
    latestHourLocal:   z.number().int().min(0).max(23).default(21),
  }),
  outputs: z.object({ resumedAt: z.string() }),
  async execute(params, ctx) {
    const user = await fetchUser(ctx.input.userId);
    const target = computeNextWindowStart(user.timezone, params);
    return {
      __paused: true,
      reason: "wait_until_timestamp",
      resumeAt: target.toISOString(),
      resumeToken: crypto.randomUUID(),
    };
  },
});

// connectors/segment-membership.ts — branch block
export const ifInSegment = defineConnector({
  type: "if_in_segment",
  kind: "compute",
  name: "If User In Segment",
  category: "logic",
  params: z.object({ segmentId: z.string() }),
  outputs: z.object({ inSegment: z.boolean() }),
  // The block has 2 sourceHandles: "in_segment" and "out_of_segment"
  // Determined by inSegment value at runtime
  async execute(params, ctx) {
    const user = await fetchUser(ctx.input.userId);
    return { inSegment: await checkSegmentMembership(user.id, params.segmentId) };
  },
});
```

### 3.4 What the founder DOESN'T build

- Durable execution (Thodare engine + openworkflow)
- Workflow CRUD API (Thodare API)
- Credential vault + AES-256-GCM at rest (Thodare engine)
- Multi-tenant scoping per customer (Thodare API enforces T11)
- The patch loop (Thodare engine — used both by their canvas + their AI assistant)
- Run state / retries / sleeps that survive deploys (openworkflow / backend-cloudflare)
- Live SSE for the run timeline (Thodare API + backend capability)
- Step IO storage for "drop-off analysis" (Thodare's `Storage.steps.list`)

That's an entire engineering team's worth of work the founder skips.

## 4. The end user's POV — what the marketer sees

A growth marketer at "Acme Mobile" logs in to PushKit. They drag this journey:

```
[Trigger: app_opened, properties.firstSession === true]
   ↓
[Wait: 1 hour]
   ↓
[Send Push: title="Welcome to Acme!", body="Tap here to set up your profile"]
   ↓
[Wait for event: profile_completed, timeout: 24h]
   ├─ (resumed by event) → END
   └─ (timeout) ↓
[Send Push: title="Quick reminder", body="Finish setting up — takes 60 seconds"]
   ↓
[Wait: 3 days]
   ↓
[If In Segment: "active_users"]
   ├─ (in_segment) → END
   └─ (out_of_segment) ↓
[Send Email: subject="We miss you at Acme", template="winback-1"]
```

The marketer doesn't see Thodare. They see PushKit's branded canvas. Behind the scenes:

- Their drag emits an `EditOp[]` that PushKit's frontend POSTs to `/api/proxy/workflows/welcome-journey/operations` (the proxy adds the org's auth header).
- The workflow JSON is stored in Thodare's `workflow_workflows` table, scoped to Acme Mobile's organization.
- When an Acme user opens the app for their first session, Acme's mobile SDK fires an event to PushKit's ingestion endpoint. PushKit's ingestion service decides this matches the trigger filter, calls Thodare's `POST /api/workflows/welcome-journey/run` with `{ input: { userId: "u_123", properties: {...} } }`.
- Thodare creates a run; the runtime walker dispatches the trigger block (returns the input as-is); reaches the `wait_duration` block; openworkflow's `step.sleep("1h")` pauses for an hour without consuming compute; the run resumes; dispatches `send_push` (which calls FCM with the resolved credential); reaches `wait_for_event`; pauses until either `profile_completed` arrives or 24h elapses; branches; etc.
- Each step's input + output + duration is in `workflow_steps`, queryable by PushKit for their drop-off-analysis dashboard.

## 5. Deployment recommendation

Two paths depending on PushKit's stage:

### Stage 1 — alpha / first 100 customers

`backend-self-host-postgres` on Fly.io or Render.

- Single Postgres (Neon Pro: ~$70/mo).
- Two worker pods (Fly Machines: ~$60/mo).
- The PushKit Next.js frontend on Vercel (~$20/mo).
- **Total: ~$150/mo for the entire durable backend** at moderate volume (100k workflow runs/day).

### Stage 2 — scale (10M+ runs/day)

Migrate to `backend-cloudflare`.

- CF Workflows + Queues + DO + D1 + R2 — scales to zero off-hours.
- ~$6.1k/mo at 10M runs/day (per `research/cloudflare-as-world.md`).
- Live subscription via DO + WS for the canvas.
- **The migration is 8 lines of `thodare.config.ts` change** (see `research/developer-blueprint.md` §5).
- All existing customer workflows continue working; the End User UX is identical.

The substrate-swap promise made concrete.

## 6. What Thodare provides vs. what PushKit builds

| Concern | Thodare provides | PushKit builds |
|---|---|---|
| Durable execution + retries + sleeps | ✅ engine + backend | — |
| Workflow JSON storage + versioning | ✅ engine + API | — |
| EditOp patch loop with skip-don't-reject | ✅ engine + API | — |
| Multi-tenant scoping (per-customer org) | ✅ T11 enforcement | — |
| Credential vault + OAuth flows | ✅ engine + API (v0.2) | OAuth-provider-specific config |
| Live SSE run subscription | ✅ API + capability flag | — |
| Step IO inspection | ✅ Storage.steps.list | drop-off analytics on top |
| Connector registry inspection (`GET /api/connectors`) | ✅ API | — |
| Push delivery to FCM/APNs/web push | — | their connectors |
| Email rendering + send | — | their connectors |
| SMS via Twilio etc. | — | their connectors |
| Audience / segment store | — | their domain DB |
| Event ingestion at scale (millions of events/sec) | — | their ingestion service feeding `POST /api/workflows/:id/run` |
| Marketer canvas UI (custom-branded React Flow) | — | their frontend |
| Subscription billing | — | their Stripe wiring |
| User profile + timezone resolution | — | their domain DB |

Roughly: **Thodare provides ~60% of the engineering, by LOC.** PushKit builds the vertical (connectors + ingestion + canvas + analytics + billing).

## 7. Open gaps in Thodare today

Per `research/code-reviews/visual-builder-substrates.md` and `research/backend-abstraction-proposal.md` §2.4:

| Gap | Why this use case needs it | Severity |
|---|---|---|
| Container blocks (loops, parallel, branches) | "for each user in segment X, run this journey" needs a foreach container; A/B testing needs parallel branches | **P1** |
| `wait_until_timestamp` block accepting an absolute Date | Quiet-hours / "send at user's local 9am" patterns; birthday-card patterns | **P1** (lift from WDK's `sleep(Date)`) |
| Dynamic schema endpoint (`POST /api/connectors/:type/refresh`) | "Pick a segment" dropdown needs to fetch from PushKit's segment store at form-render time | **P1** |
| Output `hiddenFromDisplay` flag | A `fetchUserProfile` block returns the user's auth token for downstream personalization but the LLM should never reason about it | **P0** (Sim has it; Thodare doesn't) |
| `paramVisibility: 'llm-only'` | Computed values like `__internal_correlation_id` the LLM must fill but the marketer can't see in the form | **P0** |
| Native fan-out from a segment | One trigger event → one workflow run is fine. One *segment* → N runs (one per user) needs either a custom block that calls `runWorkflow` in a loop, or a native pattern. Scaling the loop pattern to 100M users requires throughput Thodare's API isn't currently shaped for. | **P2** |
| High-throughput trigger ingestion | At PushKit's scale, raw event volume is 100k events/sec. Each event → 0-N workflow runs. Thodare's API would need a queue-shaped trigger ingestion endpoint instead of one-run-per-HTTP-request. | **P2** for v0.2; **P0** for vertical SaaS scale |

The first 5 are already in the proposal v2's prioritized gap list. The last 2 are vertical-specific extensions that could be the topic of a v0.3 RFC ("Thodare for high-throughput verticals").

## 8. The five-line pitch PushKit puts on its homepage

> **PushKit** sends the right notification to the right user at the right time. Drag-and-drop journey builder. Behavior-triggered. Multi-channel. Deploys to Cloudflare or your own AWS in one command.
>
> *Built on Thodare — the open-source headless workflow engine. We focus on push delivery; the orchestration is handled.*

That sentence in italics is the headless-substrate value proposition writ vertical. It's why PushKit launches in a quarter instead of a year.
