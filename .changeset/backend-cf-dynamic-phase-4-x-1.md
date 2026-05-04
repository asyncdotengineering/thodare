---
"@thodare/backend-cloudflare-dynamic": patch
---

Fix definition column contract: defineWorkflow writes null (not placeholder JSON); add setWorkflowDefinition(name, version, json) method to CF adapter. Dispatcher throws clear error on null definition. runId is now a required field in ThodareMetadata (no silent fallback). Add [[workflows]] block to wrangler.test.jsonc. Export ThodareWorkflow from test worker for real CF Workflows engine dispatch in tests.
