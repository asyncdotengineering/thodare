---
"@thodare/backend": minor
"@thodare/backend-contract-tests": minor
---

Phase 1 of the backend abstraction (v1 release): pure types + parameterized contract test suite.

Ships `@thodare/backend@1.0.0-alpha.1` (`ThodareBackend` / `Storage` / `Queue` / `Streamer` / `BackendCapabilities` / `ThodareStep` / branded `SpecVersion`) and `@thodare/backend-contract-tests@1.0.0-alpha.1` (`runContractTests(backend, options?)` covering 37 packs from `research/backend-abstraction-proposal.md` §3.7). No runtime, no adapter implementation — Phase 3 wraps openworkflow as the first concrete adapter.
