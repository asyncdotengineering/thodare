# Developer Blueprint — Thodare in the v2 ideal world

> **Status:** end-to-end DX walkthrough. Author: Claude, this session. Audience: the maintainer evaluating "is this proposal worth building." Companion to `world-abstraction-proposal.md`. No code in this document is real (the proposal is unbuilt); every snippet shows what the v2-shaped surface would look like.

This document answers one question: **once the World abstraction + Credential primitive + headless-substrate plumbing land, what does it actually feel like to use Thodare?** Five personas, in order of escalating depth.

- **§1 Persona A — Hacker on a laptop.** First five minutes.
- **§2 Persona B — Platform engineer.** Ship a Postgres-backed internal-ops service.
- **§3 Persona C — LLM-agent developer.** Build an agent that constructs workflows on the fly.
- **§4 Persona D — Visual-builder founder.** "I'm building an n8n for sales ops on Thodare."
- **§5 Persona E — Migration team.** Move a workload from Postgres to Cloudflare without rewriting workflows.

Common thread: **same JSON, same EditOp loop, same connectors, same API.** What changes is the World underneath.

---

## §1 Persona A — Hacker on a laptop

**Goal.** Run a workflow in five minutes. No infrastructure. No accounts. No API keys.

### 1.1 Install + scaffold

```sh
$ npm install -g @thodare/cli
$ thodare init my-app
✓ Wrote my-app/thodare.config.ts
✓ Wrote my-app/workflows/hello.workflow.ts
✓ Wrote my-app/connectors/example.ts
✓ Wrote my-app/.gitignore
✓ Wrote my-app/package.json
✓ Wrote my-app/tsconfig.json

Next:
  cd my-app && pnpm install
  thodare dev
```

The scaffold is intentionally tiny. `thodare.config.ts`:

```ts
import { defineConfig } from "@thodare/cli";

export default defineConfig({
  // Default World is `world-openworkflow-sqlite` — zero config, zero deps, runs on a single
  // SQLite file at .thodare/local.db. Suitable for `thodare dev` and `thodare run` only.
  world: "openworkflow-sqlite",
});
```

`workflows/hello.workflow.ts`:

```ts
import { defineWorkflow, defineConnector } from "@thodare/engine";
import { z } from "zod";

const greet = defineConnector({
  type: "greet",
  name: "Greet",
  description: "Says hello.",
  params: z.object({ name: z.string() }),
  outputs: z.object({ message: z.string() }),
  async execute({ name }) {
    return { message: `Hello, ${name}!` };
  },
});

export default defineWorkflow("hello")
  .input(z.object({ name: z.string() }))
  .step("greet", greet, ({ input }) => ({ name: input.name }))
  .build();
```

### 1.2 Run it locally

```sh
$ cd my-app && pnpm install
$ thodare dev
✓ World: openworkflow-sqlite (.thodare/local.db)
✓ API:    http://localhost:3000
✓ Loaded 1 workflow: hello
✓ Loaded 1 connector: greet

Try:
  curl -X POST http://localhost:3000/api/workflows/hello/run -d '{"input":{"name":"world"}}'

Watching workflows/ + connectors/ for changes...
```

`thodare dev` boots the API server (Hono on Node, SQLite-backed) and hot-reloads workflows + connectors on file save. The same API surface that production hits — `/api/workflows`, `/api/runs`, `/api/credentials`, `/api/connectors` — is live on port 3000.

```sh
$ curl -X POST http://localhost:3000/api/workflows/hello/run \
       -H 'content-type: application/json' \
       -d '{"input":{"name":"world"}}'

{
  "runId": "wrun_01HQX...",
  "status": "completed",
  "output": { "message": "Hello, world!" }
}
```

For one-shot CI invocations:

```sh
$ thodare run hello --input '{"name":"world"}'
{ "message": "Hello, world!" }
$ echo $?
0
```

`thodare run` builds, spawns an in-process server, POSTs the run, streams the result to stdout, exits non-zero on `FatalError`. Per Flue's "single-shot CI" pattern.

### 1.3 What persisted state exists at this point

`.thodare/local.db` — a single SQLite file with the openworkflow schema (`workflow_runs`, `workflow_events`, `workflow_steps`, `workflow_hooks`, `workflow_waits`, `workflow_stream_chunks`, plus the new `workflow_credentials` table). Inspect it with any SQLite tool. Delete the file → fresh state.

That is the entire local-dev experience. **Zero accounts, zero cloud, zero docker-compose.** Per Flue's `thodare init` discipline + the SQLite-via-openworkflow path.

---

## §2 Persona B — Platform engineer

**Goal.** Ship a Postgres-backed durable workflow service for internal tools at a real company. Multi-tenant (one org per team). OAuth-connected to Slack + GitHub. Production-ready.

### 2.1 Pick the World

Edit `thodare.config.ts`:

```ts
import { defineConfig } from "@thodare/cli";

export default defineConfig({
  world: {
    id: "openworkflow-pg",
    options: {
      databaseUrl: process.env.DATABASE_URL,         // postgres://...
      maxConnections: 20,
      schema: "thodare",                              // namespace, not the public schema
    },
  },
  api: {
    auth: { secret: process.env.AUTH_SECRET },        // better-auth
    cors: { origin: ["https://internal-tools.acme.io"] },
  },
});
```

The `world.id` switch is the only adapter-level change. The `world-openworkflow-pg` package validates the connection string + runs migrations on first boot.

### 2.2 Define a connector with a credential

`connectors/slack.ts`:

```ts
import { defineConnector, defineCredentialType } from "@thodare/engine";
import { z } from "zod";

// Declare the credential type — the UI will render a "Connect Slack" button.
export const slackOAuth = defineCredentialType({
  id: "slack-oauth2",
  type: "oauth2",
  displayName: "Slack",
  authConfig: {
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["chat:write", "chat:write.public", "channels:read"],
  },
  // declarative test ping — the API exposes POST /api/credentials/:id/test
  test: {
    method: "GET",
    url: "https://slack.com/api/auth.test",
    headers: { Authorization: "Bearer {{credential.accessToken}}" },
    expectStatus: 200,
  },
});

export const slackPostMessage = defineConnector({
  type: "slack_post_message",
  name: "Slack: Post Message",
  description: "Posts a message to a Slack channel.",
  category: "messaging",
  icon: "slack",
  // The connector binds to a credential type. The LLM never sees the secret.
  credential: { required: true, type: slackOAuth.id, requiredScopes: ["chat:write"] },
  params: z.object({
    channel: z.string().describe("Channel ID or name (e.g. #alerts)."),
    text: z.string().describe("Message body — supports {{template}} variables."),
  }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async execute({ channel, text }, ctx) {
    // ctx.credential is injected by the runtime — the connector never reads
    // the encrypted blob. The LLM never sees the token.
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ctx.credential.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(`Slack error: ${data.error}`);
    return { ok: true, ts: data.ts };
  },
});
```

### 2.3 Build for the platform

```sh
$ thodare build --target=postgres-self-host
✓ Built engine bundle      (dist/engine.js, 487 KB)
✓ Built API server         (dist/server.js, 612 KB)
✓ Wrote Compose manifest   (dist/compose.yaml — merged into your ./compose.yaml if present)
✓ Wrote migration script   (dist/migrate.sh)
✓ Wrote runbook            (dist/RUN.md)

Deploy:
  cd dist && docker compose up -d
  cd dist && ./migrate.sh
```

Flue's "no `thodare deploy` — emit artifacts the platform's tool consumes" pattern applied. If `./compose.yaml` already exists in the repo, `dist/compose.yaml` is **merged** (per `cloudflare-wrangler-merge.ts` algorithm generalized) — Thodare adds its own `thodare-api` + `thodare-postgres` services, never overwrites the user's services.

### 2.4 Connect a credential

The platform engineer hits the API directly (or a UI built on top — see §4):

```sh
# Mint an API key for the org
$ thodare key create --name "platform"
✓ Saved to ~/.thodare/credentials.json

# OAuth flow: open the authorize URL, exchange the code, persist the credential
$ open "$(thodare credentials oauth-url --type=slack-oauth2 --redirect=http://localhost:3000/callback)"

# After OAuth callback, the credential is saved automatically:
$ thodare credentials list
ID                TYPE          NAME                    SCOPES                CREATED
cred_01HQX...     slack-oauth2  Acme Eng Slack          chat:write,channels:read  2026-05-02T14:33Z

# Test it lives:
$ thodare credentials test cred_01HQX...
✓ slack-oauth2 — auth.test returned 200
```

The actual secret never appears in `credentials list`. The CLI only ever sees the credential id. The encrypted blob lives in `workflow.credentials.encrypted_secret` (AES-256-GCM with the per-org key derived via HKDF).

### 2.5 Patch + run a workflow

The same JSON-first surface from §1, plus a credential reference:

```ts
// scripts/build-incident-flow.ts — a one-shot script the team runs to seed the workflow
import { fetchAuthed } from "./util.js";

await fetchAuthed("/api/workflows", {
  method: "POST",
  body: { id: "incident-page", name: "Incident: Page on-call" },
});

await fetchAuthed("/api/workflows/incident-page/operations", {
  method: "POST",
  body: {
    ops: [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook",
        params: { path: "/incident" } },
      { operation_type: "add", block_id: "n",   type: "slack_post_message",
        params: {
          channel: "#oncall",
          text: "🚨 New incident: {{trg.body.title}}",
          credentialId: "cred_01HQX...",   // reference, not value
        } },
      { operation_type: "connect", block_id: "trg", target_block_id: "n" },
    ],
  },
});

console.log("✓ Workflow ready. POST to /api/webhooks/incident to trigger.");
```

The response carries `{ ok, version, validation_errors, skipped_items, summary }`. If the LLM (or the script) referenced a `hidden()` param the response would skip with `hidden_param_in_input`; if the credential id was wrong the response skips with `unknown_credential` (new skip reason). The whole batch never throws on a single bad op.

### 2.6 Production observability

```sh
# Tail a live run
$ curl -N http://localhost:3000/api/runs/wrun_01HQX.../stream
event: step_started
data: {"stepId":"trg","blockType":"trigger_webhook","at":"2026-05-02T14:35:01Z"}

event: step_completed
data: {"stepId":"trg","blockType":"trigger_webhook","outputBytes":237,"durationMs":4}

event: step_started
data: {"stepId":"n","blockType":"slack_post_message","at":"2026-05-02T14:35:01.005Z"}

event: step_completed
data: {"stepId":"n","blockType":"slack_post_message","durationMs":118}

event: run_completed
data: {"runId":"wrun_01HQX...","status":"completed"}
```

This is the SSE endpoint gated by `world.capabilities.supportsLiveSubscription`. `world-openworkflow-pg` implements it via Postgres LISTEN/NOTIFY (per WDK's pattern at `world-postgres/src/streamer.ts:108`).

### 2.7 Recover a failed run

```sh
$ thodare runs list --status=failed --limit=5
RUN_ID            WORKFLOW              FAILED_AT             ERROR
wrun_01HQY...     incident-page         2026-05-02T14:42Z     Slack 503

# Try once more (resume from the failed step, don't re-run the trigger)
$ thodare runs resume wrun_01HQY... --step=n
✓ Run wrun_01HQY... resumed at step "n"

# Or: full retry-exhausted recovery
$ thodare runs recover wrun_01HQY...
✓ Run wrun_01HQY... recovered (failed → pending)
```

Both endpoints (`POST /api/runs/:id/resume?step=...`, `POST /api/runs/:id/recover`) are gated by capability flags — `world-openworkflow-pg` declares both `true`; `world-cloudflare-dynamic` declares `false` (CF Workflows requires re-create, see §5.3).

---

## §3 Persona C — LLM-agent developer

**Goal.** Build an agent that, given a natural-language description, constructs and runs a Thodare workflow. Repair-loop on failure. Stream progress to the user.

### 3.1 The agent's tool surface

```ts
// agent/tools.ts
import { defineAgentTools } from "ai";
import { z } from "zod";
import { thodareClient } from "./thodare.js";

export const tools = defineAgentTools({
  // 1) Inspect available connectors
  listConnectors: {
    description: "List the connectors the user has installed. Use this BEFORE patching.",
    parameters: z.object({}),
    execute: async () => thodareClient.connectors.list(),
  },

  // 2) Get a connector's full schema (for params, outputs, credentials)
  getConnector: {
    description: "Get a connector's full schema — required when adding a block of that type.",
    parameters: z.object({ type: z.string() }),
    execute: async ({ type }) => thodareClient.connectors.get(type),
  },

  // 3) Patch a workflow (skip-don't-reject)
  patchWorkflow: {
    description: "Apply EditOps to a workflow. Bad ops are skipped with reasons; the batch never fails.",
    parameters: z.object({
      workflowId: z.string(),
      ops: z.array(z.discriminatedUnion("operation_type", [
        z.object({ operation_type: z.literal("add"), block_id: z.string(),
                   type: z.string(), params: z.record(z.unknown()) }),
        z.object({ operation_type: z.literal("edit"), block_id: z.string(),
                   params: z.record(z.unknown()) }),
        z.object({ operation_type: z.literal("delete"), block_id: z.string() }),
        z.object({ operation_type: z.literal("connect"), block_id: z.string(),
                   target_block_id: z.string(), source_handle: z.string().optional() }),
        z.object({ operation_type: z.literal("disconnect"), block_id: z.string(),
                   target_block_id: z.string() }),
      ])),
    }),
    execute: async ({ workflowId, ops }) =>
      // Streaming response — every applied/skipped op is one NDJSON line
      thodareClient.workflows.patchStream(workflowId, ops),
  },

  // 4) Run a workflow + tail it
  runAndWait: {
    description: "Trigger the workflow and wait for it to finish.",
    parameters: z.object({
      workflowId: z.string(),
      input: z.unknown().optional(),
    }),
    execute: async ({ workflowId, input }) => {
      const { runId } = await thodareClient.workflows.run(workflowId, input);
      // Yields incremental progress events; resolves on terminal state
      return await thodareClient.runs.waitForTerminal(runId, { timeout: 30_000 });
    },
  },
});
```

The four tools cover the entire LLM-construction loop: inspect, patch, run, observe. `defineAgentTools` is from the AI SDK; nothing Thodare-specific about the wrapper.

### 3.2 The repair loop

```ts
// agent/loop.ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { tools } from "./tools.js";

export async function buildWorkflowFromPrompt(prompt: string) {
  const workflowId = await thodareClient.workflows.create({ name: "agent-built" });

  const result = await generateText({
    model: anthropic("claude-opus-4-7"),
    tools,
    maxSteps: 10,           // up to 10 patch iterations
    system: `You are constructing a Thodare workflow.
- Always call listConnectors + getConnector first.
- Patch via patchWorkflow. Inspect skipped_items and fix.
- A "hidden_param_in_input" skip means you tried to set a credential or secret directly — use credentialId reference instead.
- Run only after the patch returns 0 skipped items.`,
    messages: [{ role: "user", content: prompt }],
  });

  return { workflowId, conversation: result.text };
}
```

The repair loop emerges naturally from `maxSteps` + the structured `skipped_items[]` response. The LLM patches, sees `skipped_items: [{ reason_code: "block_type_not_found", block_id: "n", reason: "Connector 'slack-postmesage' not registered (typo? did you mean slack_post_message?)" }]`, fixes the typo, repatches, sees zero skips, runs. Per Thodare's T2 (skip-don't-reject) — this is the load-bearing primitive.

### 3.3 Stream the agent's work to the end user

```ts
// app/api/agent-build/route.ts (Next.js)
import { streamText } from "ai";
import { tools } from "@/agent/tools";

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const workflowId = await thodareClient.workflows.create({ name: "agent-built" });

  const result = await streamText({
    model: anthropic("claude-opus-4-7"),
    tools,
    messages: [{ role: "user", content: prompt }],
  });

  // The frontend gets a token-by-token stream of:
  //   1. The agent's reasoning text
  //   2. Tool calls (which appear as "Patching workflow…" / "Running…")
  //   3. Tool results — including ndjson-streamed op verdicts from patchWorkflow
  return result.toDataStreamResponse({ headers: { "x-thodare-workflow-id": workflowId } });
}
```

The frontend renders the agent's stream + the canvas updates live (see §4) because the agent's `patchWorkflow` calls land in the same workflow the canvas is watching. **Same JSON, two writers (LLM + UI), one consistent view.**

### 3.4 What changed vs. v1 of the proposal

The new `?stream=ndjson` mode on `POST /api/workflows/:id/operations` (per `code-reviews/workflow-builder-template.md`'s NDJSON op-log finding) lets the LLM read each op's verdict as it lands, instead of waiting for a batch verdict. For long patch sequences this dramatically shortens the LLM's feedback cycle.

```sh
$ curl -N http://localhost:3000/api/workflows/agent-built/operations?stream=ndjson \
       -d '{"ops":[{"operation_type":"add",...},{"operation_type":"add",...}]}'
{"op":0,"applied":true,"block_id":"trg"}
{"op":1,"applied":true,"block_id":"n"}
{"op":2,"skipped":true,"block_id":"x","reason_code":"unknown_block_type",
   "reason":"Connector 'slack-postmesage' not registered (did you mean 'slack_post_message'?)"}
{"version":3,"summary":{"applied":2,"skipped":1}}
```

---

## §4 Persona D — Visual-builder founder

**Goal.** Building "Sales-Ops Studio" — an n8n-class application where sales-ops teams build automations on a visual canvas. The UI is React (custom-built); Thodare is the durable backend. Multi-tenant SaaS.

This is the headline use case the v2 proposal added.

### 4.1 The application architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ sales-ops-studio.com (Next.js + React Flow)                     │
│   ├─ /canvas         — workflow editor (xyflow + custom nodes)  │
│   ├─ /runs/:id       — execution timeline                       │
│   ├─ /credentials    — connection vault UI                      │
│   └─ /connectors     — connector palette                        │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼  HTTPS
┌─────────────────────────────────────────────────────────────────┐
│ api.sales-ops-studio.com (@thodare/api on Hono)                 │
│   ├─ /api/workflows/*    — CRUD + EditOp loop                   │
│   ├─ /api/runs/*         — runs + SSE stream                    │
│   ├─ /api/credentials/*  — vault                                │
│   └─ /api/connectors/*   — registry inspection                  │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Thodare engine + world-openworkflow-pg                          │
│   ├─ Postgres (multi-tenant by organization_id)                 │
│   └─ Worker pods (durable execution, retries, sleeps)           │
└─────────────────────────────────────────────────────────────────┘
```

The founder writes:
- The Next.js frontend
- The connectors specific to sales-ops (Salesforce, HubSpot, Outreach, Apollo, etc.) — registered with Thodare via `defineConnector` + `defineCredentialType`
- The auth/billing/onboarding (better-auth handles auth; billing wired to Stripe)

The founder does **not** write:
- Durable execution (Thodare engine + openworkflow)
- Workflow CRUD (Thodare API)
- Credential encryption / OAuth flows (Thodare engine)
- Multi-tenant scoping (Thodare API enforces T11)
- The patch loop / EditOp validation (Thodare engine)
- Run monitoring infrastructure (Thodare API + SSE)

### 4.2 The canvas reads the connector palette

```tsx
// app/canvas/page.tsx
import { useQuery } from "@tanstack/react-query";
import { Canvas } from "@/components/canvas";

export default function CanvasPage() {
  const { data: connectors } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => fetch("/api/proxy/connectors").then(r => r.json()),
  });

  return <Canvas connectors={connectors} />;
}
```

The connector list `/api/connectors` returns:

```jsonc
[
  {
    "type": "salesforce_create_lead",
    "name": "Salesforce: Create Lead",
    "description": "Creates a lead in Salesforce.",
    "category": "crm",
    "icon": "salesforce",
    "tags": ["salesforce", "crm", "lead-gen"],
    "credential": { "required": true, "type": "salesforce-oauth2", "requiredScopes": ["api"] },
    "subBlocks": [
      { "id": "firstName", "title": "First Name", "type": "short-input", "required": true,
        "description": "Use {{prevBlock.field}} to reference upstream data." },
      { "id": "lastName",  "title": "Last Name",  "type": "short-input", "required": true },
      { "id": "company",   "title": "Company",    "type": "short-input", "required": true },
      { "id": "email",     "title": "Email",      "type": "short-input", "required": true,
        "validation": { "format": "email" } },
      { "id": "leadSource","title": "Lead Source","type": "dropdown",
        // Dynamic dropdown — fetched from Salesforce's metadata API at form-render time
        "fetchOptions": { "endpoint": "/api/connectors/salesforce_create_lead/refresh",
                          "field": "leadSource",
                          "refreshers": ["credentialId"] } },
    ],
    "outputs": {
      "id":     { "type": "string", "description": "Salesforce lead ID." },
      "url":    { "type": "string", "description": "URL to the created lead in Salesforce." },
    },
  },
  // ...
]
```

The new `subBlocks[].fetchOptions` (per §2.4 P1 in the proposal — the dynamic-schema endpoint) lets the canvas render a Salesforce-managed picklist for `leadSource`. The `POST /api/connectors/:type/refresh` endpoint takes the form state + credential and returns the dynamic options.

### 4.3 The canvas patches via EditOp

When a user drags a Salesforce block onto the canvas + wires it to the trigger:

```ts
// Internal to the canvas component
import { computeEditSequence } from "@thodare/canvas-helpers";

function onCanvasChange(prev: SerializedWorkflow, next: SerializedWorkflow) {
  // Compute the minimal EditOp[] from the diff (Sim Studio's compute-edit-sequence pattern)
  const ops = computeEditSequence(prev, next);

  // Stream the patch — UI updates per-op verdict
  const response = await fetch(`/api/proxy/workflows/${workflowId}/operations?stream=ndjson`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops }),
  });

  // Each NDJSON line = one op verdict
  for await (const line of streamLines(response.body)) {
    const verdict = JSON.parse(line);
    if (verdict.skipped) {
      toast.error(`${verdict.block_id}: ${verdict.reason}`);
      // Roll the canvas back for that one node
      revertCanvasNode(verdict.block_id);
    }
  }
}
```

The `@thodare/canvas-helpers` package ships the `computeEditSequence` (per Sim's `compute-edit-sequence.ts:1-32` — Thodare must port this; it's in the proposal §2.4 P1 list). Per-op verdicts via NDJSON streaming let the canvas recover gracefully when one op fails (e.g., the user references a connector type the org doesn't have installed).

### 4.4 The credentials UI

```tsx
// app/credentials/page.tsx
export default function CredentialsPage() {
  const { data } = useQuery({
    queryKey: ["credentials"],
    queryFn: () => fetch("/api/proxy/credentials").then(r => r.json()),
  });

  return (
    <div>
      <h1>Connections</h1>
      {data.map(cred => (
        <CredentialRow key={cred.id} credential={cred}>
          <button onClick={() => fetch(`/api/proxy/credentials/${cred.id}/test`, { method: "POST" })
                                .then(r => r.json())
                                .then(r => toast(r.ok ? "Connected" : `Failed: ${r.error}`))}>
            Test connection
          </button>
        </CredentialRow>
      ))}
      <NewCredentialButton onCreate={() => /* OAuth flow via Thodare's authorize endpoint */} />
    </div>
  );
}
```

The user clicks "Connect Salesforce" → frontend hits `GET /api/credentials/oauth-url?type=salesforce-oauth2&redirect=/credentials` → opens the authorize URL → Salesforce redirects back with a code → Thodare exchanges the code, encrypts the token + refresh-token at rest with the per-org AES-256 key, returns the credential id.

The frontend NEVER sees the access token. The LLM (in Persona C's repair loop) NEVER sees the access token. The workflow JSON only contains `"credentialId": "cred_01HQX..."`.

### 4.5 The execution timeline

```tsx
// app/runs/[runId]/page.tsx
export default function RunPage({ params: { runId } }: Props) {
  const [steps, setSteps] = useState<Step[]>([]);

  useEffect(() => {
    const sse = new EventSource(`/api/proxy/runs/${runId}/stream`);
    sse.addEventListener("step_started", (e) => {
      setSteps(s => [...s, JSON.parse(e.data)]);
    });
    sse.addEventListener("step_completed", (e) => {
      const completed = JSON.parse(e.data);
      setSteps(s => s.map(st => st.stepId === completed.stepId ? { ...st, ...completed } : st));
    });
    sse.addEventListener("run_completed", () => sse.close());
    return () => sse.close();
  }, [runId]);

  return (
    <Timeline>
      {steps.map(step => (
        <TimelineStep key={step.stepId} step={step}>
          {step.status === "failed" && (
            <button onClick={() =>
              fetch(`/api/proxy/runs/${runId}/resume?step=${step.stepId}`, { method: "POST" })
            }>
              Retry from this step
            </button>
          )}
        </TimelineStep>
      ))}
    </Timeline>
  );
}
```

The "Retry from this step" button hits `POST /api/runs/:id/resume?step=<stepId>` (the Rivet-derived `resumeFromStep` primitive from proposal §3.1). On `world-openworkflow-pg` this works natively. On `world-cloudflare-dynamic` the API returns `409` with `capability_unsupported` — the UI hides the button when `world.capabilities.supportsResumeFromStep === false`.

### 4.6 Multi-tenant isolation in practice

```ts
// All API requests carry the org context via better-auth + apiKey plugin (per SPEC §3 T9)
fetch("/api/workflows", {
  headers: { Authorization: `Bearer ${apiKey}` },  // apiKey resolves to organizationId
});
```

Every store query in Thodare's API includes `WHERE organization_id = $current_org` (T11). Cross-org reads return 404, not 403 — existence is not revealed. The founder gets multi-tenancy for free; they don't write a single line of tenant-scoping code.

### 4.7 Pricing the founder pays

```
Postgres (Supabase or Neon)        ~$50/mo  for ~10M workflow runs/mo
Two worker pods (Fly.io or Render) ~$60/mo  (1 vCPU each)
Vercel for the Next.js frontend    ~$20/mo  (Pro tier)
Total for the durable backend      ~$130/mo
```

The founder's per-customer billing is free of substrate dependence. They could move to `world-cloudflare-dynamic` to flip to per-invocation pricing if a single big customer would benefit. **Substrate swap requires zero customer-facing change.** That's the headless story.

---

## §5 Persona E — Migration team

**Goal.** Ops team for the platform from §2 wants to migrate from Postgres to Cloudflare Workflows. Reasons: scale-to-zero off-hours, eliminate Postgres ops, cheaper at low utilization.

This is the proof-point for the substrate-swap promise.

### 5.1 What's the same

- Workflow JSON: identical.
- Connectors: identical (the `defineConnector` calls don't change).
- Credentials: identical (vault travels with the workflow data, encrypted at rest with the same per-org AES-256 keys).
- API surface: identical.
- The frontend / LLM agent / scripts: zero changes.
- EditOp semantics: identical.

### 5.2 What changes

```ts
// thodare.config.ts — DIFF
import { defineConfig } from "@thodare/cli";

export default defineConfig({
  world: {
-   id: "openworkflow-pg",
-   options: {
-     databaseUrl: process.env.DATABASE_URL,
-     maxConnections: 20,
-     schema: "thodare",
-   },
+   id: "cloudflare-dynamic",
+   options: {
+     accountId: process.env.CF_ACCOUNT_ID,
+     apiToken: process.env.CF_API_TOKEN,
+     // The D1 database that holds workflow JSON (per-org sharding optional)
+     d1: { databaseId: process.env.CF_D1_DATABASE_ID },
+     // Where credentials are stored (DO + AES-256-GCM)
+     credentialNamespace: "credentials-prod",
+   },
  },
});
```

That's the entire code diff. Eight lines.

### 5.3 The migration runbook

```sh
# 1. Build for the new target
$ thodare build --target=cloudflare
✓ Built worker bundle    (dist/worker.js, 891 KB)
✓ Wrote wrangler.jsonc   (merged into ./wrangler.jsonc — Thodare adds the WORKFLOWS, D1, DO bindings)
✓ Wrote .wrangler/deploy/config.json  (deploy-redirect — `wrangler deploy` Just Works)

# 2. Deploy via wrangler (Thodare doesn't wrap this — Flue's pattern)
$ wrangler deploy
Total Upload: 891.13 KiB / gzip: 287.45 KiB
Uploaded thodare-worker (1.58 sec)
Published thodare-worker (3.21 sec)
  https://thodare-worker.acme.workers.dev

# 3. Migrate workflow JSON + credentials from Postgres → CF
$ thodare migrate --from=openworkflow-pg --to=cloudflare-dynamic --dry-run
✓ Would migrate 247 workflows
✓ Would migrate 18 credentials (re-encrypted under target world's KMS)
✓ Would skip 8,431 historical runs (history stays on the source for 30d)

$ thodare migrate --from=openworkflow-pg --to=cloudflare-dynamic --execute
✓ Migrated 247 workflows
✓ Migrated 18 credentials
✓ DNS cutover suggested: api.acme.io → thodare-worker.acme.workers.dev

# 4. Verify the headless-friendliness matrix changed
$ thodare world inspect
World:                    cloudflare-dynamic
Spec version:             3
Capabilities:
  serverless:             ✅ true
  exactlyOnceSteps:       ✅ true
  supportsLiveSubscription: ✅ true (DO + WS)
  supportsStepIOInspection: ⚠️  partial (1 MiB cap per step)
  supportsResumeFromStep:   ❌ false (CF Workflows requires re-create)
  supportsRecover:          ⚠️  via re-create
  maxStepDurationMs:        ~30000 (CPU) / ~1800000 (wall, with retries)
  maxStepOutputBytes:       1048576
  pricingModel:             per-invocation
```

The "Retry from this step" button in the UI (§4.5) **automatically hides** because the API's connector-metadata response now reflects `supportsResumeFromStep: false` — the frontend's capability check at render time gates the button. **No frontend change required.**

### 5.4 Watching the cutover

```sh
# Dual-write window: traffic to both worlds for 24h while in-flight runs drain
$ thodare runs list --world=openworkflow-pg --status=running
14 in-flight runs (all started before 2026-05-02T15:00Z)

# When count → 0:
$ thodare runs list --world=openworkflow-pg --status=running
0

# Now safe to decommission
$ docker compose down  # take down the old Postgres + worker stack
```

Per the proposal's `world-postgres → world-local` composition pattern in WDK, dual-running both Worlds during the cutover is supported because the API (mounted on the new Cloudflare Worker) can speak to both at the storage layer for read-through. Writes go to the new world only.

### 5.5 What broke (be honest)

Two things, both pre-flagged by capability flags:

1. **The "Retry from this step" UI button vanished** — capability flag tells the truth; users see a "Retry whole workflow" button instead.
2. **One of the connectors generates step outputs >1 MiB (Salesforce list-leads with no filter, ~3 MiB for big orgs).** The validator at `applyOperations` time refused to accept the workflow under the new world. Fix: add a `maxItems: 100` param to that connector, or paginate, or spill to R2. The error message is loud and surfaces immediately, before any production traffic hits the new world.

**Nothing else broke.** The substrate swap is real because the contract test suite proved it (per proposal §3.7 — both worlds passed the same 19-pack suite).

---

## Cross-cutting: what's true at every persona

### The CLI surface — exactly four verbs

```
thodare init                              # scaffold
thodare dev                               # local sqlite + hot reload
thodare run <workflow> [--input '{...}']  # one-shot CI
thodare build --target=<world>            # produce deploy artifact
```

No `thodare deploy`. No `thodare push`. No `thodare login --browser` (use `thodare login --api=<url>` from the existing CLI). Per Flue's discipline.

### The API surface — same against every World

```
# Auth
POST /api/auth/sign-in                    # better-auth
GET  /api/auth/api-key/list               # session-only
POST /api/auth/api-key/create             # session-only

# Workflows
GET  /api/workflows                        # paginated, org-scoped
POST /api/workflows                        # create
GET  /api/workflows/:id                    # read JSON
PATCH /api/workflows/:id                   # rename / set metadata
DELETE /api/workflows/:id                  # soft delete (T14)

# The patch loop
POST /api/workflows/:id/operations         # JSON batch verdict
POST /api/workflows/:id/operations?stream=ndjson   # per-op streaming verdict
POST /api/workflows/:id/diff               # next ops to reach state X (compute-edit-sequence)

# Runs
POST /api/workflows/:id/run                # trigger
GET  /api/runs                             # list, paginated
GET  /api/runs/:runId                      # describe
GET  /api/runs/:runId/steps                # list steps with IO
GET  /api/runs/:runId/stream               # SSE — gated by capability
POST /api/runs/:runId/cancel
POST /api/runs/:runId/resume?step=...      # gated by capability
POST /api/runs/:runId/recover              # gated by capability

# Credentials
GET  /api/credentials                      # list (no secrets)
POST /api/credentials                      # create (secrets in body, encrypted at rest)
GET  /api/credentials/oauth-url            # start OAuth flow
POST /api/credentials/:id/test             # declarative ping
DELETE /api/credentials/:id                # soft delete

# Connectors (registry inspection)
GET  /api/connectors                       # palette
GET  /api/connectors/:type                 # full schema
POST /api/connectors/:type/refresh         # dynamic-schema endpoint (form-state → sub-schema)

# Schedules + webhooks per existing routes
```

Every endpoint is org-scoped via the auth-guarded layer. The capability flags determine which endpoints return 200 vs. 409 `capability_unsupported`. The frontend / LLM / API consumer queries the World once at session start (`GET /api/world/capabilities`) and disables UI affordances accordingly.

### The connector authoring surface — same regardless of World

```ts
import { defineConnector, defineCredentialType, hidden, userOnly } from "@thodare/engine";

defineCredentialType({ id, type, displayName, authConfig, test });

defineConnector({
  type, name, description, category, icon, tags,
  credential: { required, type, requiredScopes },
  params: z.object({
    visibleParam: z.string(),
    secretParam:  hidden(z.string()),       // never reaches the LLM
    userOnlyParam: userOnly(z.number()),    // not LLM-fillable but visible in form
  }),
  outputs: z.object({ id: z.string(), url: z.string() }),
  async execute(params, ctx) {
    // ctx.credential, ctx.env, ctx.log, ctx.signal (cancellation)
  },
});
```

Same code targets every World. The World's capabilities affect what's possible at runtime (max step duration, max output size); the authoring surface is invariant.

### The workflow JSON wire format — identical across Worlds

```jsonc
{
  "version": "1.0.0",
  "metadata": { "name": "incident-page" },
  "blocks": [
    { "id": "trg", "type": "trigger_webhook", "params": { "path": "/incident" } },
    { "id": "n",   "type": "slack_post_message",
      "params": {
        "channel": "#oncall",
        "text": "🚨 {{trg.body.title}}",
        "credentialId": "cred_01HQX..."
      } }
  ],
  "connections": [
    { "source": "trg", "target": "n" }
  ]
}
```

Same JSON, same EditOp loop, same connectors, same API. **What changes is the World underneath.** That's the bet.

---

## What this blueprint deliberately leaves out

- Internal RFC process (covered in `world-abstraction-proposal.md` §10).
- Implementation timing (`world-abstraction-proposal.md` §5).
- Pricing math at scale (`code-reviews/cloudflare-as-world.md`).
- Why this beats just using Inngest / Trigger / Temporal (`code-reviews/durable-engines-survey.md`).
- The conformance test suite specs (`world-abstraction-proposal.md` §3.7).
- Three open decisions for the maintainer (`world-abstraction-proposal.md` §10).

---

**End of blueprint.** Five personas, one substrate. The DX shape that makes the abstraction worth building.
