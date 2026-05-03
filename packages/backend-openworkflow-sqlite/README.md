# @thodare/backend-openworkflow-sqlite

SQLite-backed `ThodareBackend` adapter for local development and single-binary deployments.

Wraps `@thodare/openworkflow` with its SQLite substrate. Shares the same architecture as the Postgres adapter (`@thodare/backend-openworkflow-pg`) but uses file-based or in-memory SQLite.

## Capability matrix

Same as the PG adapter with one difference: `pricingModel` is `"self-host"` and `exactlyOnceSteps` reflects the SQLite durability model (file-backed WAL journal mode).

| Capability | Value |
|---|---|
| `maxStepDurationMs` | 1,800,000 |
| `maxRunDurationMs` | `Number.MAX_SAFE_INTEGER` |
| `signalPrecision` | `"exact"` |
| `exactlyOnceSteps` | `true` |
| `serverless` | `false` |
| `pricingModel` | `"self-host"` |
| `supportsStepIOInspection` | `true` |
| *(all Phase 5b features)* | `false` |

## Usage

```ts
import { createBackendOpenworkflowSqlite } from "@thodare/backend-openworkflow-sqlite";

// In-memory (for tests):
const mem = createBackendOpenworkflowSqlite();

// File-backed (for local dev):
const file = createBackendOpenworkflowSqlite({
  path: "./thodare.db",
});
```

## Links

- [Backend abstraction proposal (Phase 3)](../../research/backend-abstraction-proposal.md#5-phase-3--openworkflow-adapter--1w)
- [PG adapter](../../packages/backend-openworkflow-pg/)
