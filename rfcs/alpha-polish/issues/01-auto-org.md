---
issue: 01-auto-org
rfc: alpha-polish
chunk: C-1
status: done
depends_on: []
estimate: small
---

# C-1 — Auto-create personal org on user signup

RFC: [`../README.md`](../README.md) §4

## Files

- packages/api/src/auth.ts (databaseHooks)
- packages/api/tests/_harness.ts (simplify bootstrapTenant)
- packages/api/tests/07.auto-org.test.ts

## Acceptance

1. After `POST /api/auth/sign-up/email`, the user has exactly one membership in `member` table for an org named after their email.
2. The user's session has activeOrganizationId set to that org.
3. The harness's bootstrapTenant flow simplifies: no more explicit organization/create + set-active calls.
4. All 43 existing api tests still pass.
5. Hook errors don't fail signup — user is still created if org-create throws.

## Notes
