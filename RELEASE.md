# RELEASE.md

How features ship from `main` to production npm.

> **Status as of 2026-05-02.** Solo project, no customers yet. Discipline is right-sized for that. When Thodare gains traction this doc grows; today it stays minimal.

## Two stages — Alpha → GA

A feature ships in **two stages**. There is no Beta, no per-feature env-var gates, no per-org toggles. The discipline is: merge → alpha tag → dogfood → cut a real release.

### Stage 1 — Alpha

The feature lives in `main` immediately after merge. Released to npm on `1.0.0-alpha.N` versions tagged `alpha` (`pnpm publish --tag alpha`). **Anyone curious can `npm install @thodare/<pkg>@alpha` and try it.** No closed pre-release; no private channel. Build in public.

**Gates to merge into `main` (= reach Alpha):**

- [ ] `pnpm test` workspace-wide green (~280 tests at v1)
- [ ] `tsc --noEmit -p packages/<pkg>/tsconfig.json` clean — no `as any`, no `@ts-ignore`, no widening to defeat `exactOptionalPropertyTypes` (per T16/T17)
- [ ] New tests added: 4–10 per change (per `.internal/HANDOFF.md`'s "tests first" rule)
- [ ] `@thodare/backend-contract-tests` green on every adapter the feature touches — OR adapters honestly declare `capabilities.supportsX === false` and pass the "skip when unsupported" path
- [ ] Changeset added (`pnpm changeset`) at the right semver level
- [ ] Documentation drafted in the right Diataxis quadrant (per T18)
- [ ] PR self-reviewed (or one other reviewer if a co-maintainer exists)

That is the entire pre-merge bar. The feature is live the moment it lands.

### Stage 2 — GA (cut a real release)

When dogfooding shows the feature works without surprise:

```sh
pnpm changeset version       # Changesets computes the bump
pnpm build && pnpm test      # final green
pnpm release                 # build + changeset publish (per package.json)
git push --follow-tags       # publish the tag
```

**Gates to GA (= reach `latest` dist-tag):**

- [ ] The feature has been on the `alpha` dist-tag for ≥1 dogfooding cycle on real personal usage. "Cycle" means: long enough for the failure modes you care about to have surfaced (a workflow you wrote that takes 3 days to run completes; a webhook resume happens; a sleep wakes correctly).
- [ ] Contract tests stay green.
- [ ] You used it yourself without surprise.

That is the entire process. **Promotion is a judgment call** — no SLA thresholds, no customer-adoption counts, no error-rate gates. You are the release manager and the customer.

## Versioning policy — semver + Changesets, transparent

- **Today (2026-05-02):** alpha at `0.1.x`. SPEC §1 commits to "alpha 0.1.x" framing.
- **Next stable:** `1.0.0` — ships everything in `research/backend-abstraction-proposal.md`.
- **Between now and 1.0.0:** alpha tags published to npm under `alpha` dist-tag. `1.0.0-alpha.1`, `1.0.0-alpha.2`, etc. Changesets accumulate; bumps happen at the alpha cadence.
- **After 1.0.0:** `1.x.y` minor + patches per Changesets. `2.0.0` only on breaking changes (per [semver.org](https://semver.org)).

Each alpha tag is git-tagged, npm-published under `alpha`, and reflected in `CHANGELOG.md`. The world can watch you build.

## What stays the same as the existing discipline

The existing T1–T19 in `SPEC.md` are unchanged. T15 (pnpm monorepo + Changesets) is the canonical version-management mechanism; this doc just makes the alpha-tag flow explicit. T16 + T17 (strict TS) are pre-merge gates. T18 (Diataxis docs) is documentation discipline.

The contract-test suite (`@thodare/backend-contract-tests`, designed in `research/backend-abstraction-proposal.md` §3.7) is the cross-adapter gate. A new feature must pass on every adapter it touches — or be honest that it doesn't.

**Capability flags** (`BackendCapabilities` per proposal §3) are NOT feature flags in the gating sense. They're **interface declarations** — the adapter telling clients what it can do. Frontends gate UI affordances on them (per `research/developer-blueprint.md` §5.3). They stay; we just don't add new ones for "is this feature enabled."

## Per-feature rollback note

Every significant feature ships with a one-paragraph rollback note in its docs page:

> **If this breaks for you:** revert your workflow JSON to the pre-feature shape, OR downgrade `@thodare/<pkg>@<prior-version>`. The capability flag (`supportsX`) auto-disables the related UI affordances if the adapter version doesn't support the feature.

That's it. Not a multi-section runbook. Useful for solo-on-call at 11pm.

## When this doc grows

Add gates in this order as Thodare gains traction:

1. **First external user** — add a single Beta stage with a 2-week soak window between Alpha and GA.
2. **First paid customer** — add per-feature env-var gating (so a customer can opt out without pinning a version).
3. **Multi-customer scale** — add SLA-based promotion thresholds (error rate, latency).
4. **Dedicated on-call** — expand the rollback note into a multi-section runbook per significant feature.

Today is none of those. Don't pre-pay for them.
