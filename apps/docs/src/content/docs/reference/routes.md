---
title: HTTP routes
description: "Full HTTP surface of @thodare/api."
---

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | open | Liveness probe. |
| **Auth (better-auth)** | | | |
| POST | `/api/auth/sign-up/email` | open | Create user. |
| POST | `/api/auth/sign-in/email` | open | Email+password sign-in. |
| POST | `/api/auth/sign-out` | session | End session. |
| GET | `/api/auth/get-session` | open | Current session + user. |
| POST | `/api/auth/organization/create` | session | Create an org. |
| GET | `/api/auth/organization/list` | session | List orgs. |
| POST | `/api/auth/organization/set-active` | session | Switch active org. |
| POST | `/api/auth/organization/invite-member` | session | Invite teammate. |
| POST | `/api/auth/api-key/create` | session | Mint a `thd_` key. |
| GET | `/api/auth/api-key/list` | session | List keys. |
| POST | `/api/auth/api-key/delete` | session | Revoke a key. |
| **Bootstrap** | | | |
| GET | `/api/bootstrap?token=…` | signed | First-run admin (when armed AND user table empty). |
| **Workflows** | | | |
| POST | `/api/workflows` | ✓ | Create empty workflow. |
| GET | `/api/workflows/:id` | ✓ | Read workflow JSON + version. |
| POST | `/api/workflows/:id/operations` | ✓ | Apply `EditOp[]`. |
| DELETE | `/api/workflows/:id` | ✓ | Soft-delete. |
| POST | `/api/workflows/:id/run` | ✓ | Dispatch a run. |
| **Runs** | | | |
| GET | `/api/runs/:runId` | ✓ | Describe a run. |
| GET | `/api/runs/:runId/logs?after&limit` | ✓ | Paginated step attempts. |
| POST | `/api/runs/:runId/cancel` | ✓ | Cancel an in-flight run. |
| **Connectors** | | | |
| GET | `/api/connectors?detail=summary\|full` | ✓ | Catalog. |
| GET | `/api/connectors/:type` | ✓ | One connector's metadata. |
| **Schedules** | | | |
| POST | `/api/schedules` | ✓ | Register a cron schedule. |
| GET | `/api/schedules` | ✓ | List schedules in the active org. |
| DELETE | `/api/schedules/:id` | ✓ | Remove a schedule. |
| POST | `/api/admin/tick` | ✓ | Manual dispatcher tick. |
| **Webhooks** | | | |
| ALL | `/api/webhooks/*` | per-route | Programmatically registered routes. |

`✓` = requires session OR API key. The auth guard rejects with 401
(`unauthorized` or `no_active_organization`) before the route handler
runs.

## Common headers

| Header | When | Purpose |
|---|---|---|
| `Authorization: Bearer thd_…` | API-key auth | Programmatic access. |
| `Authorization: Bearer <session_token>` | Bearer sessions | Cookie-less session auth (bearer plugin). |
| `Cookie: better-auth.session_token=…` | Browser UI | Standard cookie session. |
| `x-api-key: thd_…` | Alt API-key | Same as Authorization Bearer for keys. |
| `Origin: https://yourdomain` | All `/api/auth/*` | better-auth CSRF gate. |
| `If-Match: <version>` | Workflow patch | Optimistic concurrency. |
| `Content-Type: application/json` | All bodies | Required for JSON. |

## Common response shapes

```jsonc
// 200 / 201 / 202 — handler-specific JSON
{ "id": "…", "version": 1 }

// 400 — validation
{ "error": "invalid_body", "issues": [/* zod issues */] }

// 401 — auth
{ "error": "unauthorized" }
{ "error": "no_active_organization" }

// 404 — not found OR cross-org probe
{ "error": "not_found" }

// 412 — optimistic concurrency
{ "error": "version_mismatch", "current": 7 }

// 429 — rate limit
{ "error": "rate_limited", "retryAfterMs": 12345 }

// 5xx — handler errors
{ "error": "dispatch_failed", "message": "…" }
```

See [Error codes](/thodare/reference/errors/) for the full table.
