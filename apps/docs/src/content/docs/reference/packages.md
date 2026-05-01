---
title: Package map
description: "Every published package, what it does, what depends on what."
---

| Package | Purpose | Deps |
|---|---|---|
| **`@thodare/openworkflow`** | Vendored fork of [openworkflow](https://github.com/openworkflowdev/openworkflow) (Apache-2.0). Durable execution substrate. | `postgres` (peer) |
| **`@thodare/engine`** | Connector-shaped DSL, `EditOp` patch model, `kind: 'wait'` blocks, `withTracing`, `createWebhookRouter`. | `@thodare/openworkflow`, `postgres`, `zod` |
| **`@thodare/api`** | Hono HTTP control plane. Workflows / runs / schedules / webhooks routes. better-auth + organizations + apiKey. Per-`(org, principal)` rate limit. | `@thodare/engine`, `better-auth`, `@better-auth/api-key`, `hono`, `pg`, `postgres`, `zod` |
| **`@thodare/cli`** | `thodare login / token / env / whoami / logout / key {create,list,revoke}`. Zero deps; uses Node built-ins. | (none) |
| **`@thodare/docs`** | Astro + Starlight documentation site (this site). | `astro`, `@astrojs/starlight` |

## Dependency graph

```
@thodare/cli
        │ (devDep — for tests only)
        ▼
@thodare/api ─── @thodare/openworkflow (vendored)
        │
        ▼
@thodare/engine ─ @thodare/openworkflow
```

Runtime: `cli` ships with no deps. `api` depends on `engine` which
depends on `@thodare/openworkflow`. The vendored fork is the leaf.

## Versioning

Each package versions independently via Changesets. Patches don't
roll forward — `@thodare/engine@0.1.1` can ship while `@thodare/api`
stays at `0.1.0`, as long as no breaking change crosses the boundary.

## Source layout

```
thodare/
├── packages/
│   ├── openworkflow/    @thodare/openworkflow (vendored from upstream)
│   ├── engine/          @thodare/engine
│   ├── api/             @thodare/api
│   ├── cli/             @thodare/cli
│   └── docs/            @thodare/docs (this site)
├── examples/            runnable examples (this site fetches from here)
└── tsconfig.base.json   strictest + node22 (mirrors upstream openworkflow)
```

## Next

- [HTTP routes](/thodare/reference/routes/) — the api surface.
- [CLI commands](/thodare/reference/cli/) — every verb.
