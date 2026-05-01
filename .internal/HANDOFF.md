# HANDOFF — read me before you write code

> **Audience:** the next Claude Code (or human) session that opens this repo.
> **Purpose:** ship the next feature without re-deriving everything we already decided.
> **Last update:** 2026-05-02 (after Phase N — docs Diataxis restructure + apps/docs move + examples workspace).

If you read nothing else, read this file plus [`../SPEC.md`](../SPEC.md).

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
| **Spec / source of truth** | [`../SPEC.md`](../SPEC.md) — the v0 spec (T1–T19). Treat as immutable for v0; propose edits via RFC for v1+. |
| **Publishing runbook** | [`../publishing-doc.md`](../publishing-doc.md) — read before any release |
| **Image asset** | `apps/docs/public/thodare-mascot.png` + `apps/docs/src/assets/thodare-mascot.png`. Generated via fal.ai (Flux Schnell) in [Phase F](../rfcs/). |
| **Marketing repo** | `/Users/mithushancj/Documents/asyncdot/marketing/asyncdot-ai-native-website` — has the `/thodare` + `/thodare-docs` redirects in `vercel.json` |
| **Research history** | `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare-research/` — pre-Thodare research artifacts (FINDINGS.md, dsl-comparison spike, interpreter spike, wfkit research). NOT in this repo. |

---

## 2. Current state at a glance

| | |
|---|---|
| Version | `@thodare/api@0.1.1`, others `@0.1.0` (alpha) |
| Packages published | 4 (`@thodare/engine`, `@thodare/api`, `@thodare/cli`, `@thodare/openworkflow`) |
| Build | `pnpm -r run build` → all green |
| Tests | `pnpm test` → **209 across 41 test files** (117 engine + 56 api + 36 cli) |
| Docs site | 31 pages, Diataxis quadrants, deployed to GH Pages |
| Repo stars | 1 (octalpixel) |
| Open issues / PRs | 0 (alpha; no contributors yet) |

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
reference them in op `params`; if it tries, the op is skipped with
`hidden_param_in_input`. The defense is structural in
`packages/engine/src/define/visibility.ts` and
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
9. **`examples/full-llm-loop/`** — see the whole arc end-to-end.
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

If you want a fast win that demonstrates real value, ship one of
these in order of leverage:

1. **`thodare workflow {list,get,run,logs}`** (~1 day) — extend the
   CLI now that auth is rock-solid. Pure CLI work; all the API routes
   already exist. Big UX win for first-time users.
2. **`@thodare/telemetry-otel`** (~1 day) — concrete `withTracing`
   hooks that wire OTel. The engine already exposes the Proxy; this
   is just a recipe package + a doc.
3. **Production scheduler** (~2 days) — a separate process that
   ticks on a real interval, replacing `/api/admin/tick` for production.
   The `tryClaim` row-lock is already in place; just need a tiny
   `setInterval(60_000)` loop with backoff.
4. **GitHub Actions release workflow** (~1 day) — replace manual
   `pnpm publish`, use OIDC for npm provenance.
5. **Org deletion + cascade** (~2 days) — better-auth org delete
   currently leaves orphaned workflows + schedules + keys. Add a
   `databaseHooks.organization.delete.before` that refuses if
   non-empty (or, with a `--force` flag, cascades).

For each, see [`next-up.md`](./next-up.md) for the prioritized full
queue with package names, LoC estimates, and dependencies.

**Trust the SPEC**; don't redesign.

---

## 9. What NOT to do

- Don't break the patch-loop contract (T2). 400 on first bad op
  defeats the LLM-feedable surface.
- Don't break `hidden()` (T3). Exposing a "debug" route that shows
  hidden params is a security regression.
- Don't break tenant scoping (T11). New routes go through the auth
  guard; new tables carry `organization_id`.
- Don't fork upstream openworkflow. Vendor is the contract; patches
  go in `UPSTREAM.md` with commits.
- Don't add `as any` or `@ts-ignore`. The strictness is a feature.
- Don't push to `main`. PR-only.
- Don't publish without reading [`../publishing-doc.md`](../publishing-doc.md).
- Don't add a no-code dashboard. Build it on top; we ship the
  surface a UI builds on.

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

When in doubt, re-read [`../SPEC.md`](../SPEC.md) §3 (T1–T19). If
you're about to make a decision that contradicts one of them, **stop
and write an RFC instead**.

— last session, 2026-05-02
