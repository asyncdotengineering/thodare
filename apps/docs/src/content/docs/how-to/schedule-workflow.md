---
title: Schedule a workflow
description: "Cron triggers in production — pg_cron, worker pod, or external scheduler."
---

## Goal

Fire a workflow on a cron schedule, durably and exactly once per
cutoff, in a multi-process deployment.

## Step 1: register the schedule

```sh
curl -sX POST "$URL/api/schedules" -H "$H" -H 'content-type: application/json' \
  -d '{ "workflowId": "<uuid>", "cron": "0 9 * * 1-5", "payload": { "tag": "weekday-9am" } }'
```

5-field cron, minute resolution. `endAt` (ISO 8601) is optional;
ticks past it are silently skipped.

## Step 2: drive the tick

The API exposes `POST /api/admin/tick` for manual / test use. Production
needs a real driver. Three patterns:

### A. pg_cron

```sql
SELECT cron.schedule(
  'thodare-tick',
  '* * * * *',
  $$ SELECT net.http_post(
       'https://your-api/api/admin/tick',
       headers := jsonb_build_object('Authorization', 'Bearer thd_…')
     ) $$
);
```

Mint a service-account API key (see [Issue + revoke API keys](/thodare/how-to/manage-keys/))
just for the ticker. Revoke it like any other.

### B. Worker pod

A 50-LoC process that runs once a minute:

```ts
setInterval(async () => {
  const r = await fetch(`${API}/api/admin/tick`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TICKER_KEY}` },
  });
  if (!r.ok) console.error("tick failed:", r.status);
}, 60_000);
```

Run it in your platform's scheduler (Kubernetes CronJob, Render Cron
Job, Fly Machines on a schedule).

### C. External scheduler

Cloudflare Cron Triggers, Upstash QStash, or any HTTP-pingable
scheduler. Same pattern as B without managing the process yourself.

## Step 3: verify exactly-once

The claim is row-level atomic: each tick wraps the eligible schedules
in a `SELECT … FOR UPDATE` transaction, advances `last_fired_at`, and
commits. Two parallel tickers can't double-fire the same cutoff —
proven by the engine's
[50-racer test](https://github.com/asyncdotengineering/thodare/blob/main/packages/api/tests/08.schedule-claim.test.ts).

## Common issues

**Schedule doesn't fire.** Confirm `endAt` isn't past, the cron parses
(`POST /api/schedules` returns 400 `invalid_cron` if not), and the
ticker is actually running. `curl /api/admin/tick` once manually and
inspect the response for `skippedNotMatching` / `skippedAlreadyFired`.

**Schedule fires twice.** Almost certainly two pods on the same row
without `FOR UPDATE` semantics. We have row locks; if you're seeing
this, file a bug with the schedule id.

**Drift on minute boundaries.** Cutoffs round down to the minute.
Cron at `* * * * *` and a tick at `00:00:30` both target the same
cutoff `00:00:00` — fires once.

## Next

- [Cron-driven workflow tutorial](/thodare/tutorials/cron-driven/) — walk it end to end.
- [Why we don't use the in-memory seen set](/thodare/explanation/how-it-runs/) — design rationale.
