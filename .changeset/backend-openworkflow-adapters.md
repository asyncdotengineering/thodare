---
"@thodare/backend-openworkflow-pg": minor
"@thodare/backend-openworkflow-sqlite": minor
---

Phase 3 of v1 backend abstraction: ship the openworkflow adapter (Postgres + SQLite). First concrete `ThodareBackend` implementation that wraps the existing `@thodare/openworkflow` substrate. Both adapters declare conservative capabilities (no resume / recover / live-subscription / container-blocks; those land in Phase 5b) and pass the parameterized `runContractTests` suite for the packs they support.

Bumps `@thodare/backend-openworkflow-pg` and `@thodare/backend-openworkflow-sqlite` to `1.0.0-alpha.1`.
