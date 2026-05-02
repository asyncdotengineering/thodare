# Kapso — Code Review

Reviewed:
- `gokapso/whatsapp-support-agent` (cloned at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/whatsapp-support-agent/`)
- `@kapso/workflows` source (cloned at `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/kapso-workflows/`)
- https://docs.kapso.ai/docs/workflows/build-locally
- https://docs.kapso.ai/docs/introduction

Date: 2026-05-02. Versions: `@kapso/cli ^0.15.0`, `@kapso/workflows ^0.2.0`.

---

## 1. What Kapso is

Kapso bills itself as **"the WhatsApp API for developers"** — but the reality the example repo shows is broader. It is a **hosted workflow orchestration platform specialised for WhatsApp**, where:

- Inbound WhatsApp messages trigger graph-shaped workflows.
- Workflow nodes can be LLM **agents**, plain message-sends, decisions, function calls, webhooks, Pipedream actions, sub-workflows, set-variable, and a `raw` escape hatch.
- Custom code lives in **Cloudflare Worker functions** uploaded into Kapso, with a Kapso-managed KV store (`env.KV`) attached.
- Workflows pause (`enter_waiting`) and resume by external HTTP call (`POST /platform/v1/workflow_executions/:id/resume`).
- Authoring happens locally as TypeScript using `@kapso/workflows`; deployment happens via `kapso push` to Kapso cloud.

There is no documented self-host story. Everything ultimately hits `https://api.kapso.ai`. The local TS package is a **graph builder + canonical-JSON compiler**; it explicitly says *"This package does not execute workflows locally."* The runtime is closed.

This makes Kapso closer to **Retool Workflows or Pipedream + WhatsApp + LLM agents**, packaged as a managed product, with a thin TypeScript IaC layer that compiles to JSON that the cloud executes. Not closer to Temporal, not closer to LangGraph-self-host, not closer to Thodare.

---

## 2. The `@kapso/workflows` primitive

### Surface

`@kapso/workflows` exports exactly four things from `src/index.ts`:

```ts
import { START, Workflow } from "@kapso/workflows";
// + types: WorkflowNode, Trigger, FlowDefinition, ValidationResult, ...
```

The `Workflow` class (`kapso-workflows/src/workflow.ts`) has a tiny imperative API:

```ts
class Workflow {
  constructor(slug: string, options?: { name?: string; status?: WorkflowStatus });

  addNode(id: typeof START, options?: { position?: Position }): this;
  addNode(id: string, node: WorkflowNode, options?: NodeOptions): this;

  addEdge(source: string, target: string, options?: { label?: string }): this;
  addTrigger(trigger: Trigger): this;

  toDefinition(): FlowDefinition;          // throws on validation errors
  toSourceFiles(): SourceFiles;            // { definition, definitionJson, metadata }
  toMetadata(): WorkflowMetadata;
  validate(): ValidationResult;
}
```

Internally:
- Nodes stored in a `Map<string, StoredNode>`; duplicate IDs throw.
- Edges stored as `{ source, target, label }`. Default label `"next"`.
- `toSourceFiles()` runs validation, then `compiler.ts` walks every node type and produces a canonical JSON in the React-Flow shape the Kapso server expects: `{ nodes: [{ id, type: 'flow-node', position, data: { node_type, config, display_name? } }], edges: [...] }`.
- `canonicalJson` (`json.ts`) is used to produce a stable, deterministic output, so `kapso push` diffs are clean.

### Node taxonomy (`types.ts`)

Discriminated union `WorkflowNode = AgentNode | CallNode | DecideNode | FunctionNode | HandoffNode | PipedreamNode | RawNode | SendInteractiveNode | SendTemplateNode | SendTextNode | SetVariableNode | WaitForResponseNode | WebhookNode`. Roughly:

| Node type | Purpose |
|---|---|
| `start` | implicit entry, special-cased |
| `send_text` / `send_template` / `send_interactive` | WhatsApp-specific outbound (with sub-types `button`, `list`, `cta_url`, `flow`, `location_request_message`) |
| `wait_for_response` | block until customer replies, optional timeout |
| `decide` | branch — either AI-driven (LLM picks among labelled conditions) or function-driven (function returns label) |
| `function` | run a custom Cloudflare-Worker function, optionally save response to a workflow variable |
| `webhook` | HTTP call out, with `aiFields` for LLM-templated values |
| `pipedream` | invoke a Pipedream action by `appSlug` + `actionId` + `configuredProps` |
| `agent` | the LLM agent — system prompt, model, tools (function tools, webhook tools, knowledge bases, MCP servers, app integration tools), default tools (`enter_waiting`, `complete_task`, `handoff_to_human`, `send_notification_to_user`, `get_whatsapp_context`…), sandbox config |
| `call` | invoke another workflow as a sub-workflow |
| `handoff` | hand off to a human |
| `set_variable` | mutate workflow vars |
| `raw` | escape hatch, write any node-type+config the server understands |

**Critical observation:** every `WorkflowNode` carries an optional `rawConfig?: JsonObject` that gets shallow-merged on top of the compiler output. This is the same trick Thodare's EditOps would aim to be — a stable typed surface plus a typed-but-untyped passthrough so the SDK doesn't gate every server-side feature behind an SDK release.

### What this surface optimises for

- **Authoring DX over runtime.** All complexity is in `compiler.ts` mapping `camelCase` TS to `snake_case` JSON. The library has no execution code, no scheduler, no state machine.
- **Static, declarative graphs.** No conditional graph construction primitives beyond raw JS — you literally write `if (env.SANDBOX) workflow.addNode(...)`.
- **One file = one workflow.** The CLI contract is "default-export a `Workflow` instance from `workflow.ts`". The example's `workflow.ts` even comments: *"The CLI reads the default export below."*

This is a small and deliberate library — about 800 lines of TS total. It is roughly *"React Flow JSON, but as a typed builder you can put in git."*

---

## 3. The WhatsApp agent walkthrough

### File map

```
whatsapp-support-agent/
  kapso.yaml                         # `version: 1` — config marker
  package.json                       # devDeps: @kapso/cli ^0.15.0, @kapso/workflows ^0.2.0
  .kapso/project.json                # { projectId, projectName, linkedAt }  — created by `kapso link`
  .kapso/remote-map.json             # local-slug -> remote-id mapping after push
  workflows/whats-app-support-agent-example/workflow.ts   # the workflow source
  functions/whatsapp-support-agent-ask-team-question/     # private agent tool
    function.yaml                    # entrypoint, function_type, public_endpoint, invoke_response_mode
    index.js                         # `async function handler(request, env)` — Cloudflare Worker
  functions/whatsapp-support-agent-slack-events/          # public Slack webhook
    function.yaml                    # public_endpoint: true
    index.js                         # verifies Slack sig, resumes workflow execution
  scripts/sync-secrets.js            # pushes per-function .env.local secrets up to Kapso
  scripts/validate.js                # local lint
  src/lib/                           # shared constants, env loader, sandbox patch
  tests/                             # bun:test unit tests for both workers + workflow source
```

### The workflow itself (verbatim, condensed)

```ts
// workflows/whats-app-support-agent-example/workflow.ts
import { START, Workflow } from '@kapso/workflows';

export function buildWorkflow(): Workflow {
  const workflow = new Workflow('whats-app-support-agent-example', {
    name: WORKFLOW_NAME,
    status: 'active',
  });

  workflow.addNode(START, { position: { x: 220, y: 120 } });

  workflow.addTrigger({
    phoneNumberId: getRequiredEnv('WHATSAPP_PHONE_NUMBER_ID'),
    type: 'inbound_message',
  });

  workflow.addNode('agent', {
    type: 'agent',
    enabledDefaultTools: [
      'send_notification_to_user', 'get_execution_metadata', 'get_whatsapp_context',
      'get_current_datetime', 'enter_waiting', 'complete_task', 'handoff_to_human',
    ],
    functionTools: [{
      name: 'ask_team_question',
      functionSlug: FUNCTION_SLUGS.askTeamQuestion,
      description: FUNCTION_DESCRIPTIONS.askTeamQuestion,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          question: { type: 'string', description: '…' },
          summary:  { type: 'string', description: '…' },
          title:    { type: 'string', description: '…' },
        },
      },
    }],
    maxIterations: 80,
    maxTokens: 8192,
    providerModel: getOptionalEnv('PROVIDER_MODEL_NAME') ?? DEFAULT_PROVIDER_MODEL_NAME,
    reasoningEffort: 'medium',
    temperature: 0.2,
    systemPrompt: BASE_SYSTEM_PROMPT,
    rawConfig: sandboxPatch?.configPatch,                  // <- escape hatch
  }, { position: { x: 220, y: 320 } });

  workflow.addEdge(START, 'agent');
  return workflow;
}

export default buildWorkflow();
```

That is the **entire** workflow. **Two nodes.** `START → agent`. The "agent" node is a single ReAct-style LLM loop with:
- ~7 built-in tools the platform provides (`enter_waiting`, `complete_task`, `handoff_to_human`, `get_whatsapp_context`, `get_current_datetime`, `get_execution_metadata`, `send_notification_to_user`),
- one custom function tool (`ask_team_question`) backed by a Cloudflare Worker.

The agent's *behaviour* is encoded entirely in the `BASE_SYSTEM_PROMPT`:

> "You are the WhatsApp support agent for this business. Answer directly when you are confident… If not confident, use ask_team_question exactly once for the open customer issue, tell the customer you are checking with the team, then call enter_waiting. When the workflow resumes with `<external_input>`, treat it as internal team guidance, not as a customer message…"

### Inbound → answer flow

1. Customer texts the WhatsApp number → Kapso cloud receives via the inbound webhook tied to `WHATSAPP_PHONE_NUMBER_ID` → matches the `inbound_message` trigger → starts a workflow execution.
2. Execution lands in the `agent` node. The Kapso-side agent loop:
   - Builds prompt from `systemPrompt` + WhatsApp context + customer message.
   - Picks tool calls. For confident answers, it calls `send_notification_to_user` (built-in) and `complete_task`.
   - For uncertain ones, it calls `ask_team_question(question, title?, summary?)`.
3. Kapso invokes the `whatsapp-support-agent-ask-team-question` function (a Cloudflare Worker). The Worker:
   - Reads `body.input` (tool args) and `body.execution_context.system.workflow_execution_id`.
   - Idempotency: looks up `env.KV` for an open question for this execution. If present and `pending`, returns the existing one.
   - Otherwise: assigns `crypto.randomUUID()`, posts to Slack via `chat.postMessage` with the question + customer phone + workflow execution id, stores three KV records: `support-question:<id>`, `support-thread:<channel>:<ts>`, `support-open-question:<execId>`.
   - Returns `{ question_id, slack_channel_id, slack_message_ts, status }` back to the agent.
4. Agent then says to the customer "checking with the team" and calls `enter_waiting` (a built-in tool). The workflow execution suspends server-side.
5. Support team replies in the Slack thread, eventually posts `done`.
6. Slack hits the **public** webhook function `whatsapp-support-agent-slack-events`. That function:
   - Verifies Slack HMAC signature with `SLACK_SIGNING_SECRET` (5-minute window, constant-time compare).
   - On `url_verification`, returns the challenge.
   - On `event_callback` with a `done` thread reply: looks up question via thread key in KV, fetches the full thread via `conversations.replies`, aggregates non-bot non-`done` messages.
   - Calls `POST https://api.kapso.ai/platform/v1/workflow_executions/<id>/resume` with `{ message: { kind: 'payload', data: answer } }` and `X-API-Key: <KAPSO_API_KEY>`.
   - Marks the question `answered` in KV.
7. Kapso resumes the workflow at the `enter_waiting` site, exposing the answer as `<external_input>` to the agent. The system prompt has primed the agent to treat that as internal guidance and reply to the customer.

That is the entire production pattern: **agent + escape-hatch function + external resume webhook + KV-backed idempotency**. No queue. No scheduler. No persistent process. The "long-running" part lives entirely on Kapso's side; the developer only writes stateless Worker handlers.

### Function handler shape (verbatim)

```js
async function handler(request, env) {
  const body = await request.json();
  // ... use env.KV, env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, env.KAPSO_API_KEY ...
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
```

`function.yaml`:
```yaml
entrypoint: index.js
function_type: cloudflare_worker
invoke_response_mode: passthrough
public_endpoint: false   # or true for the Slack webhook
runtime_config: {}
slug: whatsapp-support-agent-ask-team-question
```

A `function_type: cloudflare_worker` with `invoke_response_mode: passthrough` is interesting: it means the function's HTTP response is forwarded as-is to the agent's tool-call result. That is the contract that lets the agent treat any HTTP function as a tool.

`AGENTS.md` is explicit: **"Function entrypoints must stay plain `async function handler(request, env)` files. Do not add `export default` or `module.exports`."** They are eval'd or wrapped server-side.

---

## 4. Build-locally pipeline

Despite the doc page being titled "build locally", **nothing actually executes locally**. The local dev story is:

| Command | What it does |
|---|---|
| `kapso link` | Binds the directory to a Kapso project (writes `.kapso/project.json`). |
| `kapso push --dry-run` | Diffs local source against remote, prints a plan of function/workflow/trigger changes. |
| `kapso push` | Compiles `workflow.ts` (reads default export, runs `toSourceFiles()`), writes `workflow.yaml` + `definition.json` (or skips writing if gitignored), then uploads functions, workflow definition, and trigger config to Kapso cloud. |
| `bun run sync:secrets` | Loops over `.env.local` and pushes per-function secrets via the Kapso API (custom script, not a CLI feature). |
| `bun run validate` | Local lint of function source + workflow source. |
| `bun test` | Bun test runner against the function handlers (using an in-memory KV double in `tests/support/in-memory-kv.ts`). |

There is **no `kapso dev` command** mentioned anywhere in the repo or surfaced docs. There is no local emulator for the workflow runtime, no local agent loop, no local KV. The "local development loop" is:

1. Edit TS / function source.
2. Run unit tests with mocks.
3. `kapso push` to a Kapso project.
4. Send a real WhatsApp message to test end-to-end.

The deploy artifact is **not** a container, binary, or bundle. It is a remote graph + remote functions + remote trigger registration on Kapso cloud, plus per-function secrets. The `.kapso/remote-map.json` keeps local slugs aligned with remote IDs.

---

## 5. State + persistence

Three layers of state, all server-side / Kapso-cloud:

1. **Workflow execution state** lives entirely inside Kapso. Developers see only the `workflow_execution_id` string. Pause/resume is via the Kapso REST API. Variables (`saveResponseTo`, `set_variable`, `vars.customer_name`) are managed by Kapso's runtime; the local SDK never touches them.
2. **Per-function KV** is exposed via `env.KV` inside Worker handlers (`kv.get(key)`, `kv.put(key, value)`, `kv.delete(key)`). This is Kapso's wrapper; tests stub it with an in-memory Map. The WhatsApp example uses three KV namespaces by key prefix (`support-question:`, `support-thread:`, `support-open-question:`) to do idempotency + thread→execution mapping. There is no schema, no migrations, no transactions.
3. **WhatsApp conversation state** is implicitly managed by Kapso (one workflow execution per inbound conversation, judging from the trigger model and the `body.whatsapp_context.conversation` payload).

**Where it lives physically** — the docs do not say. Cloudflare Worker function type strongly suggests Cloudflare KV underneath, with the orchestrator on a different stack. Likely Postgres for execution state given the REST resume API, but that's inference.

---

## 6. Tool / connector model

The agent node has six ways to expose tools to the LLM:

1. **`enabledDefaultTools: string[]`** — first-class platform tools (`enter_waiting`, `complete_task`, `handoff_to_human`, `send_notification_to_user`, `get_whatsapp_context`, `get_current_datetime`, `get_execution_metadata`). These are implemented inside Kapso; the SDK only opts in by name.
2. **`functionTools: AgentFunctionTool[]`** — custom Cloudflare-Worker functions. Each has `name`, `functionSlug`, `description`, `inputSchema` (JSON Schema). Kapso converts to OpenAI-style tool definitions and dispatches HTTP calls.
3. **`webhooks: AgentWebhookTool[]`** — direct HTTP tools (URL, method, headers, body template) without a function indirection.
4. **`mcpServers: JsonObject[]`** — passthrough MCP server configs.
5. **`appIntegrationTools: JsonObject[]`** and **`knowledgeBases: JsonObject[]`** and **`resources: JsonObject[]`** — typed only as `JsonObject` in the SDK; the shape is server-defined.
6. **`rawConfig`** — escape hatch to inject arbitrary fields if the SDK is behind the server.

Tool inputs are JSON-Schema-typed. Tool outputs are arbitrary JSON returned from the Worker; the agent sees the response body verbatim (`invoke_response_mode: passthrough`).

The key insight: **the LLM agent itself is a node in the workflow graph**, but it is *also* a sub-graph in its own right (its own tool-call loop with its own iteration limit, `maxIterations: 80`). The outer graph here only has one real node. In more complex workflows you would chain multiple agent nodes, decision nodes, and explicit message-sends — but for an agentic chatbot, "one mega-agent + many tools" is the intended pattern.

---

## 7. Top 5 surprises

1. **The library is pure compiler.** `@kapso/workflows` is ~800 lines of TS that build a graph and emit JSON. There is zero runtime. The README literally states this. The `@kapso/cli` package does *not* re-export it; the CLI just imports `workflow.ts`'s default export and serializes it. This is a much smaller bet than e.g. LangGraph or Temporal SDKs.
2. **One workflow file = one default export.** No multi-workflow files, no workflow factories registered into a manifest. The CLI contract is brutally simple — read a file, get a `Workflow` instance, push it. Multiple workflows means multiple directories under `workflows/`.
3. **Custom code is Cloudflare Workers, not arbitrary Node.** `function_type: cloudflare_worker` and the `(request, env)` handler shape constrain everything. No filesystem, no long-running processes, no in-memory state across invocations. This pushes everything stateful into KV.
4. **Pause/resume is HTTP-based, not callback-based.** The `enter_waiting` tool suspends the execution, and the *only* way back in is `POST /platform/v1/workflow_executions/:id/resume`. This means external systems must remember the execution id (which the example does in KV), and there's no notion of "wait for this signal" with a typed channel — it's "wait, then later anyone with the API key can resume you with arbitrary payload".
5. **The escape hatch is not just `raw` nodes — every node has `rawConfig`.** The compiler shallow-merges `node.rawConfig` on top of every typed config. So you can use the typed `agent` node and still smuggle in `sandbox_*` fields the SDK doesn't model. This is exactly the IaC pattern that lets the surface stay small while the cloud iterates fast — and it's the same shape Thodare wants for EditOps.

---

## 8. Implications for Thodare

### 8a. What Thodare should lift from Kapso's DX

- **`rawConfig` everywhere as a first-class escape hatch.** Every typed node carries a passthrough field. This lets the TS surface stay slim without ever blocking the user. Thodare's EditOps should bake this in for every primitive — typed fields plus a `raw` overlay merged last. It is the single best DX decision in the Kapso codebase.
- **Canonical JSON output.** `kapso-workflows/src/json.ts` produces deterministic JSON so `kapso push` diffs cleanly. Thodare should commit to canonical serialization (sorted keys, stable ordering, trailing newline) from day one — it makes git-tracked workflows reviewable and EditOp-driven LLM workflows replayable.
- **Discriminated union of typed nodes + `raw` node escape valve at the *type* level too.** `WorkflowNode` is a TS discriminated union; the `raw` variant lets you write any `nodeType` string. Thodare should keep the same dual-channel pattern (well-known node types as a closed enum, plus a `raw` node for anything else).
- **Tiny imperative builder API.** Three methods: `addNode`, `addEdge`, `addTrigger`. No fluent monad chains, no JSX. LLMs have an easier time emitting this than e.g. LangGraph's class-method DSL. Thodare's TS surface should be similarly boring.
- **`AGENTS.md` per repo with hard rules.** The WhatsApp repo's AGENTS.md is excellent — it tells an agent landing in the repo *exactly* what is invariant ("function entrypoints must stay plain `async function handler(request, env)`"). Thodare's project scaffolds should ship with this kind of LLM-first README.
- **One workflow per file with default-export contract.** It's dumb-simple, works with bundlers, works with diffing tools, and avoids the "register a manifest" anti-pattern. Worth copying.
- **Separation: graph vs. functions vs. secrets vs. project link.** Four concerns, four file layouts (`workflows/`, `functions/`, `.env.local`, `.kapso/`). Each has its own push command. This makes the deploy story legible.

### 8b. Kapso's bet vs. Thodare's bet

Kapso is betting that **WhatsApp is the surface that matters and the runtime is an internal-implementation detail nobody should see**. The TS library is just a typed JSON emitter; the real value is the cloud — agent tool calling, suspended execution state, Slack/Pipedream integrations, sandboxed Cloudflare Workers, Slack/MCP/KV management. That bet only works as a SaaS. They have made authoring almost-trivial and pushed all the hard parts behind `api.kapso.ai`.

Thodare is betting **the runtime is the product** — a self-hostable, headless workflow engine where the JSON+EditOp surface is the universal interface that humans, LLMs, and visual builders all program against. Where Kapso ships a closed runtime + open authoring SDK, Thodare ships an open runtime + a portable JSON workflow format that any authoring layer (TS DSL, visual builder, LLM EditOp agent, plain JSON) can target.

The two bets are *complementary*, not competing:
- Kapso owns the WhatsApp-agent vertical and ships all-cloud.
- Thodare wants to own the horizontal substrate underneath any agent product.

### 8c. Could Thodare be the headless backend for a Kapso-class WhatsApp agent product?

**Architecturally, yes — with three concrete gaps.**

What Thodare would need that the WhatsApp-agent example reveals as load-bearing:

1. **Suspend/resume by external HTTP call.** The pattern of `enter_waiting` + `POST /workflow_executions/:id/resume` with arbitrary payload is the central primitive that makes "human in the loop via Slack" possible. Thodare needs:
   - A typed "wait for external signal" node.
   - A REST endpoint that resumes by execution id with a typed payload.
   - The payload exposed to subsequent nodes as a named variable (Kapso uses `<external_input>` in the agent prompt).
2. **An agent node with native tool-call dispatch.** The Kapso `agent` node is doing real work: ReAct loop, tool registry, JSON-schema validation, default platform tools, `maxIterations`/`maxTokens`/`reasoningEffort`/`temperature` config. Thodare needs an opinionated agent primitive (or a "function-calling LLM loop" primitive) that wraps its own iteration state. Whether this is one node or composed from smaller nodes is an open design call.
3. **Per-function durable KV (or equivalent).** The WhatsApp example is unworkable without `env.KV` for idempotency and execution↔thread mapping. Thodare functions/handlers need a built-in key-value store keyed by namespace, or workflows need first-class long-lived variables that custom code can read/write.

What Thodare already has (or is on track for) that maps cleanly:

- A graph engine with typed nodes — same shape as Kapso's `FlowDefinition`.
- JSON-as-source-of-truth — same shape as Kapso's `definition.json`.
- An EditOp surface for LLMs — Kapso doesn't have this; it would be a *strict superset* of the Kapso SDK's `addNode`/`addEdge` model.

**What's missing for parity with the *product* (not the engine):**

- WhatsApp Cloud API integration (inbound webhook → trigger; outbound message-send nodes; template management; interactive message types; conversation/contact context). Kapso has built this whole vertical; Thodare would need it or would deliberately delegate it to user-written functions.
- A managed sandboxed function runtime (Cloudflare Workers in Kapso's case; could be Deno Deploy / WASM / containers in Thodare's case). For self-hosters, an "exec a JS file in a worker" stub is enough; for SaaS-ifying Thodare, a real isolate is required.
- A managed secrets store accessible from function `env`.
- A built-in registry of "default tools" the agent can opt into (`enter_waiting`, `complete_task`, `handoff_to_human`, etc.).
- A trigger system (inbound webhook routing → workflow execution start).

**One-line verdict:** A developer cannot today build a Kapso-class WhatsApp agent product on Thodare without writing the agent loop, the WhatsApp integration, the suspend/resume HTTP API, and a function runtime themselves — but the workflow-as-JSON substrate Thodare is building is exactly the right shape to be that backend, and adding a typed `agent` node, a typed `wait_for_external_input` node, and a `POST /executions/:id/resume` endpoint would close ~80% of the gap.

---

## Appendix: answers to the specific questions

| Question | Answer |
|---|---|
| Verbatim TS for defining a Kapso workflow? | See section 3 — `new Workflow(slug, opts)` + `addNode(START, ...)` + `addNode(id, {type, ...})` + `addEdge` + `addTrigger`, default-exported. |
| Verbatim TS for the WhatsApp agent's main entry? | The whole `workflow.ts` is two nodes: `START → agent`. The "agent" is a single LLM loop with one custom function tool and seven built-in tools. There is no "main" entry beyond the default export. |
| Where does conversation state live? | Kapso cloud (workflow execution state — opaque to the developer, accessed only by execution id). Per-function ephemeral state lives in `env.KV` (Kapso-managed, likely Cloudflare KV underneath). WhatsApp conversation context is injected per-trigger as `body.whatsapp_context`. |
| Self-hostable or Kapso-Cloud-only? | Kapso-Cloud-only. The CLI pushes to `api.kapso.ai`. No self-host docs, no docker-compose, no open runtime. |
| Is Kapso's runtime open-source-headless or closed? | Closed. `@kapso/workflows` (the only OSS piece visible) is explicitly a graph builder with no executor. |
| One workflow per conversation, or one workflow many conversations? | One workflow definition serves many conversations; each inbound message starts a new workflow execution (one execution per conversation lifecycle, based on the inbound trigger model). |
| What's the deploy artifact? | A remote graph (`definition.json` + `metadata`) + uploaded Cloudflare Worker function source + trigger registration + per-function secrets. There is no local artifact (no container, no binary, no bundle). |
