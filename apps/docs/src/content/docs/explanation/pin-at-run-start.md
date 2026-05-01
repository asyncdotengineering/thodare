---
title: Pin-at-run-start
description: "Why in-flight runs use the workflow JSON they started with, not the latest."
---

## The problem

The LLM patches a workflow at version N. A run dispatched at version N
is mid-flight (paused on a `wait_duration` block, say). The LLM
patches again to version N+1.

If the runtime *re-reads the workflow row* on every step, the
in-flight run would suddenly execute different blocks than it started
with. That breaks deterministic replay — openworkflow's cache assumes
step keys correspond to the same code. Different code with the same
step key = divergent replay = corrupted run state.

## The fix

When `POST /api/workflows/:id/run` dispatches, the API loads the
workflow JSON and passes it **as part of the run input**:

```ts
// packages/api/src/runtime-host.ts
async dispatch(workflow, input, opts) {
  return this.runtime.run(
    { workflow, input },     // ← JSON snapshotted here
    opts,
  );
}
```

The runtime workflow (`wfkit-runtime`, see
[the runtime page](/thodare/explanation/runtime-workflow/)) walks
**that specific JSON**, not whatever's currently in the database. A
later patch is invisible to the run.

## Cost

Each run carries the full workflow JSON in its `workflow_runs.input`
column. For our expected workflow sizes (≤50 blocks, ~10 KB JSON)
this is cheap.

If workflows grow to 1000+ blocks, store the JSON in a
content-addressed table (e.g., `workflow_snapshots(hash, workflow_jsonb)`)
and pass the hash in run input. The runtime then dereferences. We
haven't needed this yet.

## What about workflow ROW deletion?

`DELETE /api/workflows/:id` is a soft delete (sets `deleted_at`). The
row remains. In-flight runs that already snapshotted the JSON keep
running fine. Subsequent reads via the API return 404, but
`getInternalUnscoped` (used by the dispatcher tick) still finds it.

Hard deletion would orphan in-flight runs. We never hard-delete from
the workflows table.

## What about migration of the workflow JSON shape?

If `SerializedWorkflow.version` bumps from `1.0.0` to `2.0.0` with a
breaking change, in-flight runs on v1 should keep running on v1's
walker, and new runs use v2. Two patterns:

1. **Branch on `workflow.version` inside the walker.** Cheap; no
   ceremony.
2. **Register a v2 runtime workflow alongside v1.** Both
   `wfkit-runtime` and `wfkit-runtime-v2` exist; dispatch routes by
   JSON version. Heavier but cleaner.

We haven't crossed v1.0.0 yet. The hook is in `walkWorkflow` for when
we do.
