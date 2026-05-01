---
title: Auth model
description: "Sessions, API keys, organizations, scoping rules."
---

Auth is provided by [better-auth](https://www.better-auth.com) with
the `organization`, `apiKey`, and `bearer` plugins. Three modes
resolve to the same `(user, organizationId)` on the request context.

## The three modes

1. **Cookie session.** Set by `POST /api/auth/sign-in/email`. Browser UIs.
2. **Bearer session token.** `Authorization: Bearer <session_token>`. Same
   identity as cookie path; lets non-browser clients (mobile, scripts)
   carry a session without a cookie jar.
3. **API key.** `Authorization: Bearer thd_…` OR `x-api-key: thd_…`.
   Identity is the *key*, not a person. Configured with
   `references: "organization"` so a verified key resolves to its org
   in one call (no metadata join).

## The middleware contract

After the auth guard passes, every route handler reads:

```ts
c.get("user");              // { id, email }
c.get("organizationId");    // string
c.get("authMode");          // "session" | "api-key"
c.get("apiKeyId");          // string | undefined (only when api-key)
```

## Scoping rules

| Resource | Scope | Cross-org access |
|---|---|---|
| Workflow | `organization_id` | Returns `404`, not 403 — we don't reveal existence. |
| Schedule | `organization_id` | Same. |
| Run | Inherits from workflow | Same. |
| API key | `referenceId = organizationId` | A key works only for its org. |
| Webhook route | Programmatic at boot | No HTTP surface to register. |

## Sessions vs keys

| | Session | API key |
|---|---|---|
| Tied to | A user | The org |
| Lifetime | Session expiry (sliding) | Until revoked |
| Used by | Browser UI, mobile apps | LLM orchestrators, CI, server-to-server |
| Active org | `session.activeOrganizationId` | Key's `referenceId` |
| Revocation | Sign-out (this device) / password reset (all) | `DELETE /api/auth/api-key/:id` |

When an employee leaves, you don't scramble through their personal
keys — service tokens stay because they belong to the *organization*.
That separation is deliberate.

## Auto-org on signup

`databaseHooks.user.create.after` inserts a personal organization +
membership for every new user. The org plugin's
`setActiveOrganizationOnSessionCreate` (default `true`) auto-selects
the only membership when the session has no active org. Result: a
freshly-signed-up user can hit any protected route immediately — no
explicit `organization/create` + `set-active` orchestration needed.

## Fail-closed

- An empty `apikey` table = no programmatic request authorizes.
- A user with no organizations = 401 `no_active_organization`.
- Any path NOT under `/api/auth/*` and NOT in `openPaths` (just
  `/health` and `/api/bootstrap`) requires resolved identity.
- `THODARE_BOOTSTRAP=1` only opens `/api/bootstrap` if the user table
  is empty AND the env flag is set. Misconfig → 404.

## Rate limit

Per-`(organizationId, principal)` token bucket. `principal` is the API
key id when authenticating via key, or the user id when via session.
Default 60 req/min. Bucket per-pair means one tenant cannot starve
another, and one user's session cannot starve another's keys.

## Implementation

[`packages/api/src/auth.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/api/src/auth.ts) +
[`middleware/session.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/api/src/middleware/session.ts).

## Next

- [Issue + revoke API keys](/thodare/how-to/manage-keys/) — practical operations.
- [Bootstrap a fresh deployment](/thodare/how-to/bootstrap-admin/) — the cold-start flow.
