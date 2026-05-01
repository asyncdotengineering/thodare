---
issue: 02-api
rfc: strict-tsconfig
chunk: C-2
status: done
depends_on: ['01-engine']
estimate: medium
---

# C-2 — api: extend strictest, fix 27 errors

RFC: [`../README.md`](../README.md) §4

## Files

- packages/api/tsconfig.json
- packages/api/src/**/*.ts (as needed)

## Acceptance

1. `pnpm --filter @thodare/api exec tsc -p tsconfig.json --noEmit` → 0 errors.
2. `pnpm --filter @thodare/api run test` → 56 passed.
3. No casts/ignores introduced.
4. Build emits dist/ with no .map files.

## Notes
