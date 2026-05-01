---
title: Why one runtime workflow
description: "openworkflow's frozen registry vs our need for dynamic workflows."
---

## The constraint

openworkflow's worker snapshots its workflow registry at
`worker.start()`. After the snapshot, you cannot register new
workflows without restarting. This is deliberate — it protects
deterministic replay across upgrades. A run that started on
`my-workflow@v1` must always replay against `my-workflow@v1`'s code,
regardless of what got registered later.

## The collision

Thodare's value proposition is "your LLM keeps inventing new
workflows; we keep them running." That's the opposite of "register at
boot, never register again."

## The resolution

Don't register one openworkflow workflow per Thodare workflow.
Register **exactly one**, named `wfkit-runtime`, whose input is
`{ workflow: SerializedWorkflow, input: unknown }`. Its body walks
the JSON using the same block executors as the static
`defineWorkflow().build({ ow }).register()` path:

```ts
// packages/engine/src/runner/runtime-workflow.ts (sketch)
ow.register("wfkit-runtime", async (step, { workflow, input }) => {
  const ctx = createRunContext(input);
  for (const block of topologicalOrder(workflow.blocks, workflow.connections)) {
    ctx.outputs[block.id] = await step.run(block.id, () =>
      executeBlock(block, ctx, blockRegistry)
    );
  }
  return { outputs: ctx.outputs };
});
```

Every Thodare workflow run is an instance of `wfkit-runtime` with a
different `workflow` input.

## What we lose

**Per-workflow isolation in `step_attempts`.** Every run is keyed
under one openworkflow workflow name (`wfkit-runtime`). If you
`SELECT * FROM step_attempts WHERE workflow_name = 'wfkit-runtime'`
you get every run across every Thodare workflow.

Mitigation: filter by `workflow_run_id`, which is per-run and uniquely
attributable. The `runs/:runId/logs` endpoint does exactly this.

## What we keep

- **Per-run durability.** Each step is one `step.run()` call; results
  cache in `step_attempts`; replay never re-executes.
- **Retries.** openworkflow's per-step retry policy applies normally.
- **Cancellation.** `step.run()` is interrupted on cancel.
- **Pauses.** `kind: "wait"` blocks dispatch directly to `step.sleep` /
  `step.waitForSignal`.
- **Cross-deploy safety.** A run started on rev A finishes on rev B
  because the workflow JSON is pinned in the run input. See
  [Pin-at-run-start](/thodare/explanation/pin-at-run-start/).

## The shared walker

Both the static path (`defineWorkflow().build({ ow })`) and the
dynamic runtime path use the SAME block-execution function (the
`walkWorkflow` in
[`runner/walk.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/src/runner/walk.ts)).
Sharing one walker means the static and dynamic paths cannot
diverge — every contract a static workflow honors, the runtime path
also honors.

## Implementation

[`packages/engine/src/runner/runtime-workflow.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/src/runner/runtime-workflow.ts) +
[`runner/walk.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/src/runner/walk.ts).

Tests:
[`tests/29.runtime-workflow.test.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/tests/29.runtime-workflow.test.ts).
