---
title: What is Thodare?
description: "A control plane for LLM-driven workflow construction, executed on a Postgres-durable runtime."
---

Thodare is an **HTTP control plane** that exposes a typed, durable
workflow engine to LLM orchestrators, agents, and UIs. It's the bridge
between *"the LLM produced a workflow JSON"* and *"that workflow ran to
completion, across deploys, with full audit history."*

## In one paragraph

You define connectors with Zod schemas, mount the API on Bun / Node /
Cloudflare Workers, and let an LLM build workflows by sending
`EditOp[]` patches. Bad ops come back as *structured skips* the LLM
can read and fix. Once the workflow is good, you `POST /run` and the
durable runtime takes over — survives crashes, deploys, and pauses
that last hours or days.

## The two packages you'll use

- **[`@thodare/engine`](https://www.npmjs.com/package/@thodare/engine)** —
  the workflow runtime. Connector-shaped DSL, `EditOp` patch model,
  `visibility` flag for hidden secrets, declared output schemas, and
  `kind: 'wait'` blocks that dispatch to durable sleeps and signals.
  Runs on [openworkflow](https://github.com/openworkflowdev/openworkflow)
  for the durable substrate (Postgres or SQLite).
- **[`@thodare/api`](https://www.npmjs.com/package/@thodare/api)** —
  the HTTP surface. Workflows CRUD, the LLM patch endpoint, runs +
  schedules + webhooks, plus auth (better-auth) and per-organization
  rate limiting. ~600 LoC of [Hono](https://hono.dev) routes on top of
  two Postgres stores.

Plus **`@thodare/cli`** for first-time setup and **`@thodare/openworkflow`**
(the engine's vendored fork of upstream openworkflow).

## The shape of a session

1. **Catalog discovery** — the LLM fetches `GET /api/connectors` to learn
   what blocks exist. Hidden params (e.g. `accessToken`) never appear; the
   LLM literally cannot reference them.
2. **Workflow draft** — the LLM emits an `EditOp[]` patch. The API applies
   ops one by one; bad ops are *skipped, not rejected*. The response
   carries `skipped_items[]` with structured reason codes the LLM reads
   and reacts to.
3. **Repair loop** — the LLM reads the skip log, tries again. Two or three
   rounds typically converge.
4. **Run** — `POST /api/workflows/:id/run` dispatches a run. The current
   workflow JSON is *snapshotted into the run input* so an in-flight run
   keeps using the version it started with even if the LLM keeps editing.
5. **Audit** — every step attempt lives in `step_attempts`, fully
   inspectable via `GET /api/runs/:runId/logs?after=…&limit=…`.

The repair loop is the load-bearing piece. A failed-but-skipped op is
the only training signal the LLM gets; if the API rejected the whole
batch on first error, single-shot construction wouldn't be a thing.

## Where it fits

| You need… | Thodare? |
|---|---|
| Workflows the LLM can build, edit, run, and read back | ✅ |
| Multi-step pipelines that survive deploys, crashes, restarts | ✅ |
| Cron triggers + webhook ingestion + signal-driven waits | ✅ |
| Multi-tenant SaaS (orgs, members, API keys per org) | ✅ |
| Fire-and-forget pub/sub | Use a queue |
| Streaming data pipelines (Kafka / Flink shape) | Wrong tool |
| A no-code form builder | Build it on top |

## Status

🟠 **Alpha.** APIs may shift between minor versions. 209 tests green.
[Issues, PRs, ideas](https://github.com/asyncdotengineering/thodare/issues).

## Where to next

- [Quickstart](/thodare/start/quickstart/) — sign in, get a key, ship a workflow.
- [Reference example](/thodare/start/reference-example/) — full LLM-loop demo source.
- [Build your first workflow](/thodare/tutorials/first-workflow/) — the guided walkthrough.
