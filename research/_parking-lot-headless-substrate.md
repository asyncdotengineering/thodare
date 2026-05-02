# Parking lot — headless-substrate goal

> Surfaced 2026-05-02 mid-review. **Must be folded into `world-abstraction-proposal.md` v2.** Saved here so it isn't lost while the 6 code-review agents run.

## The goal (verbatim from the user, with clarification)

> "Also one of the goals of thodare being headless, is for being easy to build solutions like n8n, ActivePieces and the Sim Studio. I hope these primitives already set in the place and new proposal takes into accounts. EditOps was heavily inspired by Sim Studio"

> **Clarification (2026-05-02):** "we are not going to be create to these platforms, but rather what I was implying was the any developers should and can use thodare as the engine to build platforms/applications like n8n / ActivePieces / Sim Studio"

## The correct framing — read carefully before synthesis

**Thodare is the engine. The developer brings the application.**

- ✅ A developer building an n8n-clone uses `@thodare/api` + `@thodare/engine` as their durable backend; they ship their own UI, their own connector library, their own brand. Thodare provides: persistence, runs, durability, retries, multi-tenancy, the JSON DSL, the EditOp patch loop.
- ✅ A developer building a Sim-Studio-style agent builder pulls in `@thodare/engine`, defines their own `Block`s + `Tool`s for their domain, lets their LLM drive `POST /api/workflows/:id/operations`, ships their own canvas.
- ❌ Thodare does **not** ship `world-n8n` or `world-activepieces` adapters that import those projects' connector libraries. Cross-project connector portability is a separate question the developer can choose to solve in their own application.
- ❌ Thodare is **not** competing with n8n / ActivePieces / Sim Studio at the UI/product layer. It's the substrate they (or applications like them) build on.

**The seventh subagent's research is still load-bearing — but only for the second of its two synthesis questions:**

> "Could a developer build an n8n-style / ActivePieces-style / Sim-style UI on top of `@thodare/api`'s endpoints? Do the endpoints expose enough metadata?"

The first synthesis question ("Could a Thodare adapter import n8n nodes as Thodare connectors?") is **out of scope** under this clarification. **Discard that section during proposal v2 synthesis.** Use only the "what does the headless substrate need to expose" findings.

The Sim Studio EditOp re-validation (synthesis question 9 + 10 in the agent's prompt) **stays in scope** — Thodare's EditOp implementation directly inherits from Sim, so confirming the inheritance is correct + identifying anything Thodare missed is genuine validation work, not "import their connectors."

## Implications the proposal v2 must reflect

### The competitive frame is sharper than v1 said

v1 framed Thodare as "the LLM-native control plane that runs on the durable-execution substrate you already have." Add the second axis:

> **And: the headless durable-workflow backend that visual builders (n8n-class, ActivePieces-class, Sim-Studio-class) can ship on top of without building their own engine.**

Two consumers, one substrate. The World abstraction serves both — visual UIs don't care which backend is wired.

### What the World abstraction must guarantee for a UI consumer to be viable

The 8-method `ThodareWorld` interface in proposal v1 covers the orchestrator side. **Visual UIs need more from the API + observability surface** (which is *not* the World, it's `@thodare/api`, but the World must support it). Specifically:

1. **Live run subscription** — UIs need to render "step 3 of 5 running" in real time. Some Worlds support streaming natively (CF DO + WS, openworkflow LISTEN/NOTIFY, Inngest events); some don't (vanilla Lambda + SQS). Must be a capability flag (`supportsLiveSubscription: boolean`) and the API exposes SSE on `/api/runs/:runId/stream` only when the active World supports it.
2. **Step-by-step replay viewing** — UIs need every step's input/output/error/timing for the "execution log" panel. The Storage primitive in `Storage.steps.list({ runId })` must return per-step rows with timestamps and IO; capability flag if the World can't (some serverless backends discard step IO after success).
3. **Retry from a specific failed step** — UIs offer "rerun this step" buttons. Requires the World to support `runWorkflow(name, input, { resumeFromStep: stepId })` or equivalent. **Not in the v1 interface — must add.**
4. **Manual trigger + idempotency** — UIs offer "Run now" buttons that should be idempotent under double-click. Already covered by `runWorkflow(name, input, { idempotencyKey })` in v1.
5. **Cancel mid-flight with deterministic effect** — already covered by `cancel(runId)`.
6. **Connector / piece registry inspection** — UIs render a connector palette. Thodare's `BlockRegistry` + `ToolRegistry` + the `hidden()` visibility model is the substrate. The API already exposes `GET /api/connectors`; that's the headless-consumer contract. **Validate: does the connector schema include enough metadata for an n8n-style "configure node" panel?** (UI labels, descriptions, types, examples, defaults, dropdown options.)

### The connector primitive must be validated against existing visual builders

n8n, ActivePieces, Sim Studio have battle-tested connector models. Thodare's `Block` + `Tool` + `hidden()` model has to be evaluated against theirs:

| Visual builder | Connector unit | What's interesting |
|---|---|---|
| **n8n** | "Node" — class with `description`, `properties[]`, `execute()` | 1000+ in-tree; the `properties[]` schema is the UI source of truth (label/type/options/displayOptions). Heavy condition-display logic. |
| **ActivePieces** | "Piece" — `createPiece({ actions, triggers, auth })` | MIT-licensed framework npm package (`@activepieces/pieces-framework`). Cleaner separation of auth from actions. ~200 pieces. |
| **Sim Studio** | Block + Tool with visibility brands (`hidden() / userOnly() / userOrLlm()`) | **The direct ancestor of Thodare's connector model.** EditOp 5-op shape is Sim's. |

**The seventh code-review subagent's job:** read each of these in source, extract their connector schemas verbatim, and tell me — based on actual code, not vibes — whether Thodare's `Block` + `Tool` + visibility model is sufficient to host a UI that ports any of these connector definitions (or imports them). If gaps exist, list them precisely.

### Sim Studio is special — re-validate the EditOp inheritance

The user notes EditOps was "heavily inspired by Sim Studio." SPEC §3 T1 already credits Sim for the Block↔Tool split + EditOp pattern. But the proposal v1 didn't re-examine Sim Studio. **The seventh agent must read Sim Studio's actual EditOp implementation in source** and answer:

- Does Thodare's 5-op set (`add` / `update` / `remove` / `connect` / `disconnect`) match Sim's exactly, or has it diverged?
- Does Sim use the same skip-don't-reject semantics?
- What other Sim primitives could Thodare lift that aren't yet adopted? (E.g., Sim's `seedOutputs` for resume — already in the in-memory executor; what else?)
- What's Sim's connector schema vs. Thodare's `Block`/`SubBlock`?

### Adapters must surface "headless-friendliness" capability

Add to the v2 proposal's `WorldCapabilities` bag:

```ts
interface WorldCapabilities {
  // ... existing flags ...

  // For headless-UI-builder consumers
  supportsLiveSubscription: boolean;     // SSE / WS for "step 3 of 5 running"
  supportsStepIOInspection: boolean;     // Storage.steps.list returns IO per step
  supportsResumeFromStep: boolean;       // runWorkflow({ resumeFromStep })
  livePanLatencyMs: number;              // Per-step event delivery floor
}
```

### Contract-test additions

The v2 contract-test suite must include UI-consumer-shaped tests:

- "Subscribe to run events; receive step_started / step_completed / step_failed for every step in order, within livePanLatencyMs slack."
- "List runs for org X, paginated, return only org X's runs."
- "Get run with full step history; assert each step has input + output + duration + status."
- "Run workflow with `{ resumeFromStep: stepId }`; assert prior steps are NOT re-executed and the resumed step receives the original input."
- "GET /api/connectors returns enough metadata that an n8n-style node panel can render every input field with its label, type, options, and conditional visibility."

### Adapter roster gets a new dimension

Each v0.2 adapter's README must include a "Headless-UI suitability" matrix:

| | world-openworkflow-pg | world-cloudflare-dynamic | world-wdk | world-inngest |
|---|---|---|---|---|
| Live subscription | ✅ LISTEN/NOTIFY | ✅ DO + WS | depends on inner World | ✅ events |
| Step IO inspection | ✅ | ⚠️ 1 MiB cap per step | ✅ | ✅ |
| Resume from step | ✅ | ⚠️ requires re-create | ✅ | ⚠️ via re-replay |
| Live latency | ~50ms | ~200ms | varies | ~300ms |

So adopters of Thodare-as-headless-backend can pick the World whose UI behavior matches their needs.

## Action items folded into proposal v2

1. **Vision section** — add the "two consumers, one substrate" framing.
2. **Interface §3.2** — add `runWorkflow({ resumeFromStep })`.
3. **Capability flags §3.2** — add `supportsLiveSubscription`, `supportsStepIOInspection`, `supportsResumeFromStep`, `livePanLatencyMs`.
4. **Contract tests §3.3** — add 5 UI-consumer-shaped tests.
5. **New section §6.5 (or wherever fits)** — "Thodare as headless substrate for visual builders." Validate connector primitive against n8n / ActivePieces / Sim Studio. Document the headless-friendliness matrix per adapter.
6. **Migration path Phase 4** — add a `examples/headless-ui-demo/` workspace that renders a minimal canvas reading from `@thodare/api` to prove the substrate story.
7. **Success metrics §8** — add "at least one external project demonstrates a custom UI on top of Thodare via the headless API within 90 days."
