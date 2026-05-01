<div align="center">
  <img src="./apps/docs/src/assets/thodare-mascot.png" width="200" alt="Thodare mascot — chibi character holding a chain of workflow blocks">

# Thodare

**Typed, durable workflows for AI-driven internal ops.**

[![alpha](https://img.shields.io/badge/status-alpha-orange)](#)
[![npm @thodare/engine](https://img.shields.io/npm/v/@thodare/engine?label=%40thodare%2Fengine)](https://www.npmjs.com/package/@thodare/engine)
[![npm @thodare/api](https://img.shields.io/npm/v/@thodare/api?label=%40thodare%2Fapi)](https://www.npmjs.com/package/@thodare/api)
[![npm @thodare/cli](https://img.shields.io/npm/v/@thodare/cli?label=%40thodare%2Fcli)](https://www.npmjs.com/package/@thodare/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

</div>

> 🔥 **Straight out of the oven.** Active development, alpha-grade. Things will break, signatures will change. Star the repo and yell at us in [Issues](https://github.com/asyncdotengineering/thodare/issues) when they do.

Connector-shaped DSL + an LLM-native patch surface that explains its own failures, executed on
[openworkflow](https://github.com/openworkflowdev/openworkflow)'s Postgres-durable runtime.
Multi-tenant from day one ([better-auth](https://www.better-auth.com) organizations + API keys).

The name **Thodare** ([toh-DA-REE]) carries the Tamil **தொடர்** (*thodar*) — *chain, sequence,
continuity*. A workflow IS a thodar.

---

## Install

```sh
# the engine — DSL + durable runtime
npm install @thodare/engine

# the HTTP control plane (Hono app you mount on Bun / Node / Workers)
npm install @thodare/api

# the CLI for first-time setup + key management
npm install -g @thodare/cli
```

## 60-second quickstart

```sh
# 1. Run @thodare/api somewhere reachable. (See packages/api/README.md.)
#    For local dev, the Postgres-backed example boots in <1s.

# 2. Sign in / sign up + mint an API key. One command.
thodare login --api http://localhost:3000

# 3. The key is saved in ~/.thodare/credentials.json.
curl -H "Authorization: Bearer $(thodare token)" \
     http://localhost:3000/api/connectors

# 4. Patch a workflow with EditOp[]. Bad ops come back as `skipped_items[]`
#    you feed straight to your LLM as tool output.
curl -X POST http://localhost:3000/api/workflows/<id>/operations \
     -H "Authorization: Bearer $(thodare token)" \
     -H 'content-type: application/json' \
     -d '{"ops":[
        {"operation_type":"add","block_id":"trg","type":"trigger_webhook","params":{}},
        {"operation_type":"add","block_id":"n","type":"slack","params":{"channel":"#x","text":"hi"}},
        {"operation_type":"connect","block_id":"trg","target_block_id":"n"}
     ]}'

# 5. Run it.
curl -X POST http://localhost:3000/api/workflows/<id>/run \
     -H "Authorization: Bearer $(thodare token)" \
     -H 'content-type: application/json' \
     -d '{"input":{"hello":"world"}}'
```

Full guide: [thodare.dev](https://thodare.dev) (or `pnpm --filter @thodare/docs dev` to read locally).

## Why Thodare

| You need… | Thodare? |
|---|---|
| Workflows the LLM can build, edit, run, and read back | ✅ |
| Multi-step pipelines that survive deploys, crashes, restarts | ✅ |
| Cron triggers, webhook ingestion, signal-driven waits | ✅ |
| Multi-tenant SaaS (orgs, members, API keys per org) | ✅ |
| Typed skips on bad LLM ops — *feedable as tool output* | ✅ |
| Fire-and-forget pub/sub | Use a queue |
| Streaming data pipelines | Wrong tool |

The patch endpoint is the load-bearing piece. **Bad ops are skipped, not rejected.** The response
carries `{ ok, version, skipped_items, summary }` — every field is feedable directly back to the
LLM. That's why single-shot LLM workflow construction works: the API doesn't reject the LLM, it
*explains* what's wrong.

## Packages

| Package | npm | Purpose |
|---|---|---|
| [`@thodare/engine`](./packages/engine) | [![npm](https://img.shields.io/npm/v/@thodare/engine)](https://www.npmjs.com/package/@thodare/engine) | Workflow runtime, EditOp model, durable runs. |
| [`@thodare/api`](./packages/api) | [![npm](https://img.shields.io/npm/v/@thodare/api)](https://www.npmjs.com/package/@thodare/api) | HTTP control plane (Hono). Workflows CRUD, runs, schedules, webhooks, auth. |
| [`@thodare/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@thodare/cli)](https://www.npmjs.com/package/@thodare/cli) | Command-line client (login, token, env, key). |
| [`@thodare/docs`](./apps/docs) | — | Astro + Starlight documentation site. |

## Develop

```sh
git clone https://github.com/asyncdotengineering/thodare.git
cd thodare

# One-time: a Postgres database the tests can write to.
createdb wfkit_durable_test

pnpm install
pnpm test                  # 196 tests: 117 engine + 43 api + 36 cli
pnpm --filter @thodare/docs dev   # docs at http://localhost:4321
```

Requires Node 22+ (native `fetch`, `node:sqlite`) and a local Postgres reachable at
`postgresql://localhost:5432/wfkit_durable_test`. Override with `WFKIT_DURABLE_PG_URL`.

## Status

- 🟠 **Alpha.** Active development. APIs may shift between minor versions.
- 🟢 **Tests pass.** 196 across the workspace.
- 🔴 **Production?** Not yet. Run it in staging; report what breaks.

Issues, PRs, ideas: [github.com/asyncdotengineering/thodare](https://github.com/asyncdotengineering/thodare).

## Built on the work of

- **[openworkflow](https://github.com/openworkflowdev/openworkflow)** ([Apache-2.0](https://github.com/openworkflowdev/openworkflow/blob/main/LICENSE)) — the durable-execution substrate. Every step in every Thodare run is one `step.run()` call against openworkflow's worker; replay determinism, crash recovery, and signal-driven waits are *its* contributions, not ours. We're a thin DSL + control-plane layer on top. (Vendored as `@thodare/openworkflow` for version pinning — see [`packages/openworkflow/UPSTREAM.md`](./packages/openworkflow/UPSTREAM.md) for the relationship.)

If you find Thodare useful, please give openworkflow a star too — none of this works without it.

## License

[MIT](./LICENSE) © 2026 asyncdotengineering. Vendored components retain their original licenses; see [`NOTICE`](./NOTICE).
