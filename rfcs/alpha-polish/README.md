---
slug: alpha-polish
status: Shipped
shape: B
created: 2026-05-02
---

# RFC: alpha-polish

Three independent improvements bundled for the 0.1.1 patch release. None
add new public surface; each fixes a sharp edge surfaced by the previous
phases.

## §1 Goals

1. **Auto-create personal org on signup.** A first-time user shouldn't
   hit `401 no_active_organization` on their first protected request.
   The CLI works around this today by orchestrating an extra
   `organization/create` + `set-active` call. Move the logic into
   better-auth's `databaseHooks.user.create.after`. The CLI then
   collapses to: sign-in/up → mint key → done.

2. **Persistent schedule claim.** Today's dispatcher tick tracks claimed
   `(scheduleId, cutoff)` pairs in an in-memory `Set`. That's fine for a
   single-process test endpoint but breaks if two ticks (different
   processes, or one tick + one pg_cron) try to fire the same schedule.
   Add `last_fired_at timestamptz` to the schedules row and gate the
   tick query with `SELECT … FOR UPDATE SKIP LOCKED` so claim is
   row-level atomic.

3. **First-run admin bootstrap.** When the deploy is fresh and the
   `user` table is empty, every protected route 401s and the only way
   in is to manually craft an `Origin`-headered POST against
   `/api/auth/sign-up/email`. We add a `THODARE_BOOTSTRAP=1` env flag
   that, *only* when the user table is empty, prints a one-time signed
   link to `/api/bootstrap?token=…`. Hitting that link mints the first
   admin user + personal org + API key and prints them. The flag and
   token are single-use — after one bootstrap, both are inert.

## §2 Non-goals

- No new auth providers (OAuth, passkeys) — out of scope.
- No multi-tenant org-creation policy beyond "every new user gets one
  personal org." Inviting members and creating extra orgs already works
  through the existing org-plugin routes.
- No production multi-process scheduler. We're tightening the existing
  tick endpoint; full scheduler-as-a-service is a separate RFC.

## §3 Background

### 3a. The signup-org race

Today, `bootstrapTenant()` in the CLI's test harness does this:

```ts
1. signUp(email, password)
2. organization/create      ← needed because the user has no orgs
3. organization/set-active  ← needed because no active org is implicit
4. apiKey/create
```

Steps 2 and 3 are pure overhead — every first-time user wants a
personal org. better-auth has `databaseHooks` that fire on user create;
we wire one to do steps 2-3 inside the auth instance, and the CLI drops
to `signUp → apiKey/create`.

### 3b. The dispatcher race

The current admin/tick handler builds an ephemeral `seen` set per
request:

```ts
async tryClaim(scheduleId, cutoffIso) {
  const key = `${scheduleId}@${cutoffIso}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
},
```

This is correct *within one tick*. With two parallel ticks (e.g., your
CI test harness running concurrently with a real cron worker, OR two
backend pods) both think they own every schedule.

Postgres has the right primitive: `FOR UPDATE SKIP LOCKED` returns rows
that aren't currently held by another transaction. Combine that with a
`last_fired_at` column and the claim is row-level atomic across any
number of writers.

### 3c. The cold-start paradox

A fresh deploy of `@thodare/api` against an empty Postgres has zero
users. Every protected route 401s. The bootstrap chain (sign-up → org →
key) requires no auth, but the `Origin` gate makes it surprisingly
finicky — and most operators don't think to look there. Result: support
tickets that boil down to "where do I get the first key?"

The fix lifted from Plausible / Sentry / Outline: a one-time signed
bootstrap URL printed at startup *only when the user table is empty
AND opt-in via env*. Hit it once, get a key, done.

## §4 Interface specification

### 4a. Auto-org

`createAuth({...})` adds a database hook:

```ts
databaseHooks: {
  user: {
    create: {
      after: async (user, ctx) => {
        // Create a personal org named "<email-prefix>'s workspace"
        // with a unique slug. Add the user as owner.
        // Set the new org as active on the user's row.
      },
    },
  },
},
```

Externally observable: a freshly signed-up user has exactly one org
membership immediately, and that org is active on their session. The
`bootstrapTenant()` helper in the CLI harness loses its
`organization/create` and `organization/set-active` steps.

### 4b. Persistent schedule claim

```sql
ALTER TABLE schedules ADD COLUMN last_fired_at timestamptz NULL;
CREATE INDEX schedules_last_fired_at_idx
  ON schedules (last_fired_at)
  WHERE last_fired_at IS NULL OR last_fired_at < now() - INTERVAL '1 minute';
```

The dispatcher's claim flow becomes:

```sql
BEGIN;
SELECT id, organization_id, workflow_id, cron, payload, end_at, last_fired_at
  FROM schedules
  WHERE (last_fired_at IS NULL OR last_fired_at < $cutoff_minus_resolution)
    AND (end_at IS NULL OR end_at > now())
  FOR UPDATE SKIP LOCKED
  LIMIT 100;
-- compute due rows, dispatch each
UPDATE schedules SET last_fired_at = $cutoff WHERE id = $row;
COMMIT;
```

`tryClaim` shrinks to "the SELECT FOR UPDATE returned this row" — the
in-memory `seen` set is gone.

### 4c. Bootstrap admin

New route mounted *only* when `THODARE_BOOTSTRAP=1` AND user count = 0:

```
GET  /api/bootstrap?token=<signed>
```

Server lifecycle:

1. On `createControlPlaneApi()` boot, if `process.env.THODARE_BOOTSTRAP === "1"`:
   - Count rows in `user` table. If > 0, skip (no-op).
   - If 0: generate `token = hmacSHA256(secret, "bootstrap")` (deterministic
     per-deploy so it survives crashes), print `🔓 First-run bootstrap
     link: <baseURL>/api/bootstrap?token=<token>` to stderr.
   - Mount `GET /api/bootstrap` route that:
     - Verifies `query.token` matches expected.
     - Verifies user count is still 0 (race-safe).
     - Generates a random email + password, signs the user up via the
       same path `sign-up/email` would (which fires the auto-org hook).
     - Mints an API key.
     - Returns `{ email, password, apiKey, organizationId, organizationSlug }`
       as JSON.
   - Self-disables: subsequent calls 404 because user count > 0.

2. Operators run `THODARE_BOOTSTRAP=1 ./api`, copy the link from logs,
   curl it, get credentials, done.

## §5 Constraints

- **Backward compatible.** Existing deploys upgrade transparently. The
  `last_fired_at` column is nullable; old schedule rows get `NULL` and
  fire on next tick.
- **Bootstrap is opt-in.** Production deploys without `THODARE_BOOTSTRAP=1`
  don't expose the route at all.
- **Auto-org failures don't block signup.** If the org-create hook
  throws, sign-up still succeeds (the user can manually create an org
  later). Hook errors go to stderr.

## §6 Risks

1. **better-auth's `databaseHooks` API may be unstable.** Mitigation:
   the API has been stable since v1.0; we're on 1.6.9.
2. **`FOR UPDATE SKIP LOCKED` semantics on long transactions.** A
   crashed tick mid-transaction holds the lock until the connection
   times out. Mitigation: keep tick transactions tiny (claim → release
   inside the same transaction; dispatch happens *outside* the
   transaction).
3. **Bootstrap token leakage in logs.** Stderr-only; production logs
   should be tail-followed by an operator who's already trusted.
   Mitigation: rotate the token after first use is moot (it's
   single-use), and the URL is printed *exactly once*, at startup.

## §7 Test budget

Target: ~12 new tests, ~8s suite runtime increment.

- Auto-org (4): user has org after signup; org is active; sign-up via
  HTTP path works; harness simplification didn't regress 06.
- Schedule claim (3): two parallel ticks don't double-fire; schedule
  with end_at past doesn't fire; happy-path single tick still works.
- Bootstrap (5): empty DB + flag → link printed; link works once; link
  invalid after use; flag without empty DB → no-op; missing token → 404.

## §8 Tasks (chunks)

| # | Chunk | Files | Estimate | Depends |
|---|---|---|---|---|
| C-1 | Auto-create personal org on user signup | `packages/api/src/auth.ts`, harness simplification, tests | small | — |
| C-2 | Persistent schedule claim with FOR UPDATE SKIP LOCKED | `packages/api/src/store/schedules.ts`, route, tests | medium | — |
| C-3 | First-run admin bootstrap (signed one-time link) | `packages/api/src/bootstrap.ts`, server.ts, tests | small | C-1 |
| C-4 | 0.1.1 changeset + publish | `.changeset/*.md`, `pnpm publish` | small | C-1, C-2, C-3 |

## §9 Hard stops

- Three TDD failures on a single chunk → write `HALT.md`, stop.
- Auto-org hook breaks the existing 43 api tests (instead of simplifying
  them) → revert the hook, keep manual orgs.
- `FOR UPDATE SKIP LOCKED` causes test deadlocks under the per-test
  schema isolation → fall back to the in-memory seen set with a clear
  comment that production needs the row lock.
