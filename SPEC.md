# Thodare — v0 spec

> **Status:** v0 (alpha 0.1.x). Treat the locked decisions in §3 as
> immutable for v0; propose edits via RFC for v1+.
>
> **Audience:** maintainers, contributors, and any new Claude Code
> session that reads `.internal/HANDOFF.md`.

## §1 What Thodare is

Thodare is an HTTP control plane that exposes a typed, durable
workflow engine to LLM orchestrators, agents, and UIs. It's the
bridge between *"the LLM produced a workflow JSON"* and *"that
workflow ran to completion across deploys, with full audit history."*

It runs on top of [openworkflow](https://github.com/openworkflowdev/openworkflow)
(Apache-2.0; vendored as `@thodare/openworkflow` for version pinning),
exposes a [Hono](https://hono.dev) HTTP surface, and uses
[better-auth](https://www.better-auth.com) for identity with the
`organization` and `apiKey` plugins enabled by default.

## §2 The bets

Three load-bearing claims that the rest of the project derives from.
If you find yourself contradicting one, **stop and write an RFC**.

1. **Skip-don't-reject is the right primitive for AI-driven
   workflow construction.** Every other API rejects bad ops on first
   error. Thodare applies what it can and returns structured skip
   reasons feedable directly back to the LLM. This is what makes
   single-shot LLM workflow construction work.

2. **Durability is the substrate, not a feature.** Every step is one
   `step.run()` call against openworkflow's worker. Replay
   determinism, crash recovery, and signal-driven waits are the
   engine's contributions. We don't bolt step-caching on top — we sit
   on it.

3. **Multi-tenant isolation must be structural.** Every
   workflow / run / schedule / API key is scoped to an organization.
   Cross-org reads return 404, not 403. This isn't a feature the
   docs encourage; it's a property of every store query and every
   route handler. Tests prove it.

## §3 Locked decisions (T1–T19)

These derive from the bets and shape the codebase. They are
**immutable for v0**. Changing any of them needs an RFC + maintainer
sign-off.

### Engine + DSL

- **T1.** Connector-shaped DSL: Block↔Tool split, `visibility` flag,
  declared output schemas, `kind: "wait"` blocks for durable pauses,
  `EditOp` patches with five operations (`add` / `update` / `remove`
  / `connect` / `disconnect`). Patterns originally pioneered by Sim
  Studio; reimplemented in TypeScript with Zod-driven validation.
- **T2.** **Skip-don't-reject** on `POST /api/workflows/:id/operations`.
  Bad ops are *skipped* with structured `reason_code` +
  human-readable `reason`. The whole patch never fails on a single
  bad op; partial validity > no progress.
- **T3.** **`hidden()` params are structural, not advisory.** Hidden
  params never appear in `GET /api/connectors`. The LLM cannot
  reference them in op `params`; if it tries, the op is skipped with
  `hidden_param_in_input`. This is the secret-handling boundary.
- **T4.** **Workflow JSON is pinned at run-start.** The workflow JSON
  is passed as part of the run input; in-flight runs use the version
  they started with even if the workflow is patched mid-run. Sim's
  pattern; same constraint as Sim, same resolution.
- **T5.** **One generic runtime workflow.** openworkflow's registry
  is closed at `worker.start()`. Thodare registers exactly one
  openworkflow workflow (`wfkit-runtime`) with input
  `{ workflow, input }` that walks the JSON dynamically. Lets us
  register new Thodare workflows at runtime without redeploying
  openworkflow's worker.

### Vendoring

- **T6.** **openworkflow is vendored as `@thodare/openworkflow`** for
  version pinning + patch capability. License preserved
  (Apache-2.0); source files match upstream byte-for-byte for v0.
  Sync cadence and Apache-2.0 obligations documented in
  `packages/openworkflow/UPSTREAM.md` and the repo `NOTICE`.

### Auth + tenancy

- **T7.** **better-auth is the identity layer.** No custom session
  store, no hand-rolled JWT, no shadow user table. v1.6+.
- **T8.** **Auto-org on signup.** Every new user gets a personal
  organization via `databaseHooks.user.create.after`; the
  organization plugin's `setActiveOrganizationOnSessionCreate`
  default activates it. No `401 no_active_organization` on first
  request.
- **T9.** **API keys reference organizations, not users.**
  `references: "organization"` on the apiKey plugin. The verified
  key's `referenceId` is the org id — one call, no metadata join.
- **T10.** **Per-`(organizationId, principal)` rate limit.**
  `principal` is the apiKey id when authenticating via key, or the
  user id when via session. One tenant cannot starve another; one
  user's session cannot starve another's keys.
- **T11.** **Multi-tenant isolation is enforced at the row, not the
  schema.** Every store method takes `organizationId`; every query
  filters on it. The schema-per-API-instance isolation in our test
  harness is for *test concurrency*, not tenant separation.

### Operational durability

- **T12.** **Persistent schedule claim.** `last_fired_at timestamptz`
  on the `schedules` row, claim via `SELECT … FOR UPDATE`. Two
  parallel tickers (multi-pod / pg_cron) cannot double-fire. Proven
  by a 50-racer test.
- **T13.** **First-run admin bootstrap is opt-in + single-use.**
  `THODARE_BOOTSTRAP=1` AND empty `user` table → signed
  `/api/bootstrap?token=…` link is logged once at boot. Self-disables
  when the user table is non-empty.
- **T14.** **Soft delete only.** `DELETE /api/workflows/:id` sets
  `deleted_at`; the row stays. In-flight runs that snapshotted the
  JSON keep working; subsequent reads return 404. Hard deletion would
  orphan in-flight runs.

### Repo + dev discipline

- **T15.** **pnpm monorepo + Changesets.** Per-package versioning;
  `workspace:*` rewritten at publish time. Every PR with a
  user-visible change adds a `.changeset/*.md`.
- **T16.** **`@tsconfig/strictest` + `@tsconfig/node22` workspace-wide.**
  All `packages/*` and `examples/*` extend `tsconfig.base.json`.
  Same as upstream openworkflow; aligns the whole workspace on one
  strictness baseline.
- **T17.** **No `as any`. No `@ts-ignore`. No type widening to defeat
  `exactOptionalPropertyTypes`.** When TS surfaces an error, fix at
  the source — conditional spreads at construction sites, narrower
  return types where a helper guarantees a field. The strictness is
  a feature.

### Public surface

- **T18.** **Diataxis discipline for docs.** Every page in
  `apps/docs/` belongs to one of: tutorial / how-to / reference /
  explanation. Plus *Start here* and *Project*. One concern per page,
  short, single-purpose.
- **T19.** **License: MIT for the workspace, Apache-2.0 for vendored
  components.** `LICENSE` covers our work; `NOTICE` documents
  vendored attributions; each vendored package retains its original
  license file (e.g., `packages/openworkflow/LICENSE.md`).

## §4 Architecture at a glance

```
HTTP request
   │
   ▼
┌──────────────────────────┐
│ Hono app (@thodare/api)  │   /health, /api/auth/*, /api/bootstrap
└──────────────────────────┘
   │
   ▼  authGuard → user, organizationId
┌──────────────────────────┐
│ Route handler            │   workflows / runs / schedules / connectors / webhooks
└──────────────────────────┘
   │
   ▼  scoped by organizationId
┌──────────────────────────┐
│ Postgres stores          │   workflows, schedules
└──────────────────────────┘
   │
   ▼  POST /:id/run
┌──────────────────────────┐
│ runtimeHost.dispatch()   │   loads JSON, packs into run input (T4)
└──────────────────────────┘
   │
   ▼
┌──────────────────────────┐
│ wfkit-runtime workflow   │   ONE openworkflow workflow that walks JSON (T5)
└──────────────────────────┘
   │
   ▼  one step.run() per block
┌──────────────────────────┐
│ openworkflow worker      │   step_attempts persistence
└──────────────────────────┘
```

## §5 Package map

| Package | Purpose | License |
|---|---|---|
| `@thodare/openworkflow` | Vendored fork of openworkflow. Durable substrate. | Apache-2.0 |
| `@thodare/engine` | DSL, EditOp model, runtime walker, withTracing, createWebhookRouter | MIT |
| `@thodare/api` | Hono HTTP control plane; better-auth + organizations + apiKey | MIT |
| `@thodare/cli` | login / token / env / whoami / logout / key {create,list,revoke} | MIT |
| `@thodare/docs` | Astro + Starlight, Diataxis-discipline (this site builds from `apps/docs/`) | MIT |

Examples:
- `@thodare-examples/hello-connector` — minimal in-memory engine demo

## §6 What v0 already shipped

- ✅ DSL + EditOp engine + runtime walker
- ✅ HTTP API: workflows CRUD, runs, schedules, webhooks, connectors
- ✅ Auth: better-auth + organizations + apiKey + bearer
- ✅ Auto-org on signup
- ✅ Persistent schedule claim
- ✅ First-run admin bootstrap
- ✅ CLI (login + token + env + whoami + logout + key {create,list,revoke})
- ✅ Vendored openworkflow as `@thodare/openworkflow`
- ✅ Workspace `@tsconfig/strictest`
- ✅ pnpm monorepo + Changesets
- ✅ 31-page Diataxis docs site, deployed to GH Pages
- ✅ Examples workspace
- ✅ 209 tests across the workspace

## §7 What v0 deferred to v1+

The next session can pick any of these — they're scoped, contained,
and don't disturb T1–T19. See [`.internal/next-up.md`](./.internal/next-up.md)
for the prioritized queue.

- `thodare workflow` CLI commands (`list / get / run / logs`)
- Production scheduler (separate process, no `/api/admin/tick`)
- Org deletion hooks (cascade or refuse with non-empty)
- Cloudflare Workers backend (durable objects → step persistence)
- Connector marketplace primitives
- Streaming run logs (SSE on `/api/runs/:runId/stream`)
- Built-in OTel exporters (`@thodare/telemetry-otlp` etc.)
- Helm chart + Terraform modules

## §8 Hard rules (do not break)

1. **Don't break `hidden()`.** The LLM cannot see hidden params.
   Tests verify this. Adding a debug route that exposes them
   defeats the security model.
2. **Don't break tenant scoping.** Every store query includes
   `organization_id = $`. Adding a route that skips this is a
   tenancy bypass.
3. **Don't break the patch loop.** Every bad op must produce a
   structured skip with `reason_code`. Returning 400 on first error
   defeats the LLM-feedable contract.
4. **Don't fork upstream openworkflow.** We vendor; we don't fork.
   Patches are documented in `packages/openworkflow/UPSTREAM.md`.
5. **Don't add `as any` or `@ts-ignore`.** If you find yourself
   reaching for them, the type or the call site is wrong — fix
   that.
6. **Don't push to `main` directly.** PRs only. Even single-line
   typo fixes.

## §9 Naming, license, governance

- **Name origin.** Thodare ([toh-DA-REE]) carries the Tamil **தொடர்**
  (*thodar*) — chain, sequence, continuity. A workflow IS a thodar.
  See `apps/docs/src/content/docs/explanation/naming.md`.
- **License.** MIT for the workspace; Apache-2.0 for vendored
  components. See `LICENSE` and `NOTICE`.
- **Trademark.** Cleared on USPTO + searched against npm / GitHub / DNS
  before adoption. The 2016 Tamil film *Thodari* (one letter
  different) is in Nice class 41 (entertainment); we're class 9/42
  (software/SaaS). Different markets; no conflict.
- **Org.** GitHub org `asyncdotengineering`; npm scope `@thodare/*`.

## §10 Reference list

- [`README.md`](./README.md) — public face
- [`apps/docs/`](./apps/docs/) — full documentation (Diataxis)
- [`publishing-doc.md`](./publishing-doc.md) — release runbook
- [`NOTICE`](./NOTICE) — vendored-component attributions
- [`packages/openworkflow/UPSTREAM.md`](./packages/openworkflow/UPSTREAM.md) — fork relationship
- [`rfcs/`](./rfcs/) — design decisions per feature
- [`.internal/HANDOFF.md`](./.internal/HANDOFF.md) — read me before writing code
- [`.internal/decisions.md`](./.internal/decisions.md) — decisions postdating SPEC
- [`.internal/next-up.md`](./.internal/next-up.md) — prioritized work queue
