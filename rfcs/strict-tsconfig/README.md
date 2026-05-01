---
slug: strict-tsconfig
status: Shipped
shape: B
created: 2026-05-02
---

# RFC: adopt @tsconfig/strictest workspace-wide

`@thodare/openworkflow` (vendored from upstream) compiles under
`@tsconfig/strictest + @tsconfig/node22`. The other workspace packages
(engine, api, cli, docs) currently use a looser hand-rolled tsconfig.
This RFC aligns them.

## §1 Goals

1. Every TS package extends the workspace-root `tsconfig.base.json`
   (which already extends `@tsconfig/strictest` + `@tsconfig/node22`).
2. All errors surfaced by the upgrade are **fixed at the source level**.
   No `as any`, no `// @ts-ignore`, no per-package opt-outs.
3. All 209 tests still green.

## §2 Non-goals

- No behaviour change. These flags are compile-time-only.
- No runtime perf change.
- No public-API change. Type signatures may tighten (e.g. `field?: T`
  becomes `field?: T | undefined` where appropriate), but published
  consumers don't notice.

## §3 Background

Probe results (running `tsc --noEmit` against each package with
`extends: ../../tsconfig.base.json`):

| Package | Errors | Dominant rule |
|---|---|---|
| `@thodare/engine` | 18 | `TS2375` / `TS2379` (`exactOptionalPropertyTypes`) |
| `@thodare/api` | 27 | Same, plus `noUncheckedIndexedAccess` (`TS2532`) |
| `@thodare/cli` | 0 | already passes |
| `@thodare/openworkflow` | 0 | already shipped under it |
| `@thodare/docs` | n/a | Astro project, not a TS lib build |

`exactOptionalPropertyTypes` is the dominant rule. It says: if a type
declares `field?: T`, you may NOT pass `field: undefined` — you must
omit the property. The fix is either:

  - At the type level: change the field to `field?: T | undefined`
    (the explicit form makes both `undefined` and omission valid).
  - At the call site: use `...(value !== undefined ? { field: value } : {})`
    so the property is genuinely omitted when undefined.

We prefer the type-level fix (one-line types/touch, vs. spread
acrobatics at every call site).

## §4 Interface specification

### 4a. Workspace tsconfig.base.json

Already exists from phase-l. Mirrors upstream openworkflow's
`tsconfig.base.json` exactly:

```json
{
  "extends": [
    "@tsconfig/strictest/tsconfig.json",
    "@tsconfig/node22/tsconfig.json"
  ],
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "types": ["node"]
  }
}
```

### 4b. Per-package tsconfig

Each package's `tsconfig.json` becomes:

```json
{
  "extends": ["../../tsconfig.base.json"],
  "compilerOptions": {
    "outDir": "dist",
    "composite": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests", "examples"]
}
```

`composite: false` avoids the project-references machinery (we don't
need cross-package incremental builds for this scale yet).
`declarationMap: false` and `sourceMap: false` keep the published
tarballs clean of `.d.ts.map` and `.js.map` files.

## §5 Constraints

- **Tests stay green throughout.** No commit lands until 209/209 pass.
- **No `as any` / `@ts-ignore`.** If the only fix would be a cast,
  prefer a type-definition tweak (widen optional fields with explicit
  `| undefined`).
- **Atomic per-package commits.** engine, api, cli each get their own
  commit so blame and bisect stay clean.

## §6 Risks

1. **Type widening is observable to consumers.** Changing `field?: T`
   to `field?: T | undefined` is a semantic widen — callers can now
   pass `field: undefined`. For our alpha consumers this is fine; if
   we ever need to tighten, we'll bump major.
2. **Hidden index-signature uses.** `noUncheckedIndexedAccess` may
   surface places where we read from `Record<string, unknown>` without
   a guard. The fix is a real safety improvement, not a hack.
3. **Vitest config might also need updates.** Vitest reads the package
   tsconfig for type-checking; a stricter config could make tests fail
   if test-only code violates rules. Tests live outside `include`, so
   this is unlikely, but we'll verify.

## §7 Test budget

No new tests. The migration is purely compile-time strictness. Existing
209 tests are the regression net.

## §8 Tasks (chunks)

| # | Chunk | Files | Estimate | Depends |
|---|---|---|---|---|
| C-1 | engine: extend strictest, fix 18 errors | `packages/engine/{tsconfig.json,src/types.ts,src/executor/*,src/runner/*,src/tools/*}` | small | — |
| C-2 | api: extend strictest, fix 27 errors | `packages/api/{tsconfig.json,src/**/*}` | medium | C-1 |
| C-3 | cli: extend strictest (no fixes needed) | `packages/cli/tsconfig.json` | small | C-1 |
| C-4 | Build all + tests green + commit | (verification) | small | C-1, C-2, C-3 |

## §9 Hard stops

- Three TDD failures on a single chunk → write `HALT.md`.
- Any required fix cannot be made without `as any` → revert that file
  and document why; do not bypass strictness.
- Test count drops below 209 → root-cause; do not commit.
