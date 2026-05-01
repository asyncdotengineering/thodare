---
title: How a run executes
description: "From `POST /run` to the step_attempts row."
---

```
HTTP request
   │
   ▼
┌──────────────────────────┐
│ Hono app (@thodare/api)  │   /health, /api/auth/*, …
└──────────────────────────┘
   │
   ▼  authGuard → user, organizationId
┌──────────────────────────┐
│ Route handler            │   workflows / runs / schedules / connectors / webhooks
└──────────────────────────┘
   │
   ▼  scoped by organizationId
┌──────────────────────────┐
│ Postgres stores          │   workflows, schedules
└──────────────────────────┘
   │   ┌──────────────────────────┐
   ├──▶│ Wfkit.applyOps           │   the EditOp engine
   │   └──────────────────────────┘
   │
   ▼  POST /:id/run
┌──────────────────────────┐
│ runtimeHost.dispatch()   │   loads workflow JSON, packs into run input
└──────────────────────────┘
   │
   ▼
┌──────────────────────────┐
│ wfkit-runtime workflow   │   ONE openworkflow workflow that walks JSON
└──────────────────────────┘
   │
   ▼  one step.run() per block
┌──────────────────────────┐
│ openworkflow worker      │   Postgres step_attempts persistence
└──────────────────────────┘
   │
   ▼
┌──────────────────────────┐
│ Postgres                 │   workflow_runs, step_attempts, workflow_signals
└──────────────────────────┘
```

## Two stores, one schema

Both `@thodare/api`'s tables (`workflows`, `schedules`, plus
better-auth's `user`/`session`/`account`/`verification`/`organization`/`member`/`invitation`/`apikey`)
and openworkflow's tables (`workflow_runs`, `step_attempts`,
`workflow_signals`, `openworkflow_migrations`) live in the **same
Postgres schema** — `opts.schema` on `createControlPlaneApi`.

Per-API-instance schema isolation lets multiple Thodare deployments
share one Postgres cluster without cross-contamination. In tests, every
test uses a fresh `cpa_<random>` schema and drops it on teardown.

## Auth flow

```
request
   │
   ▼
authGuard.getSession({ headers })
   │
   ├─ session resolved → set(user, organizationId, authMode="session")
   │
   ├─ no session, but Authorization: Bearer thd_… present
   │     ↓
   │   verifyApiKey({ key })
   │     ↓
   │   valid → set(user, organizationId=referenceId, authMode="api-key")
   │
   └─ neither → 401 unauthorized
```

The api-key plugin is configured with `references: "organization"` so
a verified key directly carries the org id; no second query.

## Run dispatch

```
POST /api/workflows/:id/run
   │
   ▼
store.get(orgId, id) → workflow JSON
   │
   ▼
runtimeHost.dispatch(workflow, input, opts)
   │
   ▼
wfkit.runtime().run({ workflow, input }, opts)
   │
   ▼
openworkflow → INSERT workflow_runs + first step_attempt
   │
   ▼
202 { runId, spec: "wfkit-runtime" }
```

The run is durable from the moment `runs` returns. Block execution
happens in the worker; failures retry per the connector's policy;
pauses (`kind: "wait"`) suspend the worker without losing state.

## Schedule dispatch

`POST /api/admin/tick` reads schedules cross-tenant, but uses
per-row `SELECT … FOR UPDATE` + `last_fired_at` advance to claim each
`(scheduleId, cutoff)` exactly once. Two parallel ticks can't
double-fire — proven by a 50-racer test.

## Why one runtime workflow

openworkflow's registry is closed at `worker.start()`. Thodare exists
to register new workflow JSON without redeploys. We register
**exactly one** openworkflow workflow named `wfkit-runtime` whose input is
`{ workflow, input }`. Every run is an instance of that. See
[Why one runtime workflow](/thodare/explanation/runtime-workflow/).

## Why the JSON is pinned at run-start

If the LLM patches a workflow while a run is in-flight, the run must
finish on the JSON it started with — otherwise replay diverges.
Solution: pass the JSON as part of the run input. See
[Pin-at-run-start](/thodare/explanation/pin-at-run-start/).
