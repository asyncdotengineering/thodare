# @thodare/api

## 0.1.1

### Patch Changes

- Three quality-of-life fixes that address the sharp edges surfaced by
  the 0.1.0 release.

  - **Auto-create personal org on signup.** A new user no longer 401s
    with `no_active_organization` on their first protected request. A
    better-auth `databaseHooks.user.create.after` inserts an
    organization + member row directly via the Pool; the org plugin's
    default session-side activation makes it the active org
    automatically. The CLI bootstrap and the test harness both lose
    their explicit `organization/create` + `set-active` orchestration.

  - **Persistent schedule claim.** The dispatcher tick's per-request
    in-memory `seen` Set has been replaced with a `last_fired_at`
    column + `SELECT … FOR UPDATE` row lock. Two parallel tickers
    dispatching the same schedule fire it exactly once total — proven
    by a 50-racer test that sees exactly 1 successful claim.

  - **First-run admin bootstrap.** With `THODARE_BOOTSTRAP=1` and an
    empty user table, `@thodare/api` prints a one-time signed
    `/api/bootstrap?token=…` link to stderr at boot. Curl that URL
    once to mint the first admin user + personal org + API key. The
    link self-disables once the user table is non-empty. Disabled by
    default; production deploys without the env flag never expose the
    route.

  No public API changes. Existing 0.1.0 deployments upgrade
  transparently — the `last_fired_at` column is added by
  `schedules.init()` via `ADD COLUMN IF NOT EXISTS`.
