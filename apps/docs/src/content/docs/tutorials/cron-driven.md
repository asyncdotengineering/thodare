---
title: Cron-driven workflow
description: "Register a schedule, drive a tick, watch the workflow fire."
---

In this tutorial you'll register a cron schedule for the workflow
you built in [Build your first workflow](/thodare/tutorials/first-workflow/),
then drive a dispatcher tick to fire it.

Production deployments drive the tick from `pg_cron` or a worker
process; we'll do it manually with `POST /api/admin/tick` so you can
see exactly what happens.

## Step 1: register a schedule

```sh
URL=http://localhost:3000
H="Authorization: Bearer $(thodare token)"
WFID=<your workflow id from the previous tutorial>

curl -sX POST "$URL/api/schedules" \
  -H "$H" -H 'content-type: application/json' \
  -d '{
    "workflowId": "'$WFID'",
    "cron": "* * * * *",
    "payload": { "tag": "minutely-test" }
  }' | jq
# → { "id": "sch_…", "workflowId": "...", "cron": "* * * * *", "payload": { "tag": "minutely-test" } }
```

### What's happening

- The schedule lives in your org's `schedules` table.
- `* * * * *` means "every minute" — useful for testing. Real schedules
  use 5-field cron: `0 9 * * 1-5` is "9am Monday-Friday".
- The schedule references a `workflowId` you own. Cross-org binding is
  refused at create time.

## Step 2: drive a tick

```sh
curl -sX POST "$URL/api/admin/tick" -H "$H" | jq
# → {
#     "fired": [{ "scheduleId": "sch_…", "runId": "<uuid>" }],
#     "failed": [],
#     "skippedAlreadyFired": 0,
#     "skippedNotMatching": 0,
#     "skippedExpired": 0
#   }
```

If you tick twice in the same minute, the second tick has
`fired: []` and `skippedAlreadyFired: 1` — the row's `last_fired_at`
column tracks "this cutoff already went out."

### Why this matters

The claim is **persistent and atomic** at the row level
(`SELECT … FOR UPDATE` inside a transaction, then `UPDATE
last_fired_at`). Multi-process tickers (e.g., your CI test harness
running concurrently with a real cron worker) compete for the same
row and exactly one wins.

## Step 3: confirm the run completed

```sh
RUNID=<runId from step 2>
curl -s "$URL/api/runs/$RUNID" -H "$H" | jq '{state, output}'
```

Each tick that fires the schedule creates a new run. Inspect each via
`/api/runs/:runId`.

## Step 4: list and remove the schedule

```sh
curl -s "$URL/api/schedules" -H "$H" | jq

curl -sX DELETE "$URL/api/schedules/sch_..." -H "$H"
# → 204
```

## What you learned

- Schedules are rows in your org's `schedules` table; cross-org binding
  is refused.
- The tick endpoint reads schedules across all orgs but uses
  per-(scheduleId, cutoff) row locks to dispatch each exactly once.
- For production, drive the tick from `pg_cron` or a 60s-interval
  worker pod. See
  [Schedule a workflow](/thodare/how-to/schedule-workflow/) for
  patterns.

## Next

- [Schedule a workflow (production patterns)](/thodare/how-to/schedule-workflow/) — pg_cron, worker pods, retries.
- [Register a webhook route](/thodare/how-to/register-webhook/) — the inbound counterpart to cron.
