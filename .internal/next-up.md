# Next-up — prioritized work queue

> **Read [`HANDOFF.md`](./HANDOFF.md) §13 first** — it's the kickoff for the next session. Phases 1–4.x.1 of the v1 backend-abstraction proposal are merged to `dev`. Phase 5 (`@thodare/backend-vercel`) is the open work. AWS is out of scope for v1.0.
>
> **Stale-but-kept items**: Tier 2 entries below ("Factor Backend interface for runtime portability", "Cloudflare Workers backend") describe work that has been **completed in Phases 1–4.x.1** — kept for historical context. The current Phase 5 plan supersedes those.

Ranked by leverage and effort. Pick from the top of a tier; ship; come
back. Each item references the SPEC section it sits under (so you
don't redesign decisions T1–T19 already made).

## Tier 1 — fast wins (1–2 days)

### `thodare workflow {list,get,run,logs}` — extend the CLI

- **Why.** Auth is rock-solid as of 0.1.1. The CLI currently does
  login + key management but not workflow operations. Filling that
  gap turns it from "key issuer" into a real client.
- **Where.** `packages/cli/src/commands/workflow.ts` (new file).
  Mirror the structure of `commands/key.ts`. Routes already exist
  in `@thodare/api`.
- **Acceptance.**
  - `thodare workflow list` — paginated workflow list with id, name,
    version, updatedAt.
  - `thodare workflow get <id>` — pretty-print the workflow JSON.
  - `thodare workflow run <id> [--input '{...}']` — dispatch a run,
    print runId.
  - `thodare workflow logs <runId> [--follow]` — tail step attempts.
  - JSON output when stdout isn't a TTY (for scripting).
  - 8+ tests in `packages/cli/tests/07.workflow-commands.test.ts`.
- **SPEC §:** v0 already shipped the API; CLI extension is `T15` follow-on.

### `@thodare/telemetry-otel` — concrete tracing recipe

- **Why.** The engine ships `withTracing(backend, hooks)` decoupled
  from any specific tracing SDK. Most users want OTel; shipping a
  recipe package eliminates the "how do I wire OTel?" support load.
- **Where.** New package `packages/telemetry-otel/`. Single export:
  `withOtelTracing(backend, opts)` that calls `withTracing` with hooks
  that emit OTel spans.
- **Acceptance.**
  - Recipe package depends on `@thodare/engine`, `@opentelemetry/api`.
  - 4+ tests with an in-memory OTel exporter.
  - Doc page under `apps/docs/src/content/docs/how-to/wire-otel.md`.
- **SPEC §:** part of v0 deferred to v1+ ("built-in OTel exporters").

### Production scheduler process

- **Why.** Today the dispatcher tick is `POST /api/admin/tick`,
  driven manually or by pg_cron. A dedicated worker process (~50
  LoC) is cleaner and removes the "service-account API key for the
  ticker" footgun.
- **Where.** `examples/scheduler/` (a workspace example) or new
  package `packages/scheduler/` if we want to publish it.
- **Acceptance.**
  - Calls `tryClaim` directly (no HTTP round-trip).
  - 60s interval with jitter.
  - Graceful shutdown on SIGTERM.
  - `setSensorIsolationGuard`-style invariant check before claiming.
  - 3+ tests proving the loop fires + handles errors.
- **Cross-reference.** openworkflow exposes a one-shot `availableAt`
  primitive on `runWorkflow(spec, input, { availableAt: <ISO|"5m"> })`.
  That's *not* what we use today — our scheduler runs the cron tick
  and dispatches when the cutoff matches. Worth evaluating as a
  simplification: each schedule fire could enqueue the NEXT cron
  firing via `availableAt`, eliminating the poller. Trade-off is
  downtime catch-up — `availableAt` doesn't fire missed runs. See
  [`decisions.md` D-016](./decisions.md#d-016) for the open question.
- **SPEC §:** T12 follow-on.

### GitHub Actions release workflow

- **Why.** Currently we publish via `pnpm publish` manually. Replace
  with CI on tag push using OIDC for npm provenance. Eliminates
  "forgot to check tarball contents" footguns.
- **Where.** `.github/workflows/release.yml`.
- **Acceptance.**
  - Triggers on tag push matching `@thodare/*@*`.
  - Runs `pnpm install --frozen-lockfile`, `pnpm -r run build`,
    `pnpm test`.
  - `pnpm publish --filter <pkg>` with `--provenance`.
  - `permissions: id-token: write, contents: read`.
- **SPEC §:** T15 follow-on.

## Tier 2 — meaningful structural work (3–5 days)

### Factor Backend interface for runtime portability — **DONE 2026-05-04** (Phases 1–3 merged to `dev`; superseded by `@thodare/backend` + `@thodare/backend-contract-tests` + 3 adapters)

- **Why.** Today `@thodare/engine` is tightly coupled to openworkflow's
  specific `Backend` shape. A future Cloudflare Workflows backend
  (or any other durable-execution substrate) needs an abstract
  interface to slot into. Doing the refactor *before* a second
  implementation exists keeps the abstraction honest — driven by what
  the engine actually uses, not by accommodating a specific second
  vendor's API. See [`decisions.md` D-015](./decisions.md#d-015) for
  the full rationale.
- **Where.** `packages/engine/src/runner/backend.ts` (new) — declare
  the surface (`runStep`, `sleep`, `waitForSignal`, `createRun`,
  `getRun`, `cancelRun`, listing/cursors). Existing
  `runner/openworkflow.ts` becomes one implementation behind that
  interface. No external behavior change.
- **Acceptance.**
  - Engine source no longer imports openworkflow types directly
    outside `runner/openworkflow.ts`.
  - `@thodare/engine` consumers can pass `{ backend: ThodareBackend }`
    where today they pass `{ backend: BackendPostgres }`.
  - 117 engine tests still green.
  - Doc page: `apps/docs/src/content/docs/explanation/backend-portability.md`
    explains the interface + why it exists + what a second
    implementation would look like.
- **SPEC §:** prep for v1+ deferred items. Doesn't add a feature; it
  unlocks the option to add one cheaply later.

### `@thodare/cf-engine` (gated on customer signal) — **SUPERSEDED 2026-05-04** by `@thodare/backend-cloudflare-dynamic` (Phases 4 + 4.x + 4.x.1 merged to `dev`; uses `cloudflare/dynamic-workflows@^0.1.1` + D1 + DO+WS streams). Real-engine e2e validated.

- **Why.** Once the Backend interface exists (above), implementing CF
  Workflows as a second backend becomes a self-contained week-ish
  package: edge-native deployment, hibernation pricing on long
  pauses, no Postgres for step persistence. Today's docs caveat —
  "Workers can run the API but you need a Postgres worker pod for
  durable execution" — goes away.
- **Where.** New package `packages/cf-engine/`. Single
  `WorkflowEntrypoint` (no `dynamic-workflows`; we already are the
  dispatcher via `wfkit-runtime`'s JSON walker). Implements the
  `Backend` interface against `WorkflowEntrypoint` / `WorkflowEvent`
  / `step.*`.
- **Acceptance.** TBD via RFC at `rfcs/cf-engine/` once a real
  customer says they'd ship on Workers. Don't open the RFC until
  CF Workflows is GA and one user has put their hand up. Building
  reactively under a deadline is worse than waiting; the abstraction
  in the previous item is the prep that makes "wait" cheap.
- **SPEC §:** v0 deferred — no T-id contradicted; sits parallel to
  T6 (vendored openworkflow remains the default substrate).

### Org deletion hooks

- **Why.** better-auth's `auth.api.deleteOrganization` currently
  leaves orphaned workflows + schedules + keys. We need a
  before-delete hook that either refuses if non-empty, or with a
  `--force` flag cascades + audits.
- **Where.** `packages/api/src/auth.ts` adds
  `databaseHooks.organization.delete.before`.
- **Acceptance.**
  - Without `force: true`: returns 409 with counts of orphans.
  - With `force: true`: deletes workflows, schedules, keys; emits
    audit row; transaction-wrapped.
  - 5+ tests covering the safe + force paths.
- **SPEC §:** v0 deferred.

### Streaming run logs (SSE)

- **Why.** `GET /api/runs/:runId/logs` is paginated cursor-based.
  Adding `GET /api/runs/:runId/stream` (SSE) lets UIs tail in real
  time without polling.
- **Where.** New route in `packages/api/src/routes/runs.ts`. Backend
  is openworkflow's `listStepAttempts` cursor.
- **Acceptance.**
  - Emits `event: step_attempt` for each new attempt.
  - Heartbeats every 15s.
  - Closes when run reaches terminal state (`completed` / `failed`).
  - Backpressure-safe (uses Hono streams).
  - 4+ tests including a slow consumer.
- **SPEC §:** v0 deferred.

### Cloudflare Workers backend (durable objects) — **SUPERSEDED 2026-05-04** — see `@thodare/backend-cloudflare-dynamic` above

- **Why.** openworkflow's worker assumes a long-running process.
  Workers + Durable Objects can host the API surface AND the durable
  execution if we ship a DO-backed step persistence layer.
- **Where.** New package `packages/backend-do/` exporting
  `BackendDurableObjects`. Consumers swap for `BackendPostgres` in
  `createWfkit({ backend })`.
- **Acceptance.**
  - Implements the same Backend interface as `BackendPostgres`.
  - 8+ tests in `packages/engine/tests/` proving step replay,
    crash recovery, signal-driven waits work the same way.
  - Example deployment under `examples/deploy-cf-workers/`.
- **SPEC §:** v0 deferred. Big lift; consider after Tier 1.

### Connector marketplace primitives — *held for v1.1 per backend-abstraction-proposal §2.4*

- **Status (2026-05-02).** **Held.** v1 ships first-party connectors
  as separate `@thodare/connector-*` npm packages (ActivePieces-style
  packaging — `@thodare/connector-slack`, `@thodare/connector-stripe`,
  `@thodare/connector-google-sheets`, etc.). Customers `npm install`
  what they need. The marketplace primitive (per-org installed
  registry + per-org versioning + sandboxed custom-connector
  execution) is a **v1.1+ effort**.
- **Why deferred.** The DAG-workflow-builder use case
  (`usecases/dag-workflow-builder.md`) needs the full marketplace —
  per-org installed registry, per-org connector pinning, sandboxed
  enterprise custom code. Building this in v1.0 is at least a 3-week
  effort + ongoing maintenance burden. Shipping first-party
  connectors as plain npm packages closes 80% of the value at 10%
  of the cost; the remaining 20% (custom per-org code, marketplace UI,
  sandboxing) waits for clear demand.
- **Why.** Today connectors ship with the application binary. A
  marketplace lets you publish a connector once and consume it across
  many Thodare deployments — and lets enterprise customers ship their
  own private connector code without granting Thodare full Node
  access.
- **Acceptance (when v1.1 picks this up).**
  - `packages/connector-marketplace/` — per-org installed-connector
    registry table, CRUD endpoints, per-org version pinning.
  - `packages/connector-sandbox/` — adapter for sandboxed execution
    (libkrun via iii-sandbox pattern, OR e2b, OR Modal, OR
    Cloudflare Workers per-isolate). Pick one.
  - New CLI verbs: `thodare connector publish` / `install` for
    private custom-connector packages.
  - 8+ tests proving per-org isolation + version pinning + sandbox
    cannot escape org context.
  - RFC at `rfcs/connector-marketplace/README.md` first.
- **SPEC §:** v0 deferred. Cross-references the
  `usecases/dag-workflow-builder.md` §7 P0 + §3 connector-marketplace
  callouts in the backend abstraction proposal.

### First-party connector packages (ActivePieces-style packaging) — *v1 starter set*

- **Status (2026-05-02).** **Will ship in v1 Phase 5b alongside the
  visual-builder gap closures.**
- **Why.** Holds the marketplace primitive while still letting the
  4 use cases in `usecases/` build their products. ActivePieces
  ships ~250 community pieces this way (separate npm packages under
  `@activepieces/piece-*`); Thodare can do the same under
  `@thodare/connector-*`.
- **v1 starter set** (5 packages).
  - `@thodare/connector-slack` — `send_message`, `create_channel`,
    `lookup_user`, `set_status`.
  - `@thodare/connector-resend` — `send_email`, `create_audience`,
    `add_contact`.
  - `@thodare/connector-github` — `create_issue`, `comment_on_issue`,
    `list_pull_requests`, `merge_pr`.
  - `@thodare/connector-stripe` — `create_customer`, `create_payment_intent`,
    `refund`, `list_charges`.
  - `@thodare/connector-google-sheets` — `append_row`, `read_range`,
    `update_cell`, `list_sheets`.
- **Where.** Each package is its own workspace under
  `packages/connector-<vendor>/`. Each ships the connector definition
  + credential type + tests + README. Independently versioned via
  Changesets per T15.
- **Acceptance.**
  - 5 packages published to npm.
  - Each connector passes the engine's connector contract tests
    (Zod schema valid, OAuth flow round-trips, params validated).
  - Each package's README documents the connector's `defineConnector`
    shape + the credential type + an example workflow JSON snippet.
  - At least one example in `examples/` uses each connector.
- **SPEC §:** v0 already shipped the connector primitive. This is
  packaging-and-discipline work, not engine work.

## Tier 3 — strategic (one week+)

### Helm chart + Terraform modules

- **Why.** Most-requested for prod self-host. Without these, every
  adopter writes their own k8s manifests + IaC.
- **Where.** `charts/thodare/` (Helm), `infra/terraform/aws/` and
  `infra/terraform/gcp/`.
- **Acceptance.**
  - Helm chart deploys API + a worker pod + a scheduler pod.
  - TF module provisions Postgres (RDS / Cloud SQL), the API service
    (ECS / Cloud Run), DNS, secrets.
  - Doc page: `apps/docs/src/content/docs/how-to/deploy.md` extends
    with a "Helm" + "Terraform" section.
- **SPEC §:** v0 deferred.

### Connector pack (Notion / HubSpot / Drive / Salesforce / Gmail / Jira)

- **Why.** Ten or more "I want to send a Slack from a Hubspot deal-close
  webhook" requests. Shipping these as `@thodare/connector-<vendor>`
  unblocks adopters.
- **Where.** New packages, one per vendor. Each ~300 LoC + 3 tests.
- **Acceptance.** Per-connector scope review; not one giant PR.
- **SPEC §:** v0 deferred.

### Evaluate vercel-labs/workflow-builder-template — UI port for Thodare

- **Why.** [vercel-labs/workflow-builder-template](https://github.com/vercel-labs/workflow-builder-template)
  is a v0-style canvas UI for building / editing workflows. If
  Thodare's `SerializedWorkflow` JSON is close enough to whatever the
  template uses internally, porting it would give us a real
  drag-and-drop editor without writing one from scratch. The LLM patch
  loop continues to work alongside; the UI is the human's path, the
  patch endpoint is the LLM's.
- **Where.** Likely a new `apps/builder/` workspace, or a separate
  repo if the template's licensing makes that easier.
- **Acceptance.** TBD via spike. First step: read the template's
  workflow shape, compare to `SerializedWorkflow`, write a small
  proof-of-concept adapter that round-trips a workflow between the
  template's editor and `POST /api/workflows/:id/operations`. ~3-day
  spike before opening an RFC at `rfcs/builder-ui/`.
- **SPEC §:** v0 deferred. Doesn't change any T1–T19 (the patch
  surface stays the source of truth; the UI is a layer on top).

### LLM-to-workflow examples — `examples/llm-build/*`

- **Why.** The repair-loop tutorial in `apps/docs/tutorials/repair-loop.md`
  shows the pattern with an inline OpenAI call. Concrete runnable
  examples backed by [Vercel AI SDK](https://sdk.vercel.ai) and
  [Anthropic's Claude Agent SDK](https://docs.anthropic.com/en/api/claude-agent-sdk)
  would give adopters copy-paste starting points instead of "here's
  the idea, plumb it yourself."
- **Where.** Two examples under `examples/`:
  - `examples/llm-build-vercel-ai-sdk/` — uses `@ai-sdk/anthropic`
    or `@ai-sdk/openai` with the AI SDK's tool-use + structured
    output for the `apply_patch` / `run_workflow` tools.
  - `examples/llm-build-claude-agent-sdk/` — uses Anthropic's
    Claude Agent SDK directly. Better fit if the LLM needs to
    reason across multiple patch rounds before settling.
- **Acceptance.** Each example is a `@thodare-examples/*` workspace
  package, prints "✓ workflow built and ran" on success, ≤80 LoC of
  glue. Doc cross-link from the repair-loop tutorial.
- **SPEC §:** v0 deferred. Documentation work, not engine work.

## Won't do (yet)

These have come up but are explicitly not on the v1 path:

- ❌ Built-in `code_execute` block. Sandbox is your problem.
- ❌ A no-code dashboard. Build it on top.
- ❌ A fire-and-forget queue. Use Inngest / SQS / a queue.
- ❌ Streaming data pipelines (Kafka / Flink shape). Wrong tool.

## How to claim something

1. Read [`HANDOFF.md`](./HANDOFF.md) and the relevant SPEC section.
2. Open an RFC under `rfcs/<slug>/README.md` for anything Tier 2+.
3. Comment on a tracking issue (or open one) with "claiming this".
4. Ship per the workflow in [`HANDOFF.md`](./HANDOFF.md) §7.

When a tier 1 item ships, **bump it out of this list and add an
entry in [`decisions.md`](./decisions.md)** if any structural choice
got made along the way.
