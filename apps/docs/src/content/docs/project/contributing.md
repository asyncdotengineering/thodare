---
title: Contributing
description: "How to file an issue, run the test suite, and ship a PR."
---

## Quick orientation

- Repo: [asyncdotengineering/thodare](https://github.com/asyncdotengineering/thodare)
- License: MIT (the workspace) + Apache-2.0 (vendored openworkflow)
- Status: alpha. APIs shift; tests are the regression net.

## Set up

```sh
git clone https://github.com/asyncdotengineering/thodare.git
cd thodare

# One-time: a Postgres reachable for tests.
createdb wfkit_durable_test
# Override with $WFKIT_DURABLE_PG_URL if needed.

pnpm install
pnpm test         # 209 tests, ~140s
```

Requires Node 22+ and pnpm 10+.

## Where things live

```
thodare/
├── apps/docs/                this site (Astro + Starlight)
├── packages/
│   ├── openworkflow/         vendored (Apache-2.0); see UPSTREAM.md
│   ├── engine/               @thodare/engine
│   ├── api/                  @thodare/api
│   └── cli/                  @thodare/cli
├── examples/                 runnable examples
└── tsconfig.base.json        strictest + node22 (all packages extend)
```

## Making a change

1. Open an issue describing the problem before opening a PR. Saves us
   both from "the implementation works but the design isn't right."
2. Branch off `main`. One topic per PR.
3. Write the test first if you can. The codebase is test-led.
4. `pnpm test` clean before pushing. CI re-runs everything.
5. Add a Changeset (`pnpm changeset`) describing the change at the
   right semver level.
6. Open the PR. Squash-merge is the default.

## Style

- TypeScript, strict (`@tsconfig/strictest`).
- No `as any`, no `// @ts-ignore`. Type widening (`field?: T |
  undefined`) is also a no — fix at the call site with conditional
  spreads. See the
  [strict-tsconfig RFC](https://github.com/asyncdotengineering/thodare/blob/main/rfcs/strict-tsconfig/README.md)
  for the rationale.
- One concern per file. Files over 400 LoC usually want splitting.
- Tests through public interfaces; mocks at the system boundary
  only.

## RFC discipline

Bigger changes — new package, breaking interface, new auth surface —
go through an RFC in `rfcs/<slug>/`. Each RFC is a Markdown file with
sections: Goals, Non-goals, Background, Interface, Constraints, Risks,
Test budget, Tasks. See existing RFCs for the shape.

## Vendored openworkflow

`packages/openworkflow/` is a verbatim fork of upstream Apache-2.0
source. **Don't patch its source files** unless you're syncing from
upstream or fixing a real bug. If you do, document the change in
[`UPSTREAM.md`](https://github.com/asyncdotengineering/thodare/blob/main/packages/openworkflow/UPSTREAM.md).

## Code of conduct

Be kind. Don't be a tool. We follow the
[Contributor Covenant](https://www.contributor-covenant.org/) implicitly.

## Security

For security issues, email `security@thodare.dev` or use GitHub
Security Advisories. **Don't open public issues for security bugs.**
