# @thodare/engine — Architecture

Mental model in one diagram, then the layered breakdown, then the extension
points.

## Layered model

```
┌────────────────────────────────────────────────────────────┐
│ LAYER 0 — LLM (or any client)                              │
│   • Whatever model you use (Claude / OpenAI / local)       │
│   • Emits typed EditOp[] against the workflow JSON         │
└──────────────────┬─────────────────────────────────────────┘
                   │  HTTP (your route handler)
                   ▼
┌────────────────────────────────────────────────────────────┐
│ LAYER 1 — LLM-facing surface  (operations/apply.ts)        │
│   • visibility filter — strips 'hidden' params             │
│   • reference validation against declared block.outputs    │
│   • per-op skip semantics with typed reason_codes          │
│   • returns workflow + skipped + errors → the LLM repairs  │
└──────────────────┬─────────────────────────────────────────┘
                   │  validated SerializedWorkflow JSON
                   ▼
┌────────────────────────────────────────────────────────────┐
│ LAYER 2 — Block / Tool registries                          │
│   • Block: user-facing facade with ops dropdown            │
│   • Tool:  atomic implementation                           │
│   • visibility flag: 'user-or-llm' | 'user-only' | 'hidden'│
│   • declared outputs: enables ref validation               │
│   • kind: 'compute' | 'wait' | 'trigger'                   │
└──────────────────┬─────────────────────────────────────────┘
                   │
                   ├─────────────────┐
                   ▼                 ▼
┌──────────────────────────┐  ┌────────────────────────────────────────────┐
│ LAYER 3a — In-memory     │  │ LAYER 3b — Durable                          │
│ executor (dev)           │  │ executor (prod)                             │
│                          │  │                                             │
│ executor/executor.memory │  │ runner/openworkflow.ts                      │
│   • walks the DAG        │  │   • walks the SAME DAG                      │
│   • runs every block     │  │   • compute → step.run (memoized)           │
│     including waits      │  │   • wait_duration → step.sleep              │
│   • on __paused: stop    │  │   • wait_for_event → step.waitForSignal     │
│     and snapshot         │  │   • human_approval → step.waitForSignal     │
│   • resume(snapshot,     │  │   • crash recovery is openworkflow's job    │
│     payload) replays     │  │                                             │
│                          │  │ Backend: Postgres or SQLite                 │
└──────────────────────────┘  └────────────────────────────────────────────┘
```

## Why this composition matters

**Every layer is independent and testable.**

- Layer 1 is pure (workflow in → workflow + skips out). 4 vitest specs lock
  every guarantee.
- Layer 2 is data (registries + facades). Adding an integration is one
  declaration each side.
- Layer 3a is fast and offline (no SQLite spin-up). 6 of 14 tests run here.
- Layer 3b is durable. 7 of 14 tests run on real openworkflow with SQLite,
  including the crash-recovery proof and the multi-pause drip campaign.

The layer boundaries are also failure-isolation boundaries: if openworkflow
introduces a breaking change, only `runner/openworkflow.ts` changes. If we
swap to Inngest or Temporal, only that file is rewritten — wfkit's DSL is
untouched, the LLM repair loop is untouched, the tests for layers 0-3a still
run unchanged.

## Extension points

### Add a new compute integration (the 95% case)

```ts
// src/tools/your-integration.ts
export const yourTool: Tool = {
  id: "your_action",
  params: {
    apiKey: { type: "string", visibility: "hidden", required: true },
    arg:    { type: "string", visibility: "user-or-llm", required: true },
  },
  outputs: { result: { type: "object" } },
  async execute(p, ctx) { /* call SDK / API */ },
};

// src/blocks/your-integration.ts
export const yourBlock: Block = {
  type: "your_block",
  kind: "compute",
  category: "tools",
  subBlocks: [{ id: "arg", title: "Arg", type: "short-input", required: true }],
  outputs: { result: { type: "object" } },
  tools: { access: ["your_action"], config: { tool: () => "your_action" } },
};
```

Register both. Both executors pick it up automatically.

### Add a new wait shape

Define a Tool that returns `PauseInfo`. Define a Block with `kind: 'wait'`.
Then teach `runner/openworkflow.ts` how to dispatch your block type — add
one `case` to `runWaitBlock()`. This is the only place the durable runtime
is aware of new wait shapes.

### Add a new namespace to `{{ref}}` resolution

Implement the `Resolver` interface in `src/executor/resolver.ts`. Add it to
the chain in both executors. ~15 lines per namespace.

### Validate a new reason in `applyOperations`

`SkipReason` is a string union in `types.ts`. Add a case, throw it from the
relevant `applyXxx` function. The LLM gets the new reason in
`skipped_items[i].reason_code` automatically.

## What's not here, mapped to where it goes

| Future feature | Where it goes |
| --- | --- |
| `ai_generate_text` block (Vercel AI SDK) | `src/tools/ai.ts` + entry in `src/blocks/builtin.ts`. Custom block, ~30 LoC. |
| `expression` block (JSONata) | `src/tools/expression.ts` + block. Pure compute, no special handling. |
| `code_execute` block (`isolated-vm`) | `src/tools/code.ts`. Admin-gated via per-tenant ACL on `applyOperations`. |
| Loops / parallels | New `SerializedLoop` / `SerializedParallel` schemas in `types.ts`. New orchestrator in both executors. |
| HTTP API surface | `src/api/` Express/Hono routes. `applyOperations` + `buildDurableWorkflow` are pure functions; wrap them. |
| Trigger router (webhook / cron / event) | `src/triggers/`. All three feed the same `compiled.run(input)`. |
| RAG-based block discovery (`search_patterns`) | Outside this package. Tool the LLM calls; result feeds back into the same `applyOperations` loop. |

## Operational notes

- **`newWorker()` snapshots the registry**. Define your workflow via
  `buildDurableWorkflow()` BEFORE calling `worker.start()`, or runs sit
  pending forever. The `_durable-harness.ts` test util enforces this
  ordering for tests; production code should mirror it.
- **Step keys are derived from `block.id`**. Reordering blocks mid-run will
  break replay determinism. Bump `workflow.metadata.version` and let
  in-flight runs finish on the old version (Sim's pin-at-run-start pattern).
- **Compute blocks cannot pause**. Only `kind: 'wait'` blocks may suspend.
  This is not a limitation of wfkit's DSL — it's a requirement of any
  deterministic-replay runtime. wfkit's in-memory executor is the only
  place free-form `__paused` returns from arbitrary tools work.
- **`node:sqlite` is experimental in Node 22**. Use openworkflow's Postgres
  backend in production (`openworkflow/postgres`); SQLite is the dev
  convenience.
