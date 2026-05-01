---
title: Threat model
description: "What Thodare protects against, what it doesn't, where the boundaries are."
---

## In scope

### LLM-driven workflow construction

| Threat | Mitigation |
|---|---|
| LLM emits a block type that doesn't exist | Skipped with `block_type_not_registered`; reason text lists available types. |
| LLM tries to set a `hidden()` param (e.g. `accessToken`) | Caught at op application; never reaches the connector. |
| LLM creates a cycle | `cycle_introduced` skip; whole patch still applies, just the bad edge is dropped. |
| LLM produces a workflow that calls a nonexistent connector at run time | Connector lookup at execution; run fails with attributable error in `step_attempts`. |
| Prototype pollution via `JSON.parse` of a patch body | Defended against — see engine adversarial tests. |

### Multi-tenant isolation

| Threat | Mitigation |
|---|---|
| Tenant A reads tenant B's workflow | Returns `404 not_found`, not `403`. Cross-org reads are structurally impossible (every store query includes `organization_id = $`). |
| Tenant A binds a schedule to tenant B's workflow | Schedule registration verifies the workflow is in the caller's org. |
| Tenant A registers a webhook route pointing at tenant B's workflow | Webhook routes are programmatic (boot code), not HTTP-mutable. There is no API surface to do this. |
| Tenant A starves tenant B with a request flood | Rate limit is per-`(org, principal)`. One tenant's bucket cannot deplete another's. |
| Compromised API key | Revoke via `POST /api/auth/api-key/delete`. No caching layer keeps stale keys alive. |

### Auth boundary

| Threat | Mitigation |
|---|---|
| Anonymous request to a protected route | 401 `unauthorized`. Fail-closed. |
| Empty `apikey` table = silent open API | 401 — the database is the source of truth, an empty table authorizes nothing. |
| User has no orgs but has a session | 401 `no_active_organization`. |
| Origin-less `/api/auth/*` request | 403 `MISSING_OR_NULL_ORIGIN` — better-auth's CSRF gate. |
| Brute force against email+password | better-auth ships rate limiting on auth routes. Tune via `rateLimit` in auth options. |
| Cold-start route (`/api/bootstrap`) misuse | Only opens if `THODARE_BOOTSTRAP=1` AND user table is empty AND the signed token matches. Triple-gated. |

### Durability & replay

| Threat | Mitigation |
|---|---|
| Mid-run worker crash | openworkflow's step cache; replay re-executes only un-cached steps. |
| Network blip during step | openworkflow's per-step retry policy. |
| Mid-run patch to the workflow | Pin-at-run-start: the run uses snapshotted JSON. |
| Operator deletes a workflow with active runs | Soft delete; in-flight runs keep their pinned JSON. |
| Two ticks claim the same schedule | Persistent claim via `SELECT … FOR UPDATE` + `last_fired_at` advance. Exactly-once across N tickers. |

## Out of scope

- **TLS termination.** Run behind your own gateway / load balancer.
- **Email deliverability.** better-auth's email hooks need a working
  email provider you wire up.
- **Authn for webhook senders.** Per-route HMAC verification is your
  responsibility (see [Register a webhook route](/thodare/how-to/register-webhook/)).
- **Database backups + DR.** Postgres operational concerns are yours.
- **Connector-side auth.** A `slack` connector that holds a Slack
  token is responsible for its own secret hygiene. Hidden params are
  the scaffold; the actual storage is your call.
- **Code execution sandboxing.** There is no `code_execute` block in
  the default catalog. If you ship one, isolate it (isolated-vm,
  Cloudflare Workers, Wasm) — Thodare doesn't provide a sandbox.

## Adversarial test coverage

`@thodare/engine` includes 45+ adversarial tests:

- prototype pollution (object literal AND `JSON.parse` paths)
- 50-op batches with mixed validity
- 3-block cycles, self-loops, downstream-reference errors
- disabled-block references, tools that throw non-Error / return undefined
- durable cancel mid-execution
- 100-block fan-out in <6s
- 20 concurrent in-memory runs
- replay-determinism for `Date.now()` (cached step calls return identical values)

Full enumeration in
[`packages/engine/THREAT-MODEL.md`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/THREAT-MODEL.md).

## Reporting issues

Security reports: `security@thodare.dev` (or via GitHub Security
Advisories). Don't open public issues for security bugs.
