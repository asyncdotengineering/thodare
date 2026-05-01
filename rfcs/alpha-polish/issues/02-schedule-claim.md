---
issue: 02-schedule-claim
rfc: alpha-polish
chunk: C-2
status: done
depends_on: []
estimate: medium
---

# C-2 — Persistent schedule claim (FOR UPDATE SKIP LOCKED)

RFC: [`../README.md`](../README.md) §4

## Files

- packages/api/src/store/schedules.ts (add last_fired_at column + claimDue method)
- packages/api/src/routes/schedules.ts (use claimDue instead of in-memory seen)
- packages/api/tests/08.schedule-claim.test.ts

## Acceptance

1. ALTER TABLE schedules ADD COLUMN last_fired_at timestamptz NULL.
2. ScheduleStore.claimDue(cutoffIso): returns rows where (last_fired_at IS NULL OR < cutoff) AND not currently row-locked, atomically setting last_fired_at = cutoff.
3. Two parallel `POST /api/admin/tick` requests dispatching the same schedule fire it exactly ONCE total (the row lock serialises them).
4. A schedule that doesn't match its cron at the cutoff time doesn't update last_fired_at.
5. The existing 5 schedule tests in 05.schedules-and-webhooks.test.ts still pass.

## Notes
