---
title: OpenWorkflow adapter (Phase 3)
description: "The first concrete ThodareBackend adapter — wraps the vendored openworkflow substrate and proves the backend abstraction."
---

The `@thodare/backend-openworkflow-pg` and `@thodare/backend-openworkflow-sqlite`
packages are the **first concrete adapters** implementing the
`ThodareBackend` interface from `@thodare/backend@1.0.0-alpha.1`.

They wrap the vendored `@thodare/openworkflow` substrate and expose
the canonical backend surface: workflow verbs (`defineWorkflow`,
`runWorkflow`, `signal`, `cancel`), the event-sourced storage layer
(`events.create` → `runs.get` / `steps.list`), and an embedded queue
mode.

## Why two adapters

- **Postgres** (`backend-openworkflow-pg`) — production, multi-pod,
  connection-pooled. Runs the full parameterized contract suite against
  a real Postgres database with per-test schema isolation.
- **SQLite** (`backend-openworkflow-sqlite`) — local dev, `thodare dev`,
  in-memory tests. Runs the same contract suite against a file-backed
  SQLite database.

Both adapters declare the **same conservative capability matrix**:
what the openworkflow substrate actually provides today. Phase 5b
features (resume-from-step, recover, live subscription, container
blocks, dynamic schemas) are declared `false` and their contract packs
are explicitly skipped.

## Capability matrix

| Flag | Value | Why |
|---|---|---|
| `exactlyOnceSteps` | `true` | Openworkflow isolates step replays per run |
| `signalPrecision` | `"exact"` | Postgres/SQLite signal delivery is synchronous |
| `supportsStepIOInspection` | `true` | `step_attempts` table exposes input/output per step |
| `supportsResumeFromStep` | `false` | Rivet-pattern; deferred to Phase 5b |
| `supportsRecover` | `false` | Deferred to Phase 5b |
| `supportsLiveSubscription` | `false` | LISTEN/NOTIFY lands in Phase 5+ |
| `supportsContainerBlocks` | `false` | Sub-workflow nesting is Phase 5b |
| `supportsDynamicSchemas` | `false` | Phase 5b |
| `supportsAwaitFirstBlockResult` | `false` | Phase 5b |
| `supportsRemovedTombstone` | `false` | Graph-migration primitives deferred |

## Architecture

Both adapters follow the same pattern:

1. **Wrap the substrate** — create `BackendPostgres` / `BackendSqlite`
   and an `OpenWorkflow` client on top.
2. **Bridge the handler** — `defineWorkflow` wraps the `ThodareHandler`
   in a bridge function that creates a `ThodareCtx` on each run,
   delegates durable steps to openworkflow's `StepApi`, and writes
   events to a companion `events` table.
3. **Materialize views** — `events.create` writes to the `events` table;
   `runs.get` / `steps.list` read directly from openworkflow's
   `workflow_runs` and `step_attempts` tables.
4. **Embedded queue** — `mode: "embedded"`; no HTTP loopback for queuing.

## Contract test coverage

The adapter passes **31 of 37 contract packs**. The six skipped packs
are all gated by Phase 5b capability flags (tombstone-replay,
resume-from-step, recover, live-subscription, container-blocks,
dynamic-schemas, sync-block-result, and mode-specific push/pull packs
that don't apply to embedded mode).

## Links

- [Backend abstraction proposal §5 (Phase 3)](../../research/backend-abstraction-proposal.md)
- [`@thodare/backend` package](../../packages/backend/)
- [`@thodare/backend-contract-tests`](../../packages/backend-contract-tests/)
- [OpenWorkflow upstream relationship](../../packages/openworkflow/UPSTREAM.md)
