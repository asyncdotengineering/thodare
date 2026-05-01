---
title: Bootstrap a fresh deployment
description: "Mint the first user + org + API key on an empty database — once, with a signed link."
---

## Goal

You just deployed `@thodare/api` against an empty Postgres. Every
protected route 401s because there are no users. How do you get in?

## The mechanism

Set `THODARE_BOOTSTRAP=1` and start the API. If — and only if — the
`user` table is empty, the API prints a one-time signed link to
stderr:

```
🔓 First-run bootstrap is armed.
   https://your-api.example.com/api/bootstrap?token=…
   Curl that URL once to mint your first admin user + org + API key.
   The link self-disables after first use.
```

Curl that URL once to mint the first admin (random email + password +
API key). The link self-disables once the user table has any row.

## Step 1: arm and start

```sh
THODARE_BOOTSTRAP=1 ./your-api-binary
# (or: THODARE_BOOTSTRAP=1 docker compose up)
```

## Step 2: copy the link from logs

```sh
journalctl -u thodare-api -n 100 | grep "First-run bootstrap"
# or
kubectl logs deploy/thodare-api | grep "First-run bootstrap"
```

## Step 3: hit the link

```sh
curl -s 'https://your-api/api/bootstrap?token=<signed>' | jq
# {
#   "ok": true,
#   "email": "admin-…@bootstrap.thodare.local",
#   "password": "…",
#   "apiKey": "thd_…",
#   "organizationId": "…",
#   "organizationSlug": "…",
#   "message": "Save this. The bootstrap link self-disables now…"
# }
```

Save the `apiKey`. That's your first admin.

## Step 4: disarm

Once the first user exists, the route returns 404 even with a correct
token. You can leave `THODARE_BOOTSTRAP=1` set, but cleaner to unset
it before the next deploy:

```sh
unset THODARE_BOOTSTRAP   # local
# or remove the env var from your manifest
```

## Step 5: hand off

Sign in to the admin user via `thodare login`, mint per-team API keys,
delete the auto-generated bootstrap key:

```sh
thodare login --api $URL --email <admin-email-from-step-3>
thodare key create --name "team-keys-replace-bootstrap"
thodare key revoke <bootstrap-key-id>
```

## How the link is signed

```
token = HMAC-SHA256(authSecret, "thodare:bootstrap:v1")
```

Deterministic per-deploy — survives crashes, so the link printed once
remains valid until first use. Single-use is enforced by the
empty-user-table check, not by the token itself; the token is just an
authorization gate to prevent random pingers from minting on your
behalf.

## Risks

- **Stderr leakage.** The link prints to stderr. Anyone with log access
  during the bootstrap window can use it once. Keep the bootstrap
  window short (deploy → bootstrap → unset env in minutes, not days).
- **Misconfiguration.** If you forget to unset `THODARE_BOOTSTRAP=1`
  but the user table is non-empty, the route 404s — no risk. The flag
  is fail-closed.

## Common issues

**Link returns 404.** The user table isn't empty (someone already
bootstrapped) OR `THODARE_BOOTSTRAP` isn't `1`. Check `SELECT COUNT(*)
FROM "user"` in the schema you booted into.

**Link returns 401.** Token mismatch. Verify the `authSecret`
environment variable on the API matches the one used to compute the
token. (The CLI doesn't compute it — only the API server does. The
link in the logs is the only valid one for this deploy.)

## Next

- [Issue + revoke API keys](/thodare/how-to/manage-keys/) — what to do after bootstrapping.
- [Auth model](/thodare/reference/auth-model/) — full rules.
