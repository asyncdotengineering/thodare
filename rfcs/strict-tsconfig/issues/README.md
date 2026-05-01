# strict-tsconfig — issue tracker

All chunks shipped. RFC: Shipped.

| # | Chunk | Status | Depends on | Est. |
| --- | --- | --- | --- | --- |
| 01 | C-1 engine: extend strictest, fix 18 errors | done | [] | small |
| 02 | C-2 api: extend strictest, fix 27 errors | done | ['01-engine'] | medium |
| 03 | C-3 cli: extend strictest (already clean) | done | ['01-engine'] | small |
| 04 | C-4 Final build + 209 tests green | done | ['01-engine', '02-api', '03-cli'] | small |

Order: C-1 → C-2 / C-3 (parallel) → C-4.
