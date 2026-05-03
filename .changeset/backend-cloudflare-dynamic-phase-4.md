---
"@thodare/backend-cloudflare-dynamic": minor
---

Phase 4: Initial alpha release of the Cloudflare Workflows GA adapter.

- `BackendCloudflareDynamic` implements `ThodareBackend` with `mode: "embedded"`
- D1-backed storage (events/runs/steps/hooks tables)
- `createCloudflareDispatcher` factory for CF dispatcher Worker composition
- `BackendCapabilities` with honest CF-specific flag values (17 flags)
- `defineWorkflow` / `runWorkflow` persist to D1 and dispatch via `wrapWorkflowBinding`
- `signal` / `cancel` delegate to CF Workflows `sendEvent` / `terminate`
- `resumeFromStep` / `recover` throw `not_implemented` (capabilities declare `false`)
- Streams throw `not_implemented` (queued for Phase 4.x)
- Runtime walker bundle stubbed with clear `not_implemented` (queued for Phase 4.x)
