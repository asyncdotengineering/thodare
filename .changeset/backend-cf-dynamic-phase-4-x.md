---
"@thodare/backend-cloudflare-dynamic": minor
"@thodare/engine": patch
---

Phase 4.x: runtime walker + DO/WS live subscription for @thodare/backend-cloudflare-dynamic

- `loadRunner` no longer throws; walks workflow JSON via @thodare/engine's walkWorkflow
- New `cf-step-shim.ts` wraps CF Workflows step → engine-shaped step, writing step rows + lifecycle events to D1 scoped by organization_id
- New `LogSession` Durable Object class with WebSocket fan-out + DO storage persistence
- `BackendCloudflareDynamic.streams.*` wired through `env.LOG_SESSION`
- Capabilities flipped: `supportsStepIOInspection: true`, `supportsLiveSubscription: true`, `liveSubscriptionLatencyMs: 200`
- @thodare/engine gains `walkWorkflow` public export and `./walk` / `./registry` subpath exports
