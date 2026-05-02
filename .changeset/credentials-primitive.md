---
"@thodare/engine": minor
"@thodare/api": minor
---

Phase 2 of v1 backend abstraction: Credentials primitive (per `research/backend-abstraction-proposal.md` §3.5).

Engine ships AES-256-GCM helpers + per-org HKDF derivation + `defineConnector({ credential })` extension + `ToolContext.credential` injection. API ships CRUD endpoints (`/api/credentials`), an encrypt-at-rest store (`workflow.credentials` table), and runtime-host credential resolution scoped by `organization_id` (T11). Workflow JSON references credentials by id only — secrets never reach the LLM, never appear in API responses, never log.

Bumps `@thodare/engine` and `@thodare/api` for v1 Alpha.
