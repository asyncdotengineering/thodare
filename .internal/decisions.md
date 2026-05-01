# Decision log

Decisions made *outside* the immutable SPEC (`SPEC.md` §3, T1–T19).
Every entry is atomic: one choice per entry, with clear separation
between the decision, its rationale, and any outstanding work.

Entries are reverse-chronological (most recent at the top).

---

## D-016 — Roll our own cron layer; openworkflow's `availableAt` is one-shot only (2026-05-02)

**Decision.** Thodare's `schedules` table + `tryClaim` (row-level
`SELECT … FOR UPDATE`) + `POST /api/admin/tick` is the cron layer.
We do **not** use openworkflow's `availableAt` option on
`runWorkflow`. Recorded so future contributors don't reinvent it.

**Why.** openworkflow's
[`availableAt`](https://openworkflow.dev/docs/workflows#scheduling-a-workflow-run)
is a *one-shot* deferred-invocation primitive — accepts an ISO date
or a duration string ("5m"), runs the workflow once when the time
arrives. It's not a cron layer. We need:

- Cron expressions (5-field, minute resolution).
- CRUD on schedule rows scoped to organizations.
- Catch-up on missed cutoffs after downtime.
- Per-(scheduleId, cutoff) idempotency across multi-process
  tickers — proven by the 50-racer test.

`availableAt` provides none of those directly. So we built our own
layer on top.

**Open question (worth evaluating, not now).** A different design
chains `availableAt` into our scheduler: each schedule fire enqueues
the NEXT cron firing via `availableAt`. The poller / tick endpoint
goes away — openworkflow's worker hibernates between firings, no
polling cost.

Trade-offs:

- ✅ Less infrastructure: no dedicated scheduler process or pg_cron.
- ✅ Cheaper: hibernation pricing on long pauses.
- ❌ Loses downtime catch-up: if the system is offline when a cutoff
  passes, that cutoff doesn't fire on recovery (the next chained
  enqueue is gone too — chain breaks).
- ❌ Recovery complexity: how do we detect a broken chain and
  re-prime it? Probably a slow background reconciler — which is
  basically the tick loop we just removed.

**Followup.** Cross-referenced from `next-up.md`'s "Production
scheduler process" entry. Resolve when there's a real deployment
signal — either someone hitting the catch-up edge case (favors
keeping our layer) or someone running on edge infrastructure where
hibernation pricing dominates (favors `availableAt` chaining).

---

## D-015 — Cloudflare Workflows: factor a Backend interface, defer the implementation (2026-05-02)

**Decision.** Don't build a Cloudflare Workflows backend yet. Don't
wrap [`cloudflare/dynamic-workflows`](https://github.com/cloudflare/dynamic-workflows)
either — its problem (per-tenant *code* dispatch) is not our problem
(per-tenant *data*, which our JSON walker already solves). Instead,
when convenient, factor `@thodare/engine`'s `Backend` interface into
an abstract surface so a future CF Workflows implementation is a
one-package addition rather than an engine refactor.

**Why.** Three things came together:

1. CF Workflows is shape-compatible with openworkflow (`step.do` /
   `step.sleep` / `step.waitForEvent`). A backend swap is feasible.
2. The genuinely interesting payoffs are edge-native deployment,
   hibernation pricing on long pauses, and closing the docs caveat
   that says "Workers can run the API but you still need a Postgres
   worker pod for durable execution."
3. `dynamic-workflows` is a red herring for us. It dispatches per-tenant
   *Worker code*; we dispatch per-tenant *workflow JSON* through one
   `wfkit-runtime` entrypoint. Our walker IS the dispatcher.

**Why not now.** CF Workflows is still in open beta; breaking changes
likely. Two backends doubles the test matrix and the API-churn cost.
The current Tier 1 work (CLI workflow commands, OTel recipe, prod
scheduler) moves adoption more than a backend swap. Splitting the
value prop ("runs on your Postgres OR our Workers") risks two
products in trench coats before either has a champion.

**Followup.** `next-up.md` Tier 2 carries "Factor Backend interface
for runtime portability" — a 1-day refactor today that lets a future
`@thodare/cf-engine` package land in ~1 week instead of needing an
engine redesign. Track CF Workflows GA + first user signal before
opening an RFC at `rfcs/cf-engine/`.

**Tradeoff.** Doing the abstraction-only refactor now means a tiny
maintenance tax (one more interface to keep stable) for ~1 week of
saved time later. Acceptable. The alternative — designing CF Workflows
support reactively when a customer asks — would mean redesigning the
engine under deadline pressure.

---

## D-014 — Docs restructured to Diataxis (2026-05-02)

**Decision.** `@thodare/docs` reorganized into six top-level
sections — Start here / Tutorials / How-to / Reference / Explanation /
Project — mirroring `asyncdotengineering/ahamie`'s `apps/docs/`. Moved
from `packages/docs/` to `apps/docs/`. Upgraded Astro 4 → 6 and
Starlight 0.30 → 0.38.

**Why.** Diataxis is the canonical discipline for technical
documentation; matching ahamie's pattern aligns the asyncdotengineering
org's docs surface across projects. The Astro/Starlight upgrade
brought us off the buggy `@astrojs/sitemap` 3.7.x (we were pinning
3.4.1 as a workaround) and onto the new content-collections loader.

**Followup.** None blocking. As content matures, write more tutorials
under each "Build your X" archetype.

---

## D-013 — `apps/docs/` location (2026-05-02)

**Decision.** Documentation site lives at `apps/docs/`, not
`packages/docs/`. `pnpm-workspace.yaml` includes `apps/*` and
`examples/*` alongside `packages/*`.

**Why.** The convention from ahamie + the broader monorepo ecosystem.
`packages/` is for library code that ships to npm; `apps/` is for
deployed surfaces (docs, dashboards, demo apps); `examples/` is for
runnable examples that consumers can copy. Keeping these separated
makes the npm publish surface clearer (only `packages/*` is published
externally).

---

## D-012 — `examples/` workspace (2026-05-02)

**Decision.** Examples live under `examples/` as workspace packages
named `@thodare-examples/<name>`. Each is `private: true` and uses
`workspace:*` deps. Two seeded:

- `hello-connector/` — minimal in-memory engine demo (~30 LoC).
- `full-llm-loop/` — full HTTP demo, lifted from `packages/api/examples/`.

**Why.** Workspace packages get proper dependency resolution +
TypeScript types. `private: true` keeps them out of npm. The
`@thodare-examples/*` namespace makes them clearly distinguishable
from publishable `@thodare/*` packages.

---

## D-011 — Vendored openworkflow uses upstream's exact tsconfig (2026-05-02)

**Decision.** `packages/openworkflow/tsconfig.json` extends
`../../tsconfig.base.json`, which mirrors upstream openworkflow's
`tsconfig.base.json` byte-for-byte. Both extend `@tsconfig/strictest`
+ `@tsconfig/node22` exactly.

**Why.** The first attempt used a hand-rolled relaxed tsconfig and
patched upstream source (with `as any`) to compensate when narrowing
broke. Wrong direction — instead, use upstream's exact tsconfig and
the source compiles unchanged. Apache-2.0 vendor discipline says
"don't modify the source unless necessary"; using the same tsconfig
makes that achievable.

**Followup.** When syncing from upstream, copy upstream's
`tsconfig.base.json` over ours if it changes. Document the sync in
`packages/openworkflow/UPSTREAM.md`.

---

## D-010 — Workspace-wide `@tsconfig/strictest` (2026-05-02)

**Decision.** Every TS package in the workspace (`packages/engine`,
`packages/api`, `packages/cli`, `packages/openworkflow`) extends
`tsconfig.base.json` which uses `@tsconfig/strictest +
@tsconfig/node22`.

**Why.** Single source of strictness across the monorepo. Aligns with
upstream openworkflow. Surfaces real bugs early
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noPropertyAccessFromIndexSignature`).

**Tradeoff.** ~45 errors to fix during adoption (18 engine, 27 api,
0 cli). All fixed at the source level — no `as any`, no
`@ts-ignore`, no type widening to defeat the flag. See
`rfcs/strict-tsconfig/README.md` §4 for the canonical fix patterns.

---

## D-009 — Vendor openworkflow as `@thodare/openworkflow` (2026-05-02)

**Decision.** Fork openworkflow into `packages/openworkflow/`,
republish at `@thodare/openworkflow`. License preserved (Apache-2.0);
source files match upstream byte-for-byte.

**Why.** Three benefits per `packages/openworkflow/UPSTREAM.md`:
version pinning during alpha, patch capability for any
Thodare-specific extensions, and brand surface (consumers install one
`@thodare/*` scope). Same pattern mistle and others follow.

**Tradeoff.** Maintenance burden on upstream syncs. Mitigated by
keeping zero source-file divergence at the start; any future patches
are documented in `UPSTREAM.md`.

---

## D-008 — Drop mistle from public credit (2026-05-02)

**Decision.** Remove all mistle (mistlehq/mistle) credit from public
docs and source comments. Keep the design lineage in the engine's
LEARNINGS.md as historical research notes, but reframe as "patterns
we shipped" rather than "borrowed from mistle".

**Why.** mistle was research-read, not adopted code. The earlier
credit framing was overgenerous and risked confusing readers about
the actual provenance. NOTICE retains attribution only for projects
whose code or design patterns we directly inherit (openworkflow, Sim
Studio).

---

## D-007 — Pronunciation: `[toh-DA-REE]` (2026-05-02)

**Decision.** Official pronunciation is `[toh-DA-REE]` — three
syllables, stress on second. Lean into the Tamil rhythm matching
`thodari`.

**Why.** More faithful to the Tamil source word `தொடர்` (*thodar*).
The earlier `[toh-DARE]` Westernization felt clipped. The 2016
Tamil-language film *Thodari* coexists with us in different Nice
classes (entertainment vs software/SaaS); phonetic resemblance across
class lines doesn't trigger trademark issues.

---

## D-006 — Auto-org via direct SQL, not `auth.api.createOrganization` (2026-05-02)

**Decision.** The `databaseHooks.user.create.after` hook inserts the
organization + member rows directly via the `pg.Pool`, not through
`auth.api.createOrganization`.

**Why.** Two reasons. First, the auth instance isn't fully
constructed during plugin init, so calling its API methods recursively
is fragile. Second, `auth.api.createOrganization` needs a session for
the calling user, which doesn't exist mid-signup. Direct SQL bypasses
both issues. The org plugin's
`setActiveOrganizationOnSessionCreate` (default `true`) handles
activation on the first session.

---

## D-005 — Persistent schedule claim via `SELECT ... FOR UPDATE` (2026-05-02)

**Decision.** `ScheduleStore.tryClaim(scheduleId, cutoffIso)` locks
the row, checks `last_fired_at`, advances if older than cutoff, all
in one transaction.

**Why.** The previous in-memory `seen` set was correct within one
process but broke under multi-process tickers (one pod + pg_cron, or
two pods). Row-level locking via Postgres makes the claim atomic
across any number of writers. The lock is held for sub-millisecond;
dispatch happens after COMMIT, outside the transaction.

**Tradeoff.** A crashed tick mid-transaction holds the lock until
the connection times out (~10s default). Acceptable: schedules fire
on minute boundaries; a 10s delay on one tick is invisible. If it
becomes a problem, set a tighter `statement_timeout` on the
ticker's pool.

---

## D-004 — First-run admin bootstrap via signed link (2026-05-02)

**Decision.** `THODARE_BOOTSTRAP=1` + empty `user` table → log
`/api/bootstrap?token=<HMAC>` once at boot. Hitting the URL mints
the first admin (random email + password + API key). Self-disables
when the user table is non-empty.

**Why.** The cold-start paradox: a fresh deploy has no users, every
protected route 401s, and the curl chain to sign up requires an
`Origin` header most operators don't think to set. Lifting the
Plausible / Sentry / Outline pattern was the path of least
resistance. The triple gate (env flag + empty table + signed token)
makes it operationally safe.

**Followup.** Document a "what to do after bootstrap" flow in
`apps/docs/how-to/bootstrap-admin.md`. Done.

---

## D-003 — pnpm monorepo + Changesets (2026-05-02)

**Decision.** Move from npm workspaces to pnpm workspaces; adopt
`@changesets/cli` for per-package versioning.

**Why.** pnpm's `workspace:*` rewriting at publish time is the right
primitive for cross-package deps in a monorepo. Changesets gives us
atomic per-package version bumps + auto-generated CHANGELOG.md per
package. npm workspaces has neither.

---

## D-002 — Name: Thodare (2026-05-02)

**Decision.** Project named `Thodare`, scope `@thodare/*` on npm,
GitHub org `asyncdotengineering`. Trademark cleared on USPTO + npm
+ GitHub + DNS.

**Why.** Hides Tamil தொடர் (*thodar*, "chain"); reads as
Greco-Italian; matches the workflow-engine abstraction (a workflow
IS a chain of steps). Phonetic adjacency to the 2016 film *Thodari*
is fine — different Nice classes (entertainment vs software).

---

## D-001 — Vendor openworkflow > depend on it directly (2026-05-02)

(Superseded by D-009 — kept for historical record; D-009 is the
authoritative version with full rationale.)

---

## How to add an entry

```
## D-### — Title (YYYY-MM-DD)

**Decision.** [What was chosen and how it was implemented.]

**Why.** [Rationale and tradeoffs.]

[Optional: **Followup.** | **Tradeoff.** | **Followups required.**]
```

Numbering is monotonic. Don't reuse numbers.

For decisions that derive a SPEC change (T1–T19), open an RFC under
`rfcs/<slug>/` first. The RFC reasons through the decision; an entry
here records that the decision was taken and which RFC produced it.
