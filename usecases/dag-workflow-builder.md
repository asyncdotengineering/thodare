# Use case: Generic DAG workflow builder (ActivePieces / Zapier / n8n / Make class)

## 1. The product premise

A SaaS or self-hosted product where **non-developers (or developer teams' ops people) build cross-app automation visually**. The customer drags pre-built connectors onto a canvas: "when a Stripe payment succeeds → create a HubSpot deal → notify in Slack → update a Google Sheet → if the deal value is over $5000, send a custom Klaviyo campaign." The platform ships hundreds of pre-built connectors covering every major SaaS app; the user assembles their workflow as a DAG; the platform runs it reliably and durably across millions of triggers per day.

Real-world examples: **ActivePieces** (open-source MIT, ~$15M raised, ~250 pieces shipped), **n8n** (open-source SUL, ~$50M raised, ~1000 nodes), **Zapier** (proprietary cloud, ~$140M ARR, ~5000+ apps), **Make** (formerly Integromat, proprietary, ~$60M raised), **Pipedream** (developer-focused, ~$20M raised), **Workato** (enterprise, $200M+ ARR), **Tray.io** (enterprise iPaaS).

This is the **broadest** of the four use-case categories. The previous three are vertical (push, sales funnels, email marketing); this one is horizontal — it serves every business automation need that isn't already covered by a vertical SaaS.

## 2. Why this is workflow-shaped

It's not just workflow-shaped — **the workflow IS the product.** Everything else (the connector library, the canvas, the run dashboard, the connection vault, the sub-account billing) is supporting infrastructure for "let users build and run workflows."

Every product feature in the category collapses to a workflow primitive Thodare already plans to support:

- **"When X happens, do Y"** = a workflow with one trigger + one action.
- **Multi-step automations** = a workflow with N action blocks chained.
- **Branching ("only do Y if Z")** = blocks with `sourceHandle` routing.
- **Filters** = a `filter` block that returns a boolean and routes via sourceHandle.
- **Formatters** = `transform` blocks that reshape one block's output for the next.
- **Loops** ("for each row in this Google Sheet") = container blocks (P1 in proposal).
- **Sub-workflows** = invoke another workflow via `Workflow.named(...)` (proposal §3.9).
- **Schedules** = cron triggers.
- **Webhooks** = a `trigger_webhook` block exposing a URL.
- **Manual runs** = `POST /api/workflows/:id/run` from the UI.
- **Test runs** = same as production but isolated by org context.

The category exists because every business needs SOME automation between SOME apps, and there isn't a unified open-source headless engine — so each player rebuilds one from scratch. **Thodare's headless-substrate goal is exactly this category's missing piece.**

## 3. The founder's POV — what they define

A team of 5-7 founds **"FlowForge"** — an MIT-licensed ActivePieces alternative built on Thodare. Their value prop: "all of n8n, with none of the SUL license restrictions, and 10× the durability story."

### 3.1 The connector library is the product

Where notification-platform shipped ~5 vertical connectors and marketing-automation shipped ~30, **FlowForge ships 100 at v1, targets 500 by v2.** The shape of each is identical:

```ts
// connectors/google-sheets/append-row.ts
import { defineConnector, defineCredentialType } from "@thodare/engine";
import { z } from "zod";

export const googleOAuth = defineCredentialType({
  id: "google-oauth2",
  type: "oauth2",
  displayName: "Google",
  authConfig: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  },
  test: {
    method: "GET",
    url: "https://www.googleapis.com/oauth2/v3/userinfo",
    headers: { Authorization: "Bearer {{credential.accessToken}}" },
    expectStatus: 200,
  },
});

export const sheetsAppendRow = defineConnector({
  type: "google_sheets_append_row",
  name: "Google Sheets: Append Row",
  category: "spreadsheets",
  icon: "google-sheets",
  tags: ["google", "sheets", "append", "log"],
  credential: { required: true, type: "google-oauth2",
                requiredScopes: ["https://www.googleapis.com/auth/spreadsheets"] },
  params: z.object({
    spreadsheetId: z.string().describe("Drag-and-drop or paste the Sheet URL — UI extracts the ID"),
    sheetName:     z.string().describe("Tab name (e.g. 'Sheet1')"),
    values:        z.array(z.string()).describe("Cell values — supports {{template}} variables"),
  }),
  outputs: z.object({
    range:        z.string(),  // e.g. "Sheet1!A5:C5"
    updatedCells: z.number().int(),
  }),
  async execute({ spreadsheetId, sheetName, values }, ctx) {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [values] }),
      }
    );
    const data = await r.json();
    return { range: data.updates.updatedRange, updatedCells: data.updates.updatedCells };
  },
});
```

That's ~50 LoC per connector. **At 100 connectors that's 5,000 LoC of declarative connector definitions — manageable for a 5-person team.** At 500 connectors it's 25,000 LoC — still manageable with an internal connector-template generator + LLM-assisted authoring (see §3.4).

### 3.2 Connector packages — one per app

```
@flowforge/connectors-google-workspace       (Sheets / Docs / Drive / Gmail / Calendar — 25 connectors)
@flowforge/connectors-slack                  (Send Message / Create Channel / Upload File / ... — 15 connectors)
@flowforge/connectors-stripe                 (Create Customer / Charge / Refund / ... — 20 connectors)
@flowforge/connectors-hubspot                (CRM / Marketing / Sales — 30 connectors)
@flowforge/connectors-notion                 (Database / Page / Comment — 12 connectors)
@flowforge/connectors-airtable               (List Records / Create / Update / Delete — 8 connectors)
@flowforge/connectors-ai-models              (OpenAI / Anthropic / Cohere / Mistral — 10 connectors)
... (90+ more)
```

Each package is independently versioned (Changesets per the existing T15 discipline) so a Slack API change → bump `@flowforge/connectors-slack` → users opt into the upgrade. The Thodare engine + Backend stays the same.

### 3.3 The connector marketplace primitive

This is where Thodare's deferred "connector marketplace primitives" item from `SPEC §7` becomes load-bearing. FlowForge needs:

- **Connector registry** in the org's database — which connectors are installed for this customer org. Default: every `@flowforge/connectors-*` package is auto-installed at sign-up; advanced customers can disable specific ones for their team.
- **Per-org connector versioning** — Acme Inc is on `@flowforge/connectors-slack@2.1.0`; Beta Corp is on `2.0.5`. Their workflows reference the version they were authored against (the `removed` entry kind from proposal §3.6 handles in-flight runs when a connector evolves).
- **Connector listing UI** — `GET /api/connectors?installed=true&category=spreadsheets`. Returns the live registry, paginated, filtered, with full UI metadata.
- **Custom (private) connectors** — enterprise customers can ship their own connector code packaged as a `@flowforge-custom/<orgId>-*` private package. Hosted in their org's connector slot. **Requires the Backend to support sandboxed code execution** (see §7).

### 3.4 The AI-assisted connector authoring tool

ActivePieces ships a CLI: `pieces create-piece` that scaffolds a new connector. n8n has a similar generator. FlowForge's killer feature: an **AI assistant that reads an OpenAPI spec or a SaaS app's docs and emits a Thodare connector definition**.

```sh
$ flowforge connector generate \
    --from-openapi=https://api.linear.app/openapi.yaml \
    --include="issue.create,issue.update,issue.list" \
    --output=connectors/linear/

✓ Read OpenAPI spec (47 endpoints)
✓ Filtered to 3 endpoints
✓ Generated connectors/linear/issue-create.ts (52 LoC)
✓ Generated connectors/linear/issue-update.ts (47 LoC)
✓ Generated connectors/linear/issue-list.ts (61 LoC)
✓ Generated connectors/linear/index.ts + package.json
✓ Generated connectors/linear/credentials.ts (Linear OAuth)
✓ Skipped 44 endpoints (re-run with --include=<endpoint> to add)

Next:
  cd connectors/linear && pnpm test
  pnpm changeset
  git commit -m "Add Linear connectors"
```

Behind the scenes: the tool uses Claude (or Gemini, or GPT) via the AI SDK to read the spec + map endpoint params to Zod schemas + map response shapes to outputs schemas + generate a sensible `execute()` implementation + write tests. **The output IS Thodare connector code** — the tool doesn't define a new format.

This is the leverage that makes 500 connectors achievable for a small team. ActivePieces and n8n have hundreds of community contributors writing connectors by hand; FlowForge pairs 5 engineers with an AI generator and ships the same breadth.

### 3.5 What FlowForge DOESN'T build

- Durable execution + retries + sleeps (Thodare engine + Backend)
- Workflow JSON + EditOp loop + skip-don't-reject (Thodare engine)
- Multi-tenant scoping (Thodare T11)
- Credential vault (Thodare engine v1.0)
- OAuth flow plumbing per provider (Thodare's `defineCredentialType.test` + standard OAuth2 helpers)
- Live SSE for run timeline (Thodare API + Backend capability)
- Step IO storage + drop-off analytics (Thodare's `Storage.steps.list`)
- Container blocks (Thodare proposal §3.X — must ship for FlowForge's loops/branches to work)
- Dynamic schema endpoint (Thodare's `POST /api/connectors/:type/refresh` per §3.13 if greenlit)

That's a 6-12 person engineering team's worth of work the founder skips. FlowForge focuses on what's actually defensible: **connector breadth + canvas DX + sub-account billing + the AI-generation tool.**

## 4. The end user's POV — what the marketer / ops person sees

A revenue-ops manager at "Acme Inc" logs into FlowForge and builds:

```
[Trigger: When Stripe payment succeeds]
   filter: amount >= 100
   ↓
[For Each line item in the payment]
   ├─ ↓
   │  [HubSpot: Create or Update Deal]
   │     dealName = "{{lineItem.description}}"
   │     amount   = "{{lineItem.amount_total / 100}}"
   │     stage    = "Closed Won"
   │  ↓
   │  [Branch on Deal Amount]
   │     ├─ (>= $5000) ↓
   │     │  [Slack: Send Message to #high-value-deals]
   │     │     text = "🎉 New high-value deal: {{deal.name}} for ${{deal.amount}}"
   │     │  ↓
   │     │  [Linear: Create Issue]
   │     │     title = "Onboard new high-value customer: {{deal.name}}"
   │     │     team  = "Customer Success"
   │     │  → CONTINUE
   │     └─ (< $5000) → CONTINUE
   │  ↓
   │  [Google Sheets: Append Row]
   │     spreadsheet = "Q2-Sales-Tracker"
   │     values = [
   │       "{{event.timestamp}}",
   │       "{{deal.name}}",
   │       "{{deal.amount}}",
   │       "{{customer.email}}"
   │     ]
   ↓
[Send Email Summary via Resend]
   to       = "revops@acme.com"
   subject  = "New payment processed: ${{event.amount_total / 100}}"
```

The manager doesn't see Thodare. They see FlowForge's branded canvas. Behind the scenes:

- Their drag emits `EditOp[]` (using FlowForge's canvas helper that wraps Thodare's `compute-edit-sequence` per §3.15 if greenlit).
- The workflow JSON is stored in Thodare's `workflow_workflows` table, scoped to Acme Inc's org.
- When Stripe fires the `payment_intent.succeeded` webhook to FlowForge's ingestion endpoint, FlowForge matches it against the trigger filter, calls Thodare's `POST /api/workflows/.../run` with `{ input: {...payment...} }`.
- Thodare creates a run; the runtime walker dispatches the trigger; reaches the **`for_each` container block** (P1 in proposal §2.4 — must ship for FlowForge to exist); enters per-line-item execution; each iteration runs the inner sub-DAG; the run resumes; reaches the email summary; completes.
- Each step's input + output + duration is in `workflow_steps`, queryable by FlowForge for their drop-off analytics dashboard.

## 5. Deployment recommendation

This use case stresses Thodare's **breadth + multi-tenant scaling** more than any other.

### Stage 1 — alpha / first 50 customers

`backend-self-host-postgres` on Render or Fly.io. Single Postgres + 2 worker pods. ~$300/mo.

### Stage 2 — growth / 50-1000 customers, 10M+ runs/month

`backend-self-host-postgres` with Postgres scaled out (Aurora Serverless v2 or Neon Pro at ~$500-1000/mo) + 6-12 worker pods. Read replicas for the connector-listing + analytics endpoints (those are read-heavy).

### Stage 3 — scale / 1000+ customers, billions of events/month

**Two-Backend hybrid** (a v1.1 capability per `_common-patterns.md` §11):

- **`backend-cloudflare`** at the edge for **trigger ingestion** + connector inspection — global low-latency for webhooks from any user's app.
- **`backend-aws`** for the **heavy orchestration** — RDS Postgres + SQS + Lambda + S3. Better cost control at petabyte scale.

The headless story makes this hybrid practical: same workflow JSON, same connectors, same canvas — federate across two Backends via Thodare's queue-federation (deferred to v1.1). Documented as "the FlowForge scale playbook."

### Self-host customers

ActivePieces' biggest selling point is **MIT + self-host + your data stays yours.** FlowForge inherits this:

- **`thodare build --target=postgres-self-host`** produces a Docker Compose with Thodare API + worker + Postgres.
- Customer runs `docker compose up`. Done.
- Custom connectors live in `./custom-connectors/` mounted as a volume; loaded at boot.
- This is the use case that makes Thodare's "no `thodare deploy`" + Flue-style platform-native deploy story most valuable.

## 6. What Thodare provides vs. what FlowForge builds

| Concern | Thodare | FlowForge |
|---|---|---|
| Workflow definition + persistence + EditOp | ✅ | — |
| Run state + replay + retries + sleeps | ✅ | — |
| Multi-tenant per-org isolation | ✅ T11 | — |
| Credential vault | ✅ v1.0 | OAuth-provider-specific configs |
| Live SSE run timeline | ✅ | — |
| Step IO inspection | ✅ | drop-off + revenue analytics |
| Container blocks (loops/parallel/branches) | ✅ if §3.11 ships | — |
| Dynamic schema endpoint | ✅ if §3.13 ships | — |
| Connector marketplace primitive | ⚠️ partial — Thodare's `BlockRegistry` + `defineConnector` covers per-deployment registration; per-org marketplace is FlowForge's domain | per-org installed-connectors registry |
| **The 100-500 connector library** | — | **their domain — and their primary IP** |
| AI-assisted connector generator | — | their domain (uses AI SDK + Anthropic/OpenAI) |
| Drag-and-drop canvas | — | their domain (React Flow + custom nodes) |
| Sub-account billing | — | their domain (per-customer Stripe) |
| Marketing site + onboarding | — | their domain |
| Custom domain hosting per customer | — | their domain (Cloudflare for SaaS) |

For this use case **Thodare provides ~30-40% of the engineering by LoC** — connector breadth is the real work. But Thodare provides **the right 30-40%**: the part that's hardest to build correctly + that nobody else open-sources at this quality (durable execution + LLM-feedable surface + multi-tenant API).

## 7. Open gaps in Thodare today (for THIS use case specifically)

| Gap | Severity for FlowForge | Status in proposal |
|---|---|---|
| **Container blocks (loops + parallel + branch)** | **P0** — without these, FlowForge cannot ship. "For each row in Sheet" is the most-used pattern in iPaaS. | §2.4 P1 — listed; needs §3.X design (Edit A in audit) |
| **Connector marketplace primitive** (per-org installed registry + versioning) | **P0** — FlowForge's whole product is "you install the connectors you need." | NOT in proposal — could be v1.1 add as `@thodare/connector-marketplace` extension |
| **Sandboxed custom-connector execution** | **P1** — enterprise customers want to ship their own connector code without granting Thodare full Node access | NOT in proposal — could be v1.1 (use libkrun / e2b / Modal sandboxes per `iii-dev` review's pattern) |
| **High-throughput webhook ingestion (any URL → any workflow)** | **P0** — FlowForge ingests webhooks from EVERY app on the internet | _common-patterns v1.1 + sales-funnel review's HTTP-as-trigger gap |
| **Connector versioning + per-org pinning** | **P1** — workflows author against `connectors-slack@2.1.0`; can't auto-upgrade to `2.2.0` mid-flight | The `removed` entry kind §3.6 handles deletion; adding versioning needs the connector registry |
| **Dynamic schema for connector forms** | **P0** — every Slack channel picker / Sheets sheet picker needs this | §2.4 P1 (Edit C in audit) |
| **`paramVisibility: 'llm-only'` + output `hiddenFromDisplay`** | **P0** — when a workflow chains 10 connectors, sensitive fields must not leak into the LLM's view of intermediate state | §2.4 P0 (Edits B in audit) |
| **Sub-workflow invocation (workflow-as-step)** | **P0** — "extract this sequence into a reusable sub-flow" is iPaaS basics | §3.9 (`Workflow.named()`) lays the groundwork; needs runtime support |
| **Webhook URL per connector instance** (each `trigger_webhook` block gets a unique URL) | **P1** | §7.1 listed P3; bumps to P1 for this use case |
| **Per-step retry policy declarative on the block** | **P1** — "retry this Slack send 5×, but fail-fast on this Stripe charge" | NOT in proposal — could lift n8n's `retryOnFail` / `maxTries` pattern |

**The headline:** FlowForge needs **container blocks** + **connector marketplace** + **dynamic schema endpoint** at minimum to ship. The first is in proposal §2.4 P1 (needs design pass). The second is not in the proposal. The third is in the proposal §7.1 (needs design pass).

## 8. The five-line pitch FlowForge puts on its homepage

> **FlowForge** is the open Zapier. Drag connectors, build automations, run them at scale. 250 pre-built integrations and growing. MIT licensed. Self-host or use our cloud — same code, same workflows, your choice.
>
> *Built on Thodare — the open-source headless workflow engine. We focus on connectors, the canvas, and the AI that helps you build them; the durable orchestration is handled.*

ActivePieces raised $15M to compete with Zapier. n8n raised $50M. Both ship hundreds of connectors. **FlowForge launches with the same shape but a focused 5-person team**, because the orchestration backbone — the part that takes Zapier's engineering team months to harden — is Thodare. The remaining work is connectors + canvas + sales, and that's the work that's actually defensible.

## 9. Why this use case completes the four-use-case set

The four use cases now span the full surface area of what Thodare-as-substrate can power:

| Use case | Vertical / horizontal | What it stresses uniquely |
|---|---|---|
| `notification-platform.md` | vertical (push) | Long durable sleeps + audience fan-out |
| `sales-funnel-platform.md` | vertical (sales funnels) | HTTP page rendering + payment branching |
| `marketing-automation.md` | vertical (email/SMS) | Multi-month customer journeys + predictive ML |
| `dag-workflow-builder.md` (this) | **horizontal (any business automation)** | **Connector breadth + container blocks + marketplace primitives** |

Together these four prove **Thodare can carry any "drag-and-drop workflow over user behavior" SaaS**, vertical or horizontal, multi-billion dollar market or niche tool. The substrate is real.
