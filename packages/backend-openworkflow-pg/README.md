# @thodare/backend-openworkflow-pg

Postgres-backed `ThodareBackend` adapter — the **first concrete adapter** for the v1 backend abstraction.

Wraps `@thodare/openworkflow` with its Postgres substrate and exposes the `ThodareBackend` interface defined by `@thodare/backend@1.0.0-alpha.1`.

## Capability matrix

| Capability | Value | Notes |
|---|---|---|
| `maxStepDurationMs` | 1,800,000 | 30 minute default |
| `maxRunDurationMs` | `Number.MAX_SAFE_INTEGER` | Unbounded |
| `signalPrecision` | `"exact"` | Postgres-based signal delivery |
| `exactlyOnceSteps` | `true` | Openworkflow guarantee |
| `serverless` | `false` | Requires a persistent worker process |
| `pricingModel` | `"self-host"` | You run the infrastructure |
| `supportsLiveSubscription` | `false` | Deferred to Phase 5b |
| `supportsStepIOInspection` | `true` | `step_attempts` table is queryable |
| `supportsResumeFromStep` | `false` | Deferred to Phase 5b |
| `supportsRecover` | `false` | Deferred to Phase 5b |
| `liveSubscriptionLatencyMs` | `0` | N/A (unsupported) |
| `supportsRemovedTombstone` | `false` | Deferred to Phase 5b |
| `supportsContainerBlocks` | `false` | Deferred to Phase 5b |
| `supportsDynamicSchemas` | `false` | Deferred to Phase 5b |
| `supportsAwaitFirstBlockResult` | `false` | Deferred to Phase 5b |

## Usage

```ts
import { createBackendOpenworkflowPg } from "@thodare/backend-openworkflow-pg";

const backend = await createBackendOpenworkflowPg({
  pgUrl: "postgresql://localhost:5432/thodare",
  schema: "openworkflow",
});

// Use with the contract test suite:
import { runContractTests } from "@thodare/backend-contract-tests";
runContractTests(backend, { skip: ["headless-builder/resume-from-step", ...] });
```

## When to use PG vs SQLite

- **Postgres**: Production, multi-pod deployments. Connections via connection pool.
- **SQLite**: Local dev, single-binary CLI, `thodare dev` experience. See `@thodare/backend-openworkflow-sqlite`.

## Links

- [Backend abstraction proposal (Phase 3)](../../research/backend-abstraction-proposal.md#5-phase-3--openworkflow-adapter--1w)
- [Contract test suite](../../packages/backend-contract-tests/)
- [UPSTREAM.md (openworkflow vendor relationship)](../../packages/openworkflow/UPSTREAM.md)
