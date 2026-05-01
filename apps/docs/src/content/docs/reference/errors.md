---
title: Error codes
description: "Every error code Thodare returns, what it means, what to do."
---

All errors are JSON: `{ "error": "<code>", … }`. Codes are stable.

## 4xx

| Code | Status | Meaning | Caller action |
|---|---|---|---|
| `unauthorized` | 401 | No session, no valid API key, malformed header. | Check `Authorization` / `Cookie`. |
| `no_active_organization` | 401 | Session resolved but user has no active org. | `POST /api/auth/organization/set-active`. |
| `not_found` | 404 | Resource missing OR belongs to another org. | Verify id; cross-org reads return this code. |
| `invalid_body` | 400 | Body not JSON / didn't match Zod schema. | Inspect `issues[]`. |
| `invalid_cron` | 400 | Cron didn't parse. | See `message`. |
| `invalid_if_match` | 400 | `If-Match` header not a positive integer. | Send the latest `version`. |
| `version_mismatch` | 412 | Workflow updated between read and write. | Refetch `GET /api/workflows/:id`, retry with new version. |
| `rate_limited` | 429 | Per-(org, principal) bucket exhausted. | Sleep `retryAfterMs` then retry. |
| `workflow_not_found` | 404 | Schedule references a workflow not in this org. | Use a workflow id you own. |

## 5xx

| Code | Status | Meaning | Caller action |
|---|---|---|---|
| `dispatch_failed` | 500 | Run dispatch threw before durable runtime. | See `message`. Often connector misconfig. |
| `cancel_failed` | 500 | Run cancel threw at openworkflow layer. | See `message`. |
| `logs_failed` | 500 | Listing step attempts failed. | See `message`. Transient DB hiccup. |

## Auth-route errors

The `/api/auth/*` routes are handled by better-auth and return its
error shapes:

| Code | Meaning |
|---|---|
| `MISSING_OR_NULL_ORIGIN` | Forgot to send `Origin: <baseURL>`. |
| `INVALID_CREDENTIALS` | Wrong password. |
| `USER_NOT_FOUND` | Sign-in for an unregistered email. |
| `USER_ALREADY_EXISTS` | Sign-up for an existing email. |
| `INVALID_TOKEN` | API key verify on a missing or revoked key. |
| `INVALID_REFERENCE_ID_FROM_API_KEY` | Tried to mint a key while authenticated as a key (sessions only). |

## Health

`GET /health` returns `200 { "status": "ok", "version": "<label>" }`
unconditionally. Database liveness is *not* part of `/health` — for that, hit any authenticated read.
