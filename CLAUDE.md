# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required reading before writing code

Two files are the constitution; do not redesign without re-reading them:

1. [`SPEC.md`](./SPEC.md) — v0 spec, decisions **T1–T19 are immutable for v0** (changes require an RFC under `rfcs/`).
2. [`.internal/HANDOFF.md`](./.internal/HANDOFF.md) — current state, gotchas, "what NOT to do."

Auxiliary: [`.internal/next-up.md`](./.internal/next-up.md) (work queue), [`publishing-doc.md`](./publishing-doc.md) (release runbook), [`packages/openworkflow/UPSTREAM.md`](./packages/openworkflow/UPSTREAM.md) (vendor relationship).

## Common commands

```sh
# Setup (one-time): Postgres reachable for tests
createdb wfkit_durable_test       # override URL via WFKIT_DURABLE_PG_URL

pnpm install                      # pnpm 10, Node 22+
pnpm -r run build                 # build all packages
pnpm test                         # 209 tests, single worker (do not parallelize)

# Per-package tests
pnpm test:engine                  # 117 tests
pnpm test:api                     # 56 tests
pnpm test:cli                     # 36 tests

# Run a single test file (from inside the package dir)
cd packages/api && pnpm vitest run tests/02.patch-endpoint.test.ts
cd packages/api && pnpm vitest run -t "name pattern"

# Strict TS probe for one package
tsc --noEmit -p packages/<pkg>/tsconfig.json

# Docs site
pnpm --filter @thodare/docs dev   # http://localhost:4321

# Examples
pnpm --filter @thodare/engine demo            # in-memory fluent demo
pnpm --filter @thodare/api demo               # full HTTP loop

# Release
pnpm changeset                    # add a changeset for any user-visible change
pnpm release                      # build + changeset publish (read publishing-doc.md first)
```

`pnpm test` runs with `--workspace-concurrency=1`. The api test harness runs single-worker (`fileParallelism: false`) because better-auth migrations are not concurrency-safe within one Pool — do not enable parallel test files for `packages/api`.

## Architecture — the big picture

Thodare is an HTTP control plane that exposes a typed, durable workflow engine to LLMs. The full request path:

```
HTTP → Hono app (@thodare/api) → authGuard (user, organizationId)
     → Route handler → Postgres stores (scoped by organizationId)
     → runtimeHost.dispatch() → wfkit-runtime workflow (ONE generic openworkflow workflow)
     → openworkflow worker (one step.run() per block)
```

### Three load-bearing primitives (the bets)

These are not features; they are the *substrate*. Every other surface can move.

1. **Skip-don't-reject** — `POST /api/workflows/:id/operations` never rejects a batch on first bad op. Bad ops come back as `{ skipped_items: [{ reason_code, reason }] }`, feedable directly back to the LLM as tool output. Locked in `packages/api/tests/02.patch-endpoint.test.ts`. Returning 400 on first bad op breaks the entire LLM-feedable contract.

2. **Pin-at-run-start** — `runtimeHost.dispatch()` packs the workflow JSON into the run input. The runtime walker reads from THAT JSON, never re-reads the row from the DB mid-run. Mid-run patches do not affect in-flight runs. Re-reading inside the walker breaks replay determinism.

3. **One generic runtime workflow (T5)** — openworkflow's registry is closed at `worker.start()`. Thodare registers exactly one workflow named `wfkit-runtime` with input `{ workflow, input }` that walks the JSON dynamically. This is what lets new Thodare workflows be created at runtime without redeploying the openworkflow worker. Registering a second workflow per Thodare workflow deadlocks the dynamic case.

### Multi-tenant isolation is structural (T11)

Every table has `organization_id`; every store method takes `organizationId`; every route handler reads `c.get("organizationId")`. **Cross-org reads return 404, not 403** — existence is not revealed. New tables MUST add `organization_id`; new routes MUST sit inside the auth-guarded section.

### Hidden params are a security boundary (T3)

`hidden()` params on a connector NEVER appear in `GET /api/connectors`. The LLM cannot reference them in op `params`; if it tries, the op is skipped with `hidden_param_in_input`. Defense lives in `packages/engine/src/define/visibility.ts` and `packages/engine/src/operations/apply.ts`. Do not expose a connector's full Zod schema anywhere user-facing.

### Auth model

- **better-auth** (v1.6+) with `organization` + `apiKey` plugins. No custom session store, no hand-rolled JWT.
- **Auto-org on signup** via `databaseHooks.user.create.after` doing direct SQL inserts (you cannot call `auth.api.createOrganization` here — auth isn't fully constructed and there's no session yet). See `packages/api/src/auth.ts:autoCreatePersonalOrg`.
- **API keys reference organizations, not users** (`references: "organization"`). The verified key's `referenceId` is the org id.
- **`/api/auth/api-key/*` admin routes need a real session, not an API key.** The CLI saves the session cookie alongside the API key in `~/.thodare/credentials.json` for `key {create,list,revoke}`.
- **`Origin` header** is required on every `/api/auth/*` request (better-auth's CSRF gate). Scripted clients (CLI, tests) must set it explicitly.

### Persistent schedule claim (T12)

`ScheduleStore.tryClaim(scheduleId, cutoffIso)` uses `SELECT … FOR UPDATE` inside a transaction. Two parallel ticks see exactly one `true`. Proven by the 50-racer test in `packages/api/tests/08.schedule-claim.test.ts`. Do not add an in-memory short-circuit "for performance" — it breaks multi-pod safety.

## Packages

| Package | Path | Role |
|---|---|---|
| `@thodare/openworkflow` | `packages/openworkflow/` | **Vendored** Apache-2.0 fork. Durable substrate. Source files match upstream byte-for-byte. Patches go in `UPSTREAM.md` with commit links. Do not refactor unless syncing upstream or fixing a real bug. |
| `@thodare/engine` | `packages/engine/` | DSL, EditOp model (`add`/`update`/`remove`/`connect`/`disconnect`), runtime walker, `withTracing`, `createWebhookRouter`. |
| `@thodare/api` | `packages/api/` | Hono app: workflows / runs / schedules / webhooks / connectors + better-auth. |
| `@thodare/cli` | `packages/cli/` | `thodare login / token / env / whoami / logout / key {create,list,revoke}`. |
| `@thodare/docs` | `apps/docs/` | Astro + Starlight, **Diataxis discipline** (T18): tutorial / how-to / reference / explanation, one concern per page. |
| Examples | `examples/*` | `hello-connector`, `full-llm-loop`, `llm-builder-{openai-agents,vercel-ai}`. |

## Strict TS — no escape hatches (T16, T17)

Workspace extends `@tsconfig/strictest` + `@tsconfig/node22` via `tsconfig.base.json`.

- **No `as any`. No `@ts-ignore`. No widening (`field?: T | undefined`) to defeat `exactOptionalPropertyTypes`.** Fix at the source: conditional spreads at construction sites, narrower return types where a helper guarantees a field.
- `noUncheckedIndexedAccess` gotcha: regex match groups (`m[1]`) are `string | undefined` even on a successful match. Pattern: `const candidate = m?.[1]; if (candidate !== undefined && candidate.startsWith(...))`.

The vendored openworkflow uses the same strictness presets — that's why the workspace `tsconfig.base.json` mirrors upstream exactly.

## Hard rules — do not break

1. **Don't break `hidden()` (T3).** No "debug" route that exposes hidden params.
2. **Don't break tenant scoping (T11).** Every store query filters on `organization_id`.
3. **Don't break the patch loop (T2).** Every bad op produces a structured skip — no 400-on-first-error.
4. **Don't fork upstream openworkflow (T6).** Vendor is the contract; document patches in `packages/openworkflow/UPSTREAM.md`.
5. **Don't add `as any` or `@ts-ignore` (T17).** Strictness is the feature.
6. **Don't push to `main`.** PR-only, even single-line typo fixes.
7. **Don't publish without reading [`publishing-doc.md`](./publishing-doc.md).** Use `pnpm publish` (not `npm publish`) so `workspace:*` is rewritten correctly.

## Dev workflow expectations

1. Read the relevant SPEC section. If it's deferred to v1+, the SPEC tells you the contract — honor it.
2. For anything bigger than a bug fix, open an RFC under `rfcs/<slug>/README.md` (existing RFCs are templates).
3. Tests first. Use the existing harnesses (`packages/api/tests/_harness.ts`, `packages/engine/tests/_durable-harness.ts`).
4. Add a `.changeset/<name>.md` for any user-visible change.
5. Update docs in the right Diataxis quadrant (T18).
6. Full check: `pnpm install && pnpm -r run build && pnpm test`.

## Environment cheat sheet

```sh
# Tests
WFKIT_DURABLE_PG_URL="postgres://localhost:5432/wfkit_durable_test"

# API server
DATABASE_URL="postgres://localhost:5432/thodare"
AUTH_SECRET="<random ≥32 chars>"
THODARE_BOOTSTRAP=1               # only on a fresh empty DB; unset after use

# CLI
THODARE_API="https://api.your-thodare.example"
THODARE_API_KEY="thd_…"
THODARE_CREDENTIALS="$HOME/.thodare/credentials.json"   # default
```
