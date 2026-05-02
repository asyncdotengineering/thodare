# Phase 2 Scratchpad

## Plan
1. Engine: credentials/types.ts, credentials/crypto.ts, credentials/index.ts
2. Engine: modify types.ts, connector.ts, walk.ts, runtime-workflow.ts, client.ts, index.ts
3. API: store/credentials.ts, routes/credentials.ts, modify server.ts, runtime-host.ts, index.ts
4. Tests: engine crypto tests, API credential tests
5. Docs: explanation/credentials.md, how-to/manage-credentials.md
6. Changeset

## Key decisions
- CredentialId is allowed through filterParams when block's tool has credential binding (expand SkipReason)
- resolveCredential goes through WalkOptions → BuildRuntimeWorkflowOptions
- organizationId travels via runtime input { workflow, input, organizationId }
- credential type matching happens in walkWorkflow
