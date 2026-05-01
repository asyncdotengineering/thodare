# alpha-polish — issue tracker

All chunks shipped. RFC status: Shipped. Released as @thodare/api@0.1.1.

| # | Chunk | Status | Depends on | Est. |
| --- | --- | --- | --- | --- |
| 01 | C-1 Auto-create personal org on user signup | done | [] | small |
| 02 | C-2 Persistent schedule claim (FOR UPDATE SKIP LOCKED) | done | [] | medium |
| 03 | C-3 First-run admin bootstrap (one-time signed link) | done | ['01-auto-org'] | small |
| 04 | C-4 0.1.1 changeset + publish | done | ['01-auto-org', '02-schedule-claim', '03-bootstrap-admin'] | small |

Order: C-1 / C-2 (parallelizable) → C-3 → C-4.
