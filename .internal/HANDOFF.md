# HANDOFF — read me before you write code

> **Audience:** the next Claude Code (or human) session that opens this repo.
> **Purpose:** ship the next feature without re-deriving everything we already decided.
> **Last update:** 2026-05-04 (after v1 Phases 1–4 + 4.x + 4.x.1 — full CF adapter incl. runtime walker, DO+WS streams, real-engine e2e, upstream-verification audit and fix-up; all merged to `dev`).

If you read nothing else, read this file plus [`../AGENTS.md`](../AGENTS.md), [`../SPEC.md`](../SPEC.md), and [`../research/backend-abstraction-proposal.md`](../research/backend-abstraction-proposal.md). The proposal is what v1 ships.

---

## 0. The 60-second mental model

**Thodare** is an HTTP control plane that exposes a typed, durable
workflow engine to LLM orchestrators, agents, and UIs. It's the bridge
between *"the LLM produced a workflow JSON"* and *"that workflow ran
to completion across deploys, with full audit history."*

Three load-bearing claims (per [SPEC §2](../SPEC.md#2-the-bets)):

1. **Skip-don't-reject** is the right primitive for AI-driven workflow
   construction. Bad ops produce typed, feedable skip reasons.
2. **Durability is the substrate, not a feature.** We sit on
   openworkflow; we don't bolt step-caching on top.
3. **Multi-tenant isolation must be structural.** Every store query
   includes `organization_id = $`. Cross-org reads return 404, not 403.

The **load-bearing decision document** is [`../SPEC.md`](../SPEC.md)
(constitution; T1–T19 are immutable for v0). Read §2 (the bets) and §3
(the locked decisions) first.

---

## 1. Artifact map — where everything lives

| Thing | Where |
|---|---|
| **GitHub repo** | https://github.com/asyncdotengineering/thodare |
| **Live docs** | https://asyncdot.com/thodare-docs/ (redirect to https://asyncdotengineering.github.io/thodare/) |
| **Marketing redirects** | https://asyncdot.com/thodare → repo · https://asyncdot.com/thodare-docs → docs (Vercel `vercel.json` of the `asyncdot-marketing` project) |
| **npm packages** | https://www.npmjs.com/search?q=%40thodare — 4 published at `0.1.x` (`engine`, `api@0.1.1`, `cli`, `openworkflow`) |
| **Local Postgres for tests** | `postgres://localhost:5432/wfkit_durable_test` — `createdb wfkit_durable_test`. Per-test schemas, dropped on teardown. |
| **Spec / source of truth (v0)** | [`../SPEC.md`](../SPEC.md) — the v0 spec (T1–T19). Treat as immutable for v0; preserved verbatim through v1. |
| **v1 design — Backend abstraction proposal** | [`../research/backend-abstraction-proposal.md`](../research/backend-abstraction-proposal.md) — ~13k words. The v1 release. Interface signatures, capability flags, 6 phases with LoC estimates. **This is what v1 ships.** |
| **v1 DX walkthrough — 5 personas** | [`../research/developer-blueprint.md`](../research/developer-blueprint.md) — what the v1 surface looks like in practice. |
| **v1 use cases — 4 product shapes** | [`../usecases/`](../usecases/) — notification, sales-funnel, marketing-automation, dag-workflow-builder. Each with founder POV + end-user POV + deployment recommendation. |
| **Code-review evidence base (10 deep reviews)** | [`../research/code-reviews/`](../research/code-reviews/) — WDK, Cloudflare dynamic-workflows, workflow-examples, workflow-builder-template, Flue, Rivet, visual-builder substrates (n8n / ActivePieces / Sim Studio), Encore.ts, iii.dev, Kapso. Source-cited; cited from the proposal for every architectural claim. |
| **Release discipline (Alpha → GA)** | [`../RELEASE.md`](../RELEASE.md) — promotion ladder, pre-merge gates, versioning policy. Solo-dogfood-no-customers right-sized. |
| **Repo guidance for AI agents** | [`../AGENTS.md`](../AGENTS.md) — vendor-neutral; Claude Code reads this via `CLAUDE.md → @AGENTS.md`. |
| **Publishing runbook** | [`../publishing-doc.md`](../publishing-doc.md) — read before any release |
| **Image asset** | `apps/docs/public/thodare-mascot.png` + `apps/docs/src/assets/thodare-mascot.png`. Generated via fal.ai (Flux Schnell) in [Phase F](../rfcs/). |
| **Marketing repo** | `/Users/mithushancj/Documents/asyncdot/marketing/asyncdot-ai-native-website` — has the `/thodare` + `/thodare-docs` redirects in `vercel.json` |
| **Research history** | `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare-research/` — pre-Thodare research artifacts (FINDINGS.md, dsl-comparison spike, interpreter spike, wfkit research). NOT in this repo. |

---

## 2. Current state at a glance

| | |
|---|---|
| Version (shipped to npm) | `@thodare/api@0.1.1`, others `@0.1.0` (alpha) — unchanged on npm; **v1 alpha packages are committed but NOT YET PUBLISHED** |
| **Branch state** | `dev` is ahead of `main` by **10 squash-merged PRs** (Phases 1–4.x.1). `main` still at `5970bd5`. `dev → main` happens at v1.0 GA, not per-phase. |
| **Version (next)** | **`1.0.0-alpha.N` → `1.0.0`** per `../RELEASE.md`. Backend abstraction is the v1 release. |
| Packages published to npm | 4 still: `@thodare/engine`, `@thodare/api`, `@thodare/cli`, `@thodare/openworkflow`. The v1 alpha packages (`@thodare/backend`, `@thodare/backend-contract-tests`, `@thodare/backend-openworkflow-pg`, `@thodare/backend-openworkflow-sqlite`, `@thodare/backend-openworkflow-shared`, `@thodare/backend-cloudflare-dynamic`) live in `dev` but have not been published. |
| Build | `pnpm -r run build` → all green |
| **Tests** | `pnpm -r --filter '!@thodare/docs' --workspace-concurrency=1 run test` → **370 across all packages** (was 209 before v1). 122 engine + 63 api + 36 cli + 22 contract-tests + 41 PG + 40 SQLite + 46 CF-dynamic. Each adapter exercises the `@thodare/backend-contract-tests` parameterized suite + adapter-specific tests. |
| Docs site | 31 pages, Diataxis quadrants, deployed to GH Pages — unchanged this session |
| Repo stars | 1 (octalpixel) |
| Open issues / PRs | 0 — every PR squash-merged into `dev` |

### v1 work — what shipped on `dev` this session and the prior v1 work

`research/backend-abstraction-proposal.md` (~13k words) is **the v1 release**. As of 2026-05-04 the implementation status is:

- **Phase 1 (PR #1, merged)** — `packages/backend/` + `packages/backend-contract-tests/`. ✅ Shipped to `dev`.
- **Phase 2 (PR #3, merged)** — Credentials primitive (`packages/engine/src/credentials/` + AES-256-GCM at rest). ✅ Shipped.
- **Phase 3 (PR #5, merged)** — `packages/backend-openworkflow-pg/` + `packages/backend-openworkflow-sqlite/`. First two concrete `ThodareBackend` adapters. ✅ Shipped.
- **Phase 3.5 (PR #6, merged)** — T6 minimization: dropped Phase 3's vendor patch; types now derived from `@thodare/openworkflow` public surface via `Parameters<...>` / `ReturnType<...>`. Zero source-file delta to vendored openworkflow. ✅ Shipped.
- **Phase 3.6 (PR #7, merged)** — PG/SQLite dedup: extracted `packages/backend-openworkflow-shared/` (CAPABILITIES, StepImpl, helpers, derived types) + SleepSignal correctness fix in bridge function. ✅ Shipped.
- **Phase 4 (PR #8, merged)** — `packages/backend-cloudflare-dynamic/` first version. CF adapter wraps `@cloudflare/dynamic-workflows@^0.1.1`. D1 storage layer + dispatcher factory + capability-honest declarations. **Stubbed runtime walker** (loader threw `not_implemented` after fetching workflow JSON). 19 tests. ✅ Shipped.
- **Phase 4.x (PR #9, merged)** — Runtime walker (reuses `@thodare/engine`'s `walkWorkflow` via a CF-step shim, ~260 LoC) + `LogSession` Durable Object with WebSocket fan-out + DO storage persistence. Capability flips: `supportsLiveSubscription: true`, `supportsStepIOInspection: true`, `liveSubscriptionLatencyMs: 200`. Bumped `@cloudflare/vitest-pool-workers` 0.8 → 0.12.21 (workerd 1.20260310.1) for `cloudflare:workers.exports` support. 29 tests. ✅ Shipped.
- **Phase 4.x.1 (PR #10, merged)** — Upstream-verification fix-up. Real-engine end-to-end test (CF Workflows engine actually dispatches in vitest-pool-workers). `setWorkflowDefinition()` method with null-definition contract (defineWorkflow registers; setWorkflowDefinition attaches the SerializedWorkflow JSON). `runId` required field (no more silent UUID fallback). `INSERT OR IGNORE` for idempotent defineWorkflow. 46 tests. ✅ Shipped.

### What's left for v1.0

- **Phase 5 (~4w; AWS skipped)** — `@thodare/backend-vercel` (~250 LoC) + `examples/headless-ui-demo/` + `examples/deploy-cloudflare/`. (AWS adapter explicitly **out of scope** for v1.0 per user direction.)
- **Phase 5+ follow-ups for the CF adapter** — real CF Workflows deploy validation (`wrangler dev`); hibernating WebSocket API for `LogSession`; explicit `organization_id` on DO chunks if a stricter security model is required; harness de-vacuing + `start()` lifecycle formalization (queued from PR #7 ledger).
- **Phase 5b (~3w, parallelizable)** — Six v1 design closures: container blocks (§3.10), `hiddenFromDisplay` + `paramVisibility: 'llm-only'` (§3.11), dynamic schema endpoint (§3.12), timezone-aware waits (§3.13), diff→ops endpoint (§3.14), `@thodare/router` (§4.8). Plus 5 first-party connector packages (`@thodare/connector-{slack,resend,github,stripe,google-sheets}`) ActivePieces-style.
- **Phase 6 (post-1.0)** — Deprecate legacy `createWfkit({ backend: BackendPostgres })`. Migration codemod.

**Marketplace primitive (per-org installed registry + sandboxed custom-connector execution) is HELD to v1.1+** per `next-up.md`. v1 ships first-party connectors as plain npm packages.

### Branch ledger (as of 2026-05-04)

`dev` HEAD: `d1a6726`. `main` HEAD: `5970bd5`.

```
d1a6726 Phase 4.x.1: definition-shape + runId + workflows registration (#10)
7fb1562 Phase 4.x: runtime walker + DO+WS live subscription (#9)
d5dfd9a Phase 4: backend-cloudflare-dynamic — CF Workflows GA adapter (#8)
3385439 PG/SQLite dedup + SleepSignal correctness (#7)
1e7d26d T6 minimization (#6)
83c448f Phase 3: openworkflow adapter (PG + SQLite) (#5)
7219cdf T3 contract-vs-code drift (#4)
4b1167e Phase 2: Credentials primitive (#3)
ed57d0c SPEC §3 T1: EditOp doc-drift (#2)
9df330f Phase 1: backend abstraction (#1)
5970bd5 (main) HANDOFF.md — v1 design phase complete; openworkflow stays default
```

### What v0 already shipped

Per [SPEC §6](../SPEC.md#6-what-v0-already-shipped):

- ✅ DSL + EditOp engine + runtime walker (T1, T2, T3, T5)
- ✅ HTTP API: workflows CRUD, runs, schedules, webhooks, connectors
- ✅ Auth: better-auth + organizations + apiKey + bearer (T7, T8, T9, T10)
- ✅ Auto-org on signup (T8)
- ✅ Persistent schedule claim (T12)
- ✅ First-run admin bootstrap (T13)
- ✅ CLI (`thodare login / token / env / whoami / logout / key {create,list,revoke}`)
- ✅ Vendored openworkflow as `@thodare/openworkflow` (T6)
- ✅ Workspace `@tsconfig/strictest` (T16, T17)
- ✅ pnpm monorepo + Changesets (T15)
- ✅ 31-page Diataxis docs site (T18)
- ✅ Examples workspace
- ✅ Pin-at-run-start for in-flight runs (T4)
- ✅ Soft delete on workflows (T14)

### What v0 deferred to v1+

Per [SPEC §7](../SPEC.md#7-what-v0-deferred-to-v1) and
[`next-up.md`](./next-up.md):

- `thodare workflow` CLI commands
- Production scheduler (separate process)
- Org deletion hooks
- Cloudflare Workers backend
- Connector marketplace primitives
- Streaming run logs (SSE)
- Built-in OTel exporters
- Helm chart + Terraform modules

---

## 3. How to develop locally

```sh
# 1. Clone
git clone https://github.com/asyncdotengineering/thodare
cd thodare

# 2. Install (pnpm 10, Node 22+)
pnpm install

# 3. Build
pnpm -r run build                          # all packages

# 4. Test (needs Postgres reachable)
createdb wfkit_durable_test 2>/dev/null
pnpm test                                  # 209 across the workspace

# 5. Live docs while editing
pnpm --filter @thodare/docs dev            # http://localhost:4321
```

**You will need:** Postgres 14+ (we don't use any 15+ features today).
On macOS, [Postgres.app](https://postgresapp.com/) is the path of least
resistance. Override the connection with `WFKIT_DURABLE_PG_URL` if your
local Postgres is elsewhere.

---

## 4. The non-negotiable invariants (do not break these)

These are derived from `SPEC.md` but worth restating because they're
the soul of the project:

### Skip-don't-reject (T2)

`POST /api/workflows/:id/operations` never rejects a batch on first
bad op. The whole batch applies what it can; bad ops come back as
structured `skipped_items[]` with `reason_code` + `reason`. Tests in
`packages/api/tests/02.patch-endpoint.test.ts` lock this in. **If you
change the patch route, do not change this contract.**

### Hidden params (T3)

Hidden params NEVER appear in `GET /api/connectors`. The LLM cannot
reference them in op `params`; if it tries, the field is stripped from
the resulting block before it lands in the workflow JSON and a
structured `validation_errors[]` entry surfaces the rejection. The
block itself still applies (T2 partial-validity spirit). The defense
is structural in `packages/engine/src/define/visibility.ts` and
`packages/engine/src/operations/apply.ts`. **If you find yourself
exposing a connector's full Zod schema somewhere user-facing, stop.**

### Pin-at-run-start (T4)

`runtimeHost.dispatch()` packs the workflow JSON into the run input.
The runtime workflow walks THAT JSON, not whatever's currently in the
DB. **If you find yourself re-reading the workflow row inside the
runtime walker, stop — you'll break replay determinism.**

### One generic runtime workflow (T5)

There is exactly ONE openworkflow workflow registered:
`wfkit-runtime`. Every Thodare run is an instance of it with a
different `workflow` input. **If you're tempted to register a second
workflow per Thodare workflow, stop — openworkflow's registry is
closed at `worker.start()` and you'll deadlock the dynamic case.**

### Tenant scoping (T11)

Every store method takes `organizationId`. Every Hono handler reads
`c.get("organizationId")` and passes it. **New tables MUST add
`organization_id`.** New routes MUST be inside the auth-guarded
section. Cross-org reads return 404, not 403 — we don't reveal
existence.

### Persistent schedule claim (T12)

`ScheduleStore.tryClaim(scheduleId, cutoffIso)` uses
`SELECT … FOR UPDATE` inside a transaction + `UPDATE last_fired_at`.
Two parallel ticks on the same `(scheduleId, cutoff)` see exactly one
`true`. The 50-racer test in
`packages/api/tests/08.schedule-claim.test.ts` proves this. **Do not
add an in-memory short-circuit "for performance" — it breaks
multi-pod safety.**

### Vendor discipline (T6)

`packages/openworkflow/` is a verbatim fork of upstream. Source files
match upstream byte-for-byte (50/50 verified). **Don't patch
upstream source unless you're syncing OR fixing a real bug.** Any
divergence MUST go in `packages/openworkflow/UPSTREAM.md` with a
commit link.

### Strict tsconfig (T16, T17)

Workspace-wide `@tsconfig/strictest + @tsconfig/node22`. **No
`as any`. No `@ts-ignore`. No type widening (`field?: T | undefined`)
to defeat `exactOptionalPropertyTypes`.** When TS surfaces an error,
fix at the source — conditional spreads at construction sites,
narrower return types where a helper guarantees a field. The
discipline is the feature; see [`rfcs/strict-tsconfig/`](../rfcs/strict-tsconfig/)
for examples of every fix pattern.

---

## 5. Tribal knowledge (gotchas you'll learn the hard way)

### `npm publish` substitutes `workspace:*` correctly under pnpm

But ONLY if you use `pnpm publish` (not `npm publish`). Always publish
via `pnpm publish --filter @thodare/<pkg> --no-git-checks --access public`.
See [`../publishing-doc.md`](../publishing-doc.md) before any release.

### better-auth's `databaseHooks.user.create.after` cannot call `auth.api.createOrganization`

The auth instance isn't fully constructed during plugin init, and even
if you defer it via a closure, `createOrganization` needs a session
for the calling user — which doesn't exist mid-signup. The fix is
direct SQL inserts via the Pool: `INSERT INTO organization` +
`INSERT INTO member`. See `packages/api/src/auth.ts:autoCreatePersonalOrg`.

### `/api/auth/api-key/*` admin routes need a real session, not an API key

An API key cannot mint other API keys via better-auth's api-key/*
routes. `INVALID_REFERENCE_ID_FROM_API_KEY` is the symptom. The CLI
saves the session cookie alongside the API key in `~/.thodare/credentials.json`
precisely for this — `key create / list / revoke` use the cookie.

### `Origin` header on every `/api/auth/*` request

better-auth's CSRF gate. Browsers send `Origin` automatically;
scripted clients (CLI, tests) MUST add it explicitly. The CLI's
`bootstrapTenant` helper sets it on every request.

### `noUncheckedIndexedAccess` + regex match groups

`auth.match(/^Bearer\s+(.+)$/i)` returns `RegExpMatchArray | null`.
Under `noUncheckedIndexedAccess`, `m[1]` is `string | undefined` even
on a successful match. Pattern: `const candidate = m?.[1]; if (candidate !== undefined && candidate.startsWith(...))`.

### Vendored openworkflow has its own tsconfig presets

Upstream openworkflow uses `@tsconfig/strictest + @tsconfig/node22`
extends. The vendored copy must too — that's why the workspace-root
`tsconfig.base.json` mirrors upstream's exactly. Source files compile
unchanged because they were written under the same strictness.

### Astro 6 + Starlight 0.38 content config moved

`src/content/config.ts` → `src/content.config.ts`. Loader is now
explicit: `loader: docsLoader()` from `@astrojs/starlight/loaders`.
`@astrojs/sitemap` 3.7.x had a regression we worked around with a pin
override in 0.30; that's gone now (delete it from the root
`package.json` if you see it).

### Test concurrency + per-test schemas

The test harness creates a fresh Postgres schema per test
(`cpa_<random>`). Tests run in a single worker (`fileParallelism: false`)
because better-auth migrations under `getMigrations(...).runMigrations()`
are not concurrency-safe within one Pool. Don't enable parallel
test files for `packages/api`.

### Image generator hardcoded key

The `image-generator` skill has a hardcoded fal.ai fallback at
`~/.claude/skills/image-generator/scripts/generate.py:208`. The
mascot was generated this way. Don't rely on it for production work
— set `FAL_KEY` properly.

---

## 6. Reading order for a new contributor

1. **`README.md`** — the public face; understand the pitch.
2. **`SPEC.md`** — the 19 locked decisions; this is the constitution.
3. **`apps/docs/src/content/docs/explanation/patch-loop.md`** — the
   load-bearing primitive.
4. **`apps/docs/src/content/docs/explanation/runtime-workflow.md`** —
   the registry-frozen workaround.
5. **`apps/docs/src/content/docs/explanation/pin-at-run-start.md`** —
   the determinism story.
6. **`packages/api/src/server.ts`** — the wiring.
7. **`packages/engine/src/operations/apply.ts`** — the EditOp engine.
8. **`packages/engine/src/runner/runtime-workflow.ts`** + `walk.ts` —
   the dynamic execution path.
9. **`packages/api/tests/02.patch-endpoint.test.ts`** + `_harness.ts` — the LLM patch loop end-to-end with full auth.
10. **`publishing-doc.md`** — when ready to ship.

---

## 7. How to add a new feature without breaking anything

1. **Read the relevant SPEC section.** If it's deferred to v1+, the
   SPEC tells you the contract; honor it.
2. **Open an RFC under `rfcs/<slug>/README.md`** for anything bigger
   than a bug fix. Format is in existing RFCs (alpha-polish, cli,
   strict-tsconfig).
3. **Add a package or a file under an existing one.** Don't refactor
   `@thodare/openworkflow` unless syncing from upstream.
4. **Tests first.** Most chunks add 4–10 tests. Use the existing
   harnesses (`packages/api/tests/_harness.ts`,
   `packages/engine/tests/_durable-harness.ts`).
5. **Run the strict probe.** `tsc --noEmit -p packages/<your-pkg>/tsconfig.json`
   should be clean. If it isn't, fix at the source — no `as any`.
6. **Add a `.changeset/<name>.md`** describing the change at the
   right semver level.
7. **Update docs.** New page under `apps/docs/src/content/docs/`
   in the right Diataxis quadrant — or update an existing page.
8. **Run the full check:**
   ```sh
   pnpm install && pnpm -r run build && pnpm test
   ```
9. **Commit + push.** PR-only; no direct push to main.
10. **Publish.** See [`../publishing-doc.md`](../publishing-doc.md).

---

## 8. What I would do next if I were continuing

**Phases 1 → 4.x.1 are done and merged to `dev`.** All concrete work shipped: backend abstraction (types + contract suite), credentials primitive, openworkflow adapters (PG + SQLite + shared), Cloudflare Workflows adapter (full runtime walker + DO+WS live streaming + real-engine e2e). `main` is still at `5970bd5`.

**Next is Phase 5 (minus AWS).** AWS is explicitly out of scope per user direction. So the work is:

### Phase 5a — `@thodare/backend-vercel` (~250 LoC, ~1w)

Per `research/backend-abstraction-proposal.md` §4.4. Composes Vercel's own primitives directly (NOT WDK-wrapped):

| Thodare needs | Vercel primitive |
|---|---|
| Storage + materialized views | Vercel Postgres (managed Neon) |
| Credential vault | Vercel Postgres (`workflow.credentials`) |
| Queue (`__wkf_workflow_*` / `__wkf_step_*`) | Vercel Queues (beta — verify) OR Vercel Cron + poll worker fallback |
| Step execution | Vercel Functions (Lambda-style) |
| Cron / scheduled triggers | Vercel Cron |
| Live run subscription | Vercel Functions returning streaming `Response` |
| Large step output spillover | Vercel Blob |

Capability flags (proposal §4.4): `serverless: true`, `maxStepDurationMs: 300_000` (Pro), `signalPrecision: "exact"`, `pricingModel: "per-invocation"`, `supportsLiveSubscription: true`, `supportsResumeFromStep: true`.

Build target: `thodare build --target=vercel` produces a Build Output API v3 layout + a `vercel.json` (merged into the user's `vercel.json` if present per Flue's `cloudflare-wrangler-merge.ts:563-580` pattern, generalized). User runs `vercel --prod` themselves.

### Phase 5b — `examples/deploy-cloudflare/` + `examples/headless-ui-demo/`

`examples/deploy-cloudflare/` — full Wrangler deploy story for the CF adapter (now that runtime walker + streams ship); validates the README's quick-start against a real CF deployment.

`examples/headless-ui-demo/` — demonstrates Thodare-as-headless-backend: visual builder consumes the typed control plane.

### Phase 5+ follow-ups for the CF adapter (queued from Phases 4–4.x.1)

These are non-blocking but tracked:

1. **Real CF Workflows deploy validation** (`wrangler dev`). The vitest-pool-workers can dispatch the FIRST `create()` reliably; a second in the same test run may stay `running` — consistent with the upstream library's own test gap.
2. **Hibernating WebSocket API** for `LogSession` — current pattern uses `WebSocketPair` + `ws.accept()`, which limits scale.
3. **Explicit `organization_id` column on DO chunks** — current model relies on `runId` UUID unguessability for cross-org isolation. Acceptable for alpha.
4. **CF control-flow exception assumption** — `cf-step-shim`'s `try/catch` assumes CF's `step.do()` doesn't surface engine-internal sleep/wait parking exceptions. Mock-tested only; verify against real CF deploy.
5. **Harness de-vacuing + `start()`/`restart()` formalization** (queued from PR #7 ledger). Apply to CF adapter once Phase 5 is done.

### Phase 5c — six v1 design closures (~3w, parallelizable)

Per proposal §3.10–§3.14 + §4.8:

- Container blocks (§3.10)
- Output `hiddenFromDisplay` + `paramVisibility: 'llm-only'` (§3.11)
- Dynamic schema endpoint (§3.12)
- Timezone-aware waits (§3.13)
- diff→ops endpoint (§3.14)
- `@thodare/router` companion package (§4.8)

Plus 5 first-party connector packages: `@thodare/connector-{slack,resend,github,stripe,google-sheets}` shipping ActivePieces-style.

### Phase 5d — `dev` → `main` for v1.0 GA

When all five adapters are in (`@thodare/backend-self-host-postgres` is shipped via `backend-openworkflow-pg`; `self-host-sqlite` via `backend-openworkflow-sqlite`; `cloudflare` via `backend-cloudflare-dynamic`; `vercel` is Phase 5a; AWS skipped) and Phase 5c closures land:

1. `pnpm changeset version` to compute the v1.0 release.
2. PR `dev` → `main`.
3. `pnpm release` to publish all v1 alpha packages off the `latest` dist-tag for the first time.

### What's deliberately NOT next

- AWS adapter — explicitly out of scope for v1.0.
- Marketplace primitive — held to v1.1+ per `next-up.md`.
- Any feature flag gating — explicitly rejected in `RELEASE.md`. Capability flags (interface declarations) ARE the answer; runtime feature flags ARE NOT.

**Trust the proposal**; don't redesign. If you find yourself contradicting `research/backend-abstraction-proposal.md` §3 or §4, stop and re-read it before writing code.

### Workflow / process notes (carry forward from Phases 4–4.x.1)

The session that closed Phases 4–4.x.1 used `/ship-it-managed` discipline:

1. **Decompose** into worker-sized chunks with explicit acceptance criteria.
2. **Delegate** to pi (default `opencode-go/deepseek-v4-pro`, 1M context) async on a feature branch.
3. **Adversarial review** with codex (`gpt-5.3-codex`, read-only sandbox) + pi-glm (`opencode-go/glm-5.1`) **in parallel** — read the actual diff, not the worker's summary.
4. **Take ownership** — fix small deviations directly; re-delegate only structural ones. Multiple reviewers diverging on the same finding means the brief was thin; tighten and re-fire.
5. **Verify** — package tests + workspace baseline + `tsc --noEmit` + no `as any`/`@ts-ignore` + T6/T11/T17 honored.
6. **PR** against `dev`; squash-merge after green; delete branch.

Brief format lives in `.handoff/brief-*.md`. Results in `.handoff/result-*.txt` (gitignored). The IC contract (`/ship-it`) is auto-prepended to every worker brief by `/delegate`.

When codex hits its usage limit (it did once this session at ~5:44 AM reset), substitute **claude-glm** as second cross-family reviewer — same pattern works.

Pi's CLI choked on prompts that start with `---` (frontmatter delimiter parsed as flag). Fix is prepending `# Engineering standard\n\n` to the prompt before piping. Same for `claude-glm`. Already baked into the `/delegate` skill but watch for it.

**The upstream-verification audit (`.handoff/result-cf-upstream-verification.txt`) was the load-bearing review of Phases 4–4.x.** It caught two P1s + one P2 that codex AND pi-glm both missed — they were upstream-API-correctness issues that only surface when you read `cloudflare/dynamic-workflows@0.1.1` source directly and compare. **Repeat this pattern for `@thodare/backend-vercel`**: after the adapter lands, fire a pi worker to compare against Vercel's actual primitive APIs (Postgres SDK, Cron, Queues, Functions). Don't trust two reviewers on the same internal lens.

---

## 9. What NOT to do

### Inherited from v0 (still load-bearing)

- Don't break the patch-loop contract (T2). 400 on first bad op defeats the LLM-feedable surface.
- Don't break `hidden()` (T3). Exposing a "debug" route that shows hidden params is a security regression.
- Don't break tenant scoping (T11). New routes go through the auth guard; new tables carry `organization_id`.
- Don't fork upstream openworkflow. Vendor is the contract; patches go in `UPSTREAM.md` with commits.
- Don't add `as any` or `@ts-ignore`. The strictness is a feature.
- Don't push to `main`. PR-only.
- Don't publish without reading [`../publishing-doc.md`](../publishing-doc.md).
- Don't add a no-code dashboard. Build it on top; we ship the surface a UI builds on.

### New for v1 (per the proposal + RELEASE.md)

- **Don't add per-feature env-var gates** like `THODARE_FEATURES_X=enabled`. `RELEASE.md` explicitly rejects feature-flag gating discipline. Capability flags (`BackendCapabilities` per proposal §3) ARE NOT feature flags — they're interface declarations the adapter exposes. Don't conflate.
- **Don't reintroduce v0.X versioning labels** (`v0.2 / v0.3+` in the proposal). The corrected versioning is `1.0.0-alpha.N → 1.0.0 → 1.x.y → 2.0.0`. The earlier draft labels are obsolete.
- **Don't ship the marketplace primitive in v1.0.** It's deferred to v1.1+ per `next-up.md`. v1 ships first-party connectors as plain `@thodare/connector-*` npm packages (ActivePieces-style), without per-org installed registries or sandboxed execution.
- **Don't write a separate RFC for v1.** The proposal at `research/backend-abstraction-proposal.md` IS the RFC. Solo + dogfood + no contributors means a parallel RFC is paperwork without leverage. When the project picks up a second contributor, that's the moment to layer in the RFC ceremony.
- **Don't touch the vendored `@thodare/openworkflow` package** beyond syncing from upstream. It stays. The new `@thodare/backend-openworkflow-pg` + `@thodare/backend-openworkflow-sqlite` adapters WRAP it — they don't replace it.
- **Don't break wire-format canonicality** (proposal §3.10). Every API response, every workflow JSON, every EditOp batch result must be sorted-keys + minimal-escape JSON.
- **Don't bypass the `@thodare/backend-contract-tests` suite.** Every adapter PR must pass; new features add new test packs. The suite is the cross-adapter parity gate.

---

## 10. Environment cheat sheet

```sh
# Required for tests
export WFKIT_DURABLE_PG_URL="postgres://localhost:5432/wfkit_durable_test"

# Required for the API server
export DATABASE_URL="postgres://localhost:5432/thodare"
export AUTH_SECRET="<random ≥32 chars>"

# Optional — for the first-run admin bootstrap
export THODARE_BOOTSTRAP=1     # only on a fresh empty DB; unset after use

# Optional — for the CLI
export THODARE_API="https://api.your-thodare.example"
export THODARE_API_KEY="thd_…"
export THODARE_CREDENTIALS="$HOME/.thodare/credentials.json"   # default

# Optional — for the image-generator skill (legacy from setup)
export FAL_KEY="<fal.ai API key>"
```

---

## 11. People + accounts

- **GitHub org:** [`asyncdotengineering`](https://github.com/asyncdotengineering) (`octalpixel` is admin).
- **npm scope:** `@thodare` — `octalpixel` has publish access.
- **Docs hosting:** GitHub Pages on `asyncdotengineering.github.io/thodare/`.
- **Marketing redirects:** Vercel `octalpixels-projects/asyncdot-marketing`.
- **Maintainer council:** TBD. As of 0.1.1 the founding council is
  unannounced; this is fine for alpha.

---

## 12. Closing note

The framework is alpha. APIs may change. The load-bearing primitives
(skip-don't-reject, hidden params, pin-at-run-start, one runtime
workflow, tenant scoping, persistent schedule claim) are **not**
alpha — they are the bet. Every other surface can move; those
should not.

When in doubt, re-read [`../SPEC.md`](../SPEC.md) §3 (T1–T19) AND [`../research/backend-abstraction-proposal.md`](../research/backend-abstraction-proposal.md) §3 + §4. If you're about to make a decision that contradicts either, **stop and ask first** (the proposal IS the RFC; SPEC.md is the v0 constitution).

— last session, 2026-05-04 (Phases 1–4.x.1 merged to `dev`; CF adapter functionally complete with real-engine e2e test; Phase 5 / `@thodare/backend-vercel` is next).

---

## 13. Session 2026-05-04 — kickoff for next Claude

### Pick up here

You are inheriting a `dev` branch with **10 squash-merged PRs** completing v1 Phases 1–4.x.1. `main` is untouched at `5970bd5`. The CF adapter is **functionally complete** — `runWorkflow` actually executes end-to-end on real CF Workflows engine (verified via `tests/real-engine-e2e.test.ts` in workerd 1.20260310.1 inside vitest-pool-workers@0.12.21).

**Your next task is Phase 5a — `@thodare/backend-vercel`** per proposal §4.4. **AWS is out of scope** for v1.0 (user direction).

### First-3-minute reading list

1. This file §2 (current state) and §8 (what's next).
2. `research/backend-abstraction-proposal.md` §4.4 (Vercel-native composition) and §4.7 (capability matrix).
3. `packages/backend-cloudflare-dynamic/` — your reference adapter shape. Note specifically:
   - `src/adapter.ts` — `BackendCloudflareDynamic implements BackendCore`.
   - `src/dispatcher.ts` — `_buildLoadRunner` factory pattern (test-internal export).
   - `src/cf-step-shim.ts` — wraps CF step into engine step.
   - `tests/real-engine-e2e.test.ts` — proves the dispatch path actually fires.
4. `packages/backend-openworkflow-pg/` — reference adapter for any Postgres-shaped backend.

### Workflow

**Use `/ship-it-managed`.** That gave Phases 4 / 4.x / 4.x.1 their quality. Pattern recap:

1. Decompose into worker-sized chunks with explicit acceptance criteria.
2. Delegate to pi async on a feature branch (`backend-vercel-phase-5a`). Brief lives in `.handoff/brief-<slug>.md`. Result goes to `.handoff/result-<slug>.txt` (gitignored).
3. While pi works, you stay free.
4. After pi delivers: dual-review with **codex + pi-glm in parallel**. Read the diff, not the summary.
5. Fix small deviations directly. Re-delegate only structural deviations.
6. **Then fire an upstream-verification audit** — same pattern as `.handoff/brief-cf-upstream-verification.md`. Have pi compare the new adapter against Vercel's actual primitive APIs (Postgres SDK, Vercel Cron, Vercel Queues, Vercel Functions, Vercel Blob). This caught the load-bearing P1s in Phase 4 that the two internal reviewers missed.
7. PR against `dev`; squash-merge after green; delete branch.

### Hard rules (carry forward)

- **No `as any` / `@ts-ignore` / `@ts-expect-error`** anywhere. T17.
- **No fallback escape hatches.** If a capability isn't supported, declare it `false` in `BackendCapabilities` and `throw notImplemented(...)`. Silent degradation is a breach of trust.
- **Capability flags are NOT feature flags.** Don't add env-var gates. Capabilities are interface declarations the frontend uses to hide unsupported affordances.
- **T6**: zero source-file delta to `packages/openworkflow/`.
- **T11**: every storage table carries `organization_id`; every query filters on it. Cross-org reads return null/404, not 403.
- **Out of scope**: don't touch `packages/openworkflow/`, `packages/backend-openworkflow-{pg,sqlite,shared}/`, `packages/backend-cloudflare-dynamic/`, `packages/api/`, `packages/cli/`, `packages/engine/` unless the work genuinely requires it (and if it does, **disclose explicitly in the PR body** like Phase 4.x did with the engine subpath-export change).

### Test posture invariant

After your PR, the workspace baseline must read:

```
pnpm -r --filter '!@thodare/docs' --workspace-concurrency=1 run test
# 22 (contract-tests) + 122 (engine) + 63 (api) + 41 (PG) + 40 (SQLite) + 46 (CF-dynamic) + 36 (cli) + N (vercel) = 370 + N
```

Don't break the 370 baseline. If you do, that's a regression in someone else's work caused by your change.

### Expect to use these tools

- `/delegate` — fires a worker async with the IC contract auto-prepended.
- `/ship-it-managed` — the meta-workflow command for the whole loop.
- `/workers` — inspect available delegation workers.
- `gh pr create / gh pr merge --squash --delete-branch` — same flow as Phases 4–4.x.1.

### Watchouts from this session

1. **Codex usage limit**: codex hit its OpenAI usage limit during one review. Fallback was claude-glm with the same brief — worked fine. If codex throws "usage limit", swap claude-glm in.
2. **Pi/claude-glm CLI parser**: prompts starting with `---` (frontmatter) get parsed as a flag and crash. Already mitigated in `/delegate` (prefixes `# Engineering standard\n\n`), but if you fire a worker manually, do the same.
3. **Pi sometimes silently scope-creeps.** Phase 4.x pi modified `packages/engine/` (subpath exports) despite "do NOT modify" in the brief. It WAS legitimate (engine's barrel pulls `node:crypto` which workerd can't run). Pi disclosed it in the report — accepted-with-disclosure. Apply the same posture: read pi's "Discovered contradictions with the brief" section every time. If pi changed something out of scope and the reason is sound, accept-with-disclosure in the PR body. If unsound, revert and re-delegate with a tighter brief.
4. **Workspace test (`pnpm -r run test`) excludes `@thodare/docs`** — astro check is interactive, hangs the test pool. Use `--filter '!@thodare/docs'` always. Already baked into the convention.
5. **Real-engine tests in workerd**: vitest-pool-workers@0.12.21 (workerd 1.20260310.1) does support CF Workflows dispatch in-pool — but only for the FIRST `create()` in a test run. A second may stay `running` indefinitely. Same gap upstream's own tests note. If you write similar tests for the Vercel adapter, anticipate the same kind of pool-vs-real-engine gap and document explicitly.
6. **Don't over-scope `defineWorkflow`'s contract**. CF adapter learned the hard way that `defineWorkflow(spec, handler)` isn't enough for a serverless adapter that can't execute the handler in-process — it needs `setWorkflowDefinition(name, version, json)` as a CF-specific extension method. Vercel will likely face the same shape: `defineWorkflow` registers; a CF/Vercel-specific method attaches the JSON. Keep the cross-cutting `WorkflowSpec` contract in `@thodare/backend` unchanged.

### Handoff files for this session (audit trail)

All in `.handoff/`:

- `brief-cf-dynamic-phase-4-x.md` + `result-cf-dynamic-phase-4-x.txt` — Phase 4.x delegation
- `brief-cf-dynamic-phase-4-x-review.md` + `result-cf-dynamic-phase-4-x-review-{piglm,claude-glm}.txt` — Phase 4.x dual review
- `brief-cf-upstream-verification.md` + `result-cf-upstream-verification.txt` — the upstream audit
- `brief-cf-dynamic-phase-4-x-1.md` + `result-cf-dynamic-phase-4-x-1.txt` — Phase 4.x.1 delegation
- `brief-cf-dynamic-phase-4-x-1-review.md` + `result-cf-dynamic-phase-4-x-1-review-{codex,piglm}.txt` — Phase 4.x.1 dual review

These are the templates to copy when writing the Phase 5 briefs. Adapt the structure (Required reading / Files in scope / Hard rules / Out of scope / Definition of done / Reporting) — the format is what gives reviews their teeth.

— session 2026-05-04 closed; CF adapter is real-engine-validated; Phase 5 / Vercel adapter is the open work.
