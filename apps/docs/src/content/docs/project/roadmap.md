---
title: Roadmap
description: "What's shipped, what's next, what we're not doing yet."
---

> 🟠 **Status: alpha (0.1.x).** APIs may shift between minor versions.
> Don't run business-critical traffic on it yet — but please run
> staging and tell us what breaks.

## Shipped (0.1.x)

- ✅ **Connector-shaped DSL.** Block↔Tool, `visibility`, declared
  outputs, `kind: 'wait'`.
- ✅ **EditOp patch surface.** Skip-don't-reject, structured reasons,
  `If-Match` optimistic concurrency.
- ✅ **Durable runtime.** Postgres-backed via vendored
  `@thodare/openworkflow`; replay, retries, signal-driven waits.
- ✅ **HTTP control plane.** Hono app, workflows / runs / schedules /
  webhooks, run introspection.
- ✅ **Auth.** better-auth + organizations + apiKey, fail-closed,
  per-`(org, principal)` rate limit.
- ✅ **CLI.** `thodare login / token / env / whoami / logout / key`.
- ✅ **Auto-org on signup.** No more `no_active_organization` 401 on
  the first request.
- ✅ **Persistent schedule claim.** `SELECT … FOR UPDATE` row lock
  for multi-process tickers.
- ✅ **First-run admin bootstrap.** `THODARE_BOOTSTRAP=1` + signed
  one-time link.
- ✅ **Vendored openworkflow.** `@thodare/openworkflow` for version
  pinning + patch capability.
- ✅ **Workspace strict-tsconfig.** All packages compile under
  `@tsconfig/strictest + @tsconfig/node22`.

## Next up (0.2.x targets)

- 🚧 **`thodare workflow` commands.** `list / get / run / logs` so the
  CLI is a real client, not just a key issuer.
- 🚧 **Production scheduler.** A separate process that ticks on a real
  interval. Cleaner than pg_cron + auth-key-for-tick.
- 🚧 **Org deletion hooks.** Cascading cleanup of workflows /
  schedules / keys when an org is deleted (or refusing the delete
  while non-empty).
- 🚧 **Cloudflare Workers backend.** Durable Objects → step
  persistence, no separate worker pod.
- 🚧 **Connector marketplace primitives.** Publish + consume signed
  connector packages.
- 🚧 **Streaming run logs.** SSE / websocket on `/api/runs/:runId/stream`.

## Considered, deferred

- ❌ **Built-in OTel instrumentation.** Hooks-based abstraction
  (`withTracing`) instead — wire your own.
- ❌ **A no-code dashboard.** Build it on top; we ship the surface a
  UI builds on.
- ❌ **A fire-and-forget queue.** Use a queue for that.
- ❌ **Code-execution sandboxing.** No `code_execute` block in the
  default catalog. If you ship one, isolate it yourself.

## How to influence

- Open an issue: [github.com/asyncdotengineering/thodare/issues](https://github.com/asyncdotengineering/thodare/issues)
- File a PR: see [Contributing](/thodare/project/contributing/)
- For private security reports: `security@thodare.dev`
