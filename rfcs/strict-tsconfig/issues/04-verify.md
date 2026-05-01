---
issue: 04-verify
rfc: strict-tsconfig
chunk: C-4
status: done
depends_on: ['01-engine', '02-api', '03-cli']
estimate: small
---

# C-4 — Final build + 209 tests green

RFC: [`../README.md`](../README.md) §4

## Files

- (verification only — no code changes)

## Acceptance

1. `pnpm -r run build` → all packages build clean.
2. `find packages/*/dist -name '*.map'` → empty.
3. engine 117 + api 56 + cli 36 = 209 tests still green.

## Notes
