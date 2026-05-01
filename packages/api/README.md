# @thodare/api

**The HTTP surface that exposes `@thodare/engine` to LLM orchestrators and UIs.**

A small Hono app that wraps a `Wfkit` instance (engine + connector registry +
durable runtime) with:

- **Workflows CRUD** — create, get, delete, with optimistic concurrency
  (`If-Match: <version>`) on every mutation.
- **The LLM patch endpoint** — `POST /api/workflows/:id/operations` accepts an
  `EditOp[]` array, returns `{ ok, version, validation_errors, skipped_items, summary }`.
  Skips are typed and feedable directly back to the LLM as tool output. This is
  the heart of the AI repair loop.
- **Connector catalog** — `GET /api/connectors` so the LLM can discover what
  blocks exist (params, outputs, descriptions). `?detail=summary` projection for
  prompt budget.
- **Run dispatch + introspection** — `POST /api/workflows/:id/run`, plus
  `GET /api/runs/:runId`, `GET /api/runs/:runId/logs?after=…&limit=…`, and
  `POST /api/runs/:runId/cancel`.
- **Schedules** — `POST/GET/DELETE /api/schedules` for cron-driven triggers,
  plus `POST /api/admin/tick` for manual dispatch (production drives this from
  pg_cron or a dedicated worker).
- **Webhooks** — `/api/webhooks/*` mounts `@thodare/engine`'s webhook router.
  Routes are registered programmatically (`api.webhooks.register({...})`) — not
  exposed as a mutating HTTP endpoint, by design.
- **Auth + rate-limit** — bearer-token auth (fail-closed when `tokens: []`),
  per-token in-memory token bucket, `/health` bypasses both.

It's ~600 LoC of route handlers + middleware, deliberately thin — every route
is a near-direct call into `Wfkit` or one of two Postgres stores
(`workflows`, `schedules`).

---

## Quickstart

```sh
# Postgres needed (it's the source of truth for both @thodare/engine AND this API):
createdb wfkit_durable_test

# From repo root:
npm install
pnpm --filter @thodare/api test    # 43 tests
```

Boot the API in code:

```ts
import { BackendPostgres } from "openworkflow/postgres";
import { createWfkit } from "@thodare/engine";
import { createControlPlaneApi } from "@thodare/api";

const backend = await BackendPostgres.connect(process.env.PG_URL!, { schema: "ops" });
const wfkit = await createWfkit({ backend });
wfkit.register(/* your connectors here */);

const api = await createControlPlaneApi({
  pgUrl: process.env.PG_URL!,
  schema: "ops",                 // shared with wfkit's backend is fine
  wfkit,
  tokens: [process.env.API_TOKEN!],
  rateLimitPerMin: 60,
});
await wfkit.start();             // start the openworkflow worker

// Hono app — wire to your runtime of choice:
//   Bun:    Bun.serve({ fetch: api.app.fetch });
//   Node:   serve(api.app, { port: 3000 });
//   Deno:   Deno.serve(api.app.fetch);
//   Workers: export default api.app;
```

---

## Curl quickstart

The full LLM repair loop in a terminal:

```sh
TOKEN=demo-token
URL=http://localhost:3000
H="Authorization: Bearer $TOKEN"

# 1. Create empty workflow.
WF=$(curl -sX POST "$URL/api/workflows" -H "$H" -H 'content-type: application/json' -d '{}')
WFID=$(echo "$WF" | jq -r .id)
VER=$(echo "$WF" | jq -r .version)
echo "wf=$WFID v=$VER"

# 2. Discover the catalog (this is what your LLM gets in its system prompt).
curl -s "$URL/api/connectors?detail=summary" -H "$H" | jq

# 3. First patch — the LLM proposes ops. The response is feedable back to the LLM.
curl -s -X POST "$URL/api/workflows/$WFID/operations" \
  -H "$H" -H "If-Match: $VER" -H 'content-type: application/json' \
  -d '{"ops":[
    {"operation_type":"add","block_id":"trg","type":"trigger_webhook","params":{}},
    {"operation_type":"add","block_id":"g","type":"greet","params":{"name":"Ada"}},
    {"operation_type":"connect","block_id":"trg","target_block_id":"g"}
  ]}' | jq '{ok, version, summary, skipped_items}'

# 4. Run.
RUN=$(curl -sX POST "$URL/api/workflows/$WFID/run" -H "$H" -H 'content-type: application/json' \
  -d '{"input":{"hello":"world"}}')
RUNID=$(echo "$RUN" | jq -r .runId)

# 5. Poll until done.
curl -s "$URL/api/runs/$RUNID" -H "$H" | jq '{state, output}'
```

Or run the same loop programmatically (with a per-run Postgres schema and
auto-cleanup) — see [`examples/full-llm-loop.ts`](./examples/full-llm-loop.ts):

```sh
bun examples/full-llm-loop.ts
```

---

## Route table

| Method | Path | Auth | Rate-limit | Purpose |
|---|---|---|---|---|
| GET | `/health` | open | open | Liveness probe |
| POST | `/api/workflows` | ✓ | ✓ | Create empty workflow |
| GET | `/api/workflows/:id` | ✓ | ✓ | Read workflow JSON + version |
| POST | `/api/workflows/:id/operations` | ✓ | ✓ | **The LLM patch endpoint.** Apply `EditOp[]`. |
| DELETE | `/api/workflows/:id` | ✓ | ✓ | Delete workflow |
| POST | `/api/workflows/:id/run` | ✓ | ✓ | Dispatch a run |
| GET | `/api/runs/:runId` | ✓ | ✓ | Describe a run |
| GET | `/api/runs/:runId/logs` | ✓ | ✓ | Paginated step attempts |
| POST | `/api/runs/:runId/cancel` | ✓ | ✓ | Cancel an in-flight run |
| GET | `/api/connectors` | ✓ | ✓ | Connector catalog (see `?detail=`) |
| POST | `/api/schedules` | ✓ | ✓ | Register a cron schedule |
| GET | `/api/schedules` | ✓ | ✓ | List schedules |
| DELETE | `/api/schedules/:id` | ✓ | ✓ | Remove a schedule |
| POST | `/api/admin/tick` | ✓ | ✓ | Manual dispatcher tick (tests / ops) |
| ALL | `/api/webhooks/*` | ✓ | ✓ | Programmatically registered webhook routes |

---

## Design decisions

### One generic runtime workflow, not per-workflow openworkflow registration

`openworkflow.start()` snapshots its workflow registry; you cannot register a
new openworkflow workflow at runtime. The control plane exists precisely to
keep registering new workflow JSON without redeploys. So we register **one**
openworkflow workflow named `wfkit-runtime` whose input is
`{ workflow: SerializedWorkflow, input: unknown }` — and it walks the JSON
generically using the same block executors as the kit's "build at boot" path.

The tradeoff: we lose openworkflow's per-workflow durability isolation
(everything runs under one workflow name in `step_attempts`). We keep the
**per-run** durability, retries, and cancellation that actually matter.
See [`packages/engine/LEARNINGS.md` §10](../packages/engine/LEARNINGS.md) for the
full reasoning.

### Workflow JSON is snapshotted into run input

When you `POST /api/workflows/:id/run`, the API loads the workflow JSON from
Postgres and passes it as part of the run's input — so an in-flight run uses
the version of the JSON that existed when it started, even if you patch the
workflow during execution. This makes durable replay safe across edits.

### Auth is fail-closed

`tokens: []` means **no** request authorizes (except `/health`). If your
secret-loading pipeline fails and feeds an empty list, every request 401s
instead of letting traffic in unauthenticated. That trade-off is deliberate:
operator confusion on misconfig is far cheaper than a silent open API.

### Schemas are caller-owned

`createControlPlaneApi({ schema: "..." })` lets you isolate API tables. Each
test in this package boots the API on a fresh schema (`cpa_<random>`) and
drops it on teardown — same pattern works for staging vs prod.

### Optimistic concurrency on every mutation

The patch endpoint reads `If-Match: <version>`. Concurrent edits get a 412
with `{ error: "version_mismatch", current: <n> }` — the caller refetches and
retries. No silent last-write-wins.

### EditOp validation is structural and **not fatal to the batch**

Bad ops in a patch don't reject the request — they're returned in
`skipped_items[]` while the rest of the batch applies. This is what makes the
endpoint an LLM repair-loop primitive: the LLM gets back exactly which of its
proposed ops failed and why, in structured form.

---

## Tests

`tests/` covers, file by file:

- `01.workflows-crud.test.ts` — create / get / delete + idempotency
- `02.patch-endpoint.test.ts` — EditOp loop, optimistic concurrency,
  malformed-body cases
- `03.connectors-catalog.test.ts` — visibility + `?detail=summary` projection
- `04.runtime-and-runs.test.ts` — dispatch + describe + logs + cancel
- `05.schedules-and-webhooks.test.ts` — schedule CRUD, dispatcher tick,
  webhook router mount
- `06.auth-and-ratelimit.test.ts` — every guarantee in the auth/rate-limit
  contract: fail-closed empty-token list, per-token buckets, 429 with
  `retryAfterMs`, `/health` bypasses both, case-insensitive `Bearer`

```sh
pnpm --filter @thodare/api test
# Test Files  6 passed (6)
# Tests      43 passed (43)
```

Each test boots a fresh API on its own Postgres schema and drops it on
teardown — they are concurrent-safe.
