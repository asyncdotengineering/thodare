---
issue: 03-bootstrap-admin
rfc: alpha-polish
chunk: C-3
status: done
depends_on: ['01-auto-org']
estimate: small
---

# C-3 — First-run admin bootstrap (one-time signed link)

RFC: [`../README.md`](../README.md) §4

## Files

- packages/api/src/bootstrap.ts (route + token computation)
- packages/api/src/server.ts (mount + startup probe)
- packages/api/tests/09.bootstrap.test.ts

## Acceptance

1. With THODARE_BOOTSTRAP=1 and user table empty: server logs `🔓 First-run bootstrap link: <baseURL>/api/bootstrap?token=…` to stderr at startup.
2. GET /api/bootstrap?token=<correct> with empty user table → 200 with { email, password, apiKey, organizationId, organizationSlug }; subsequent identical call → 404 (user table no longer empty).
3. GET /api/bootstrap?token=<wrong> → 401.
4. Without THODARE_BOOTSTRAP=1 → /api/bootstrap returns 404 even with empty DB.
5. With THODARE_BOOTSTRAP=1 but user table non-empty at boot → no log, no route mounted.

## Notes
