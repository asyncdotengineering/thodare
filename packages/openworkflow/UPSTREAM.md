# @thodare/openworkflow — relationship to upstream

This package is a **vendored fork** of [openworkflow](https://github.com/openworkflowdev/openworkflow),
distributed under the original Apache-2.0 license. We did not write the
core durable-execution engine. We did not invent step-replay, the
worker protocol, or the Postgres / SQLite backends. Those are entirely
the work of the openworkflow authors. We're a downstream layer that
picks the framework up and runs with it.

## Why we vendor

We forked rather than depending on `openworkflow` from npm directly because:

1. **Version pinning.** The Thodare control plane has tight integration
   points (the `wfkit-runtime` workflow walks JSON dynamically, see
   [`packages/engine/src/runner/runtime-workflow.ts`](../engine/src/runner/runtime-workflow.ts)).
   Pinning a specific upstream revision protects us from breaking
   changes during alpha.
2. **Patch capability.** When we hit a bug or need a Thodare-specific
   extension (e.g., extra metadata persisted on `step_attempts` for
   LLM observability), we can ship the fix immediately rather than wait
   on upstream review cycles.
3. **Brand surface.** Consumers of `@thodare/api` install one scope:
   `@thodare/*`. Mixing scopes (`openworkflow` + `@thodare/engine`)
   adds cognitive load when reading lockfiles and security scans.


## Sync point

| Field | Value |
|---|---|
| Upstream repo | https://github.com/openworkflowdev/openworkflow |
| Upstream package | `openworkflow` |
| Forked from version | `0.9.0` |
| Forked at commit | (initial vendor — see initial commit on this directory) |
| License preserved | `Apache-2.0` (see `LICENSE.md`, copied verbatim) |
| Last upstream sync | 2026-05-02 (initial vendor) |

When upstream ships a new release, we'll evaluate, sync the changes
(or cherry-pick), bump our `version`, and document it in `CHANGELOG.md`
under "Synced from upstream openworkflow vX.Y.Z".

## What we changed (delta from upstream 0.9.0)

The initial vendor preserves upstream verbatim apart from packaging:

- **`package.json`** — renamed to `@thodare/openworkflow`, repo URLs
  updated, peer-dep contract preserved, contributors field credits
  upstream and our scope.
- **`UPSTREAM.md`** (this file) — added.
- **`README.md`** — preserved upstream's content, with a one-paragraph
  Thodare-context preface.

No source-file changes from upstream apart from:

- **`internal.ts`** (Phase 3, 2026-05-03) — added re-exports for
  `WorkflowSpec`, `StepApi`, `WorkflowFunction`, `WorkflowFunctionParams`,
  `StepFunctionConfig`, `StepWaitTimeout`, and `RetryPolicy` from
  `core/workflow-function.ts` and `core/workflow-definition.ts`.
  These types are needed by the `@thodare/backend-openworkflow-*`
  adapter packages so they can implement the `ThodareBackend` interface
  against the vendored OpenWorkflow without importing private source
  files. No runtime behavior changes.

If we add further patches in the future, each will be documented here
with a one-line summary and a link to the commit.

## Apache-2.0 obligations

Per the license:

- ✅ The original `LICENSE.md` is included verbatim alongside the
  source.
- ✅ This `NOTICE` file documents the relationship and any modifications.
- ✅ The original copyright headers in source files (where present) are
  preserved.
- ✅ Modifications, when made, are clearly marked.

If you redistribute Thodare or any package that depends on
`@thodare/openworkflow`, the same license terms apply. See
[`LICENSE.md`](./LICENSE.md) for the full text.

## Star openworkflow

If you use Thodare in production, **please star
[openworkflowdev/openworkflow](https://github.com/openworkflowdev/openworkflow)**.
Maintaining a durable-execution framework is hard work that very few
people get right; the project deserves the recognition.
