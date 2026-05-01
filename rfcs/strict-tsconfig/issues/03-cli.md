---
issue: 03-cli
rfc: strict-tsconfig
chunk: C-3
status: done
depends_on: ['01-engine']
estimate: small
---

# C-3 — cli: extend strictest (already clean)

RFC: [`../README.md`](../README.md) §4

## Files

- packages/cli/tsconfig.json

## Acceptance

1. tsconfig extends ../../tsconfig.base.json.
2. `pnpm --filter @thodare/cli exec tsc -p tsconfig.json --noEmit` → 0 errors.
3. `pnpm --filter @thodare/cli run test` → 36 passed.

## Notes
