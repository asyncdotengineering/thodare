---
issue: 04-publish-0.1.1
rfc: alpha-polish
chunk: C-4
status: done
depends_on: ['01-auto-org', '02-schedule-claim', '03-bootstrap-admin']
estimate: small
---

# C-4 — 0.1.1 changeset + publish

RFC: [`../README.md`](../README.md) §4

## Files

- .changeset/alpha-polish.md
- (manual) pnpm publish for affected packages

## Acceptance

1. Changeset describes auto-org + schedule-claim + bootstrap as `@thodare/api` patch.
2. `pnpm changeset version` bumps @thodare/api to 0.1.1.
3. `pnpm publish --filter @thodare/api` succeeds; npm registry shows 0.1.1.
4. Tag pushed to origin (v0.1.1 or per-package tag).

## Notes
