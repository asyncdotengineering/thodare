---
title: Issue + revoke API keys
description: "Mint, list, rotate, and revoke `thd_…` API keys."
---

## Goal

Hand a key to an LLM orchestrator / CI pipeline / service-to-service
caller, and revoke it later without disturbing other keys.

## Issue (CLI)

```sh
thodare key create --name "production-orchestrator"
# thd_FcBovczvVtTmLYuqFkveWvJeGHXphylMHdNqCbKEthjNunSe
# (name: production-orchestrator, id: …)
# store this — you won't see it again.
```

Issue is recorded in the apikey table; the raw value is shown once and
hashed at rest.

## Issue (HTTP)

```sh
SESSION_COOKIE="$(grep session_token ~/.thodare/credentials.json | …)"

curl -sX POST "$URL/api/auth/api-key/create" \
  -H "content-type: application/json" \
  -H "origin: $URL" \
  -H "cookie: $SESSION_COOKIE" \
  -d '{
    "configId": "default",
    "name": "production-orchestrator",
    "organizationId": "<orgId>"
  }'
```

The `/api/auth/api-key/*` admin routes need a real **session cookie**,
not an API key — by design (an API key cannot mint other API keys).
The CLI saves the session cookie alongside the API key in
`~/.thodare/credentials.json` precisely for this.

## List

```sh
thodare key list
# id        prefix  name                        createdAt              lastRequest
# 0Mvtq…    thd_uc  production-orchestrator     2026-05-02T…           2026-05-03T…
```

Returns `id`, `name`, `start` (first 6 characters for UI), `createdAt`,
`lastRequest`. Raw value never leaves the database.

## Use

Either header form works:

```sh
curl -H "Authorization: Bearer thd_…" $URL/api/connectors
curl -H "x-api-key: thd_…"            $URL/api/connectors
```

The auth guard's `customAPIKeyGetter` matches on the `thd_` prefix, so
non-key Bearer values (session tokens) fall through to the bearer-plugin
path.

## Rotate

Standard zero-downtime rotation:

1. `thodare key create --name production-2026-q2`
2. Roll the new key into your secret store.
3. Confirm the orchestrator picks it up (`lastRequest` on the new key
   moves).
4. `thodare key revoke <old-key-id>`.

Revocation is effective on the next request — no caching layer.

## Don't

- **Don't ship API keys in browser code.** Use cookie sessions for UIs.
- **Don't share a key across environments.** Mint one per env (`prod`,
  `staging`, `local-dev`) so revocation is trivially scoped.
- **Don't put keys in Git.** Use your secrets manager.

## Common issues

**`401 unauthorized` after `thodare key create`.** The session cookie
expired (default ~7 days sliding). Re-run `thodare login` to refresh
it.

**`INVALID_REFERENCE_ID_FROM_API_KEY` from `/api/auth/api-key/create`.**
You authenticated the call with an API key. That endpoint requires a
session — see "Issue (HTTP)" above.

## Next

- [Auth model](/thodare/reference/auth-model/) — sessions vs keys, scoping rules.
- [Bootstrap a fresh deployment](/thodare/how-to/bootstrap-admin/) — minting the first key.
