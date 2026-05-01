---
issue: 01-engine
rfc: strict-tsconfig
chunk: C-1
status: done
depends_on: []
estimate: small
---

# C-1 — engine: extend strictest, fix 18 errors

RFC: [`../README.md`](../README.md) §4

## Files

- packages/engine/tsconfig.json (extend ../../tsconfig.base.json)
- packages/engine/src/types.ts (widen optional fields)
- packages/engine/src/executor/executor.memory.ts
- packages/engine/src/runner/handle.ts
- packages/engine/src/runner/openworkflow.ts
- packages/engine/src/runner/runtime-workflow.ts
- packages/engine/src/runner/webhooks.ts
- packages/engine/src/tools/builtin.ts

## Acceptance

1. `pnpm --filter @thodare/engine exec tsc -p tsconfig.json --noEmit` → 0 errors.
2. `pnpm --filter @thodare/engine run test` → 117 passed.
3. No `as any` or `// @ts-ignore` introduced (grep clean).
4. Build emits dist/ with no .map files.

## Notes
