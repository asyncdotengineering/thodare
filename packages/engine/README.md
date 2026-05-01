# @thodare/engine

**Typed, fluent, durable workflows for AI-driven internal ops.** Connector-shaped DSL
+ LLM-facing patch surface, executed on **[openworkflow](https://github.com/openworkflowdev/openworkflow)**'s
durable runtime (Apache-2.0; vendored as `@thodare/openworkflow`).
Postgres or SQLite is the source of truth.

> 🙏 **Credit where it's due.** Every step in every run goes through
> openworkflow's worker. Replay determinism, crash recovery, signal-driven
> waits — those are openworkflow's contributions, not ours. See the root
> [README.md](../../README.md#built-on-the-work-of) for the full
> acknowledgements.

```ts
import { z } from "zod";
import { createWfkit, defineConnector, defineWorkflow, hidden } from "@thodare/engine";

// 1. Connectors — Zod schemas drive both validation AND types.
const enrich = defineConnector({
  type: "enrich-lead",
  params: z.object({ email: z.string() }),
  outputs: z.object({ name: z.string(), company: z.string(), score: z.number() }),
  async run({ email }, ctx) {
    return { name: "Alice", company: "Acme", score: 87 };
  },
});

const slack = defineConnector({
  type: "slack",
  params: z.object({
    channel: z.string(),
    text: z.string(),
    accessToken: hidden(z.string()),  // ← LLM literally cannot land this
  }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async run({ channel, text }) {
    return { ok: true, ts: `${Date.now()}` };
  },
});

// 2. Workflow — fluent, end-to-end typed.
const wf = defineWorkflow("lead-notifier")
  .input(z.object({ email: z.string() }))
  .step("enrich", enrich, ({ input }) => ({ email: input.email }))
  .step("notify", slack, ({ input, enrich }) => ({
    channel: "#sales",
    text: `Lead ${enrich.name} at ${enrich.company} (${input.email})`,
    //          ^? autocomplete + compile-time check on every ref
  }))
  .build();

// 3. Run — durable across crashes, no 5-min timeout, true multi-tenancy.
const wfkit = await createWfkit({ backend });
wfkit.register(enrich, slack);
const compiled = wfkit.compile(wf);
await wfkit.start();
const handle = await wfkit.run(compiled, { email: "alice@x.com" });
const out = await handle.result();
```

## Two layers

| Layer | What it's for | Used by |
| --- | --- | --- |
| **High-level** (recommended): `createWfkit` / `defineConnector` / `defineWorkflow` / `hidden` / `userOnly` | Type-safe TypeScript authoring. Zod schemas drive both runtime validation and TS-level inference. | Your service code. The LLM-orchestrator service. |
| **Low-level** (still supported): `applyOperations` / `buildDurableWorkflow` / `new ToolRegistry` / EditOp[] / SerializedWorkflow JSON | The wire format. The LLM emits these JSON shapes via the patch protocol; humans rarely touch them directly. | LLM-emitted patches; persistence; introspection. |

The high-level API compiles to the low-level wire format. **An LLM and a
human can collaborate on the same workflow JSON** — the human reaches for
the typed builder; the LLM reaches for `applyOps(workflow, ops)`.

```
                  ┌── high-level (humans) ──┐
                  │  defineConnector(...)    │
                  │  defineWorkflow(...)     │
                  │  createWfkit({ backend })│
                  └─────────────┬────────────┘
                                │ compiles to ↓
                  ┌── wire format ──────────┐
                  │  SerializedWorkflow JSON │ ← LLM emits patches against this
                  │  EditOp[]                │
                  └─────────────┬────────────┘
                                │ executed by ↓
                  ┌── low-level (runner) ───┐
                  │  buildDurableWorkflow    │
                  │  step.run / step.sleep / │
                  │  step.waitForSignal       │
                  │  Postgres / SQLite        │
                  └──────────────────────────┘
```

## Run it

```sh
npm install               # workspace root
npm run test:durable      # 62 vitest specs, ~40s (SQLite + Postgres + red-team)
pnpm --filter @thodare/engine demo
```

Requires:
- **Node 22+** (for built-in `node:sqlite`).
- **Postgres** for tests 10–12. Default URL is `postgresql://localhost:5432/wfkit_durable_test`;
  override with `WFKIT_DURABLE_PG_URL`. Quick start:
  ```sh
  createdb wfkit_durable_test
  ```
  Each test gets a unique schema (`wfkit_t_<uuid>`) that's dropped on teardown,
  so the suite is safe to run repeatedly.

## What it proves

| File                                     | Behavior |
| ---------------------------------------- | -------- |
| `01.regression-llm-roundtrip`            | wfkit's full LLM round-trip (skips bad ops, validates refs, fix-up patch, executes) survives the port. |
| `02.pause-resume`                        | In-memory: `__paused` sentinel halts the run, `resume()` re-enters cleanly with cached prefix. |
| `03.wait-tools`                          | Each wait tool returns a well-formed `PauseInfo` (resumeAt / resumeOnEvent / resumeUrl / resumeToken). |
| `04.durable-happy-path`                  | wfkit DSL on openworkflow + SQLite, end-to-end. |
| `05.durable-wait-duration`               | `wait_duration` ⇒ `step.sleep`; the run pauses durably and continues. |
| `06.durable-wait-for-event`              | `wait_for_event` ⇒ `step.waitForSignal`; an emitter workflow unblocks it; payload threads to downstream. |
| `07.durable-drip-campaign`               | Multi-pause flow (welcome → wait → tip1 → wait → tip2 → event-wait → final). 4 emails sent, no double-fires across replays. |
| `08.durable-crash-recovery`              | **The proof**: kill worker mid-flight, restart, cached steps not re-executed, in-flight retries succeed. |
| `09.llm-surface-guarantees`              | Hidden params stripped, undeclared refs caught, bad ops skipped, cycles refused. Pinned forever. |
| `10.pg-happy-path`                       | Postgres backend: full trigger → http → slack flow on `BackendPostgres`. |
| `11.pg-crash-recovery`                   | Postgres backend: same crash-recovery proof as test 08, on `workflow_runs` / `step_attempts` tables. |
| `12.pg-drip-campaign`                    | Postgres backend: full multi-pause flow with `wait_duration` and `wait_for_event` durably persisted. |
| `13.adversarial-llm-input`               | Red-team: prototype pollution attempts, hidden-param smuggling, oversized batches, self-loops, 3-block cycles, downstream-ref errors, disabled-block refs. |
| `14.adversarial-runtime`                 | Red-team: tools that throw non-Error / null, return undefined; compute-block-returns-paused on durable; 100-block chain perf; missing-path resolution; literal-template payloads. |
| `15.adversarial-pause-resume`            | Red-team: in-memory resume-twice (no idempotency, documented), wait-on-first-block, wrong-shape resume; durable timeout, fan-out-to-two-waiters, lost-emit semantic. |
| `16.adversarial-graph-shape`             | Red-team: duplicate IDs, ghost edge endpoints, fork-and-join, no-trigger graphs, orphan disconnects, delete-cascades. |
| `17.adversarial-deeper`                  | Red-team: id-vs-name collision, env-string-with-`{{}}`, 10KB block IDs, deeply nested return values, durable replay determinism for `Date.now()`, 100-block fan-out. |
| `18.adversarial-meanest`                 | Red-team: `JSON.parse`'d `__proto__`, EditOp schema rejection, two-add-same-id, 20 concurrent in-memory runs, resume-payload-with-`{{}}`, params-mutation isolation, duplicate workflow names, durable cancel. |
| `19.multi-tenant-stress`                 | 100 parallel workflows + 100 off-timed + 5×20 namespace-isolated. SQL-level isolation verified. |
| `20.durable-handle`                      | Sensible-defaults handle: describe / result (no 5-min cap) / cancel / getHandle reattach. |
| `21.cron-dispatcher`                     | Cron support: parseCron, isCronMatch, dispatchOnce idempotency, end-of-schedule, e2e openworkflow run. |
| `22.adversarial-cron`                    | Cron red-team: 30 concurrent dispatchOnce calls, throwing schedules, malformed cron, clock-rewind. |
| `23.dx-define-connector`                 | DX: `defineConnector` Zod-driven Tool/Block, visibility brands enforced through applyOps, runtime params validation. |
| `24.dx-workflow-builder`                 | DX: fluent `defineWorkflow().input().step().build()` produces wire-format JSON; refs from paramsFn proxy → `{{path}}` templates; auto-wired DAG. |
| `25.dx-end-to-end`                       | DX: zero to typed durable workflow in <30 LoC on Postgres; createWfkit lifecycle errors are clear; applyOps delegates correctly. |
| `26.dx-workflow-spec`                    | `defineWorkflowSpec`: spec/impl split with typed runSpec, version disambiguation, pre-run input validation. |
| `27.tracing`                             | `withTracing(backend, hooks)` Proxy: hooks at create/get/cancel boundaries, async hooks awaited, throws via onError don't break runs, no-hooks path is a no-op. |
| `28.webhooks`                            | `createWebhookRouter`: path matching with `:param` capture, method-aware, 202 / 404 / 400 / 500 surface, idempotency key dedupes duplicate deliveries. |

## What's inside

```
src/
├── types.ts                       wfkit DSL + PauseInfo sentinel + BlockKind
├── tools/
│   ├── registry.ts                ToolRegistry (lifted from wfkit)
│   ├── builtin.ts                 http_request, slack_send_message, transform
│   └── waits.ts                   wait_duration, wait_for_event, human_approval
├── blocks/
│   ├── registry.ts                BlockRegistry (lifted from wfkit)
│   └── builtin.ts                 facade blocks for the tools, including 3 wait blocks
├── executor/
│   ├── dag.ts                     buildDAG, Kahn's topo sort, cycle check
│   ├── resolver.ts                {{trigger.x}} {{env.X}} {{vars.x}} {{block.field}}
│   └── executor.memory.ts         In-memory pause-aware executor + resume()
├── operations/
│   └── apply.ts                   THE GEM — patch operations, skip semantics,
│                                  visibility filter, reference validation
├── runner/
│   └── openworkflow.ts            buildDurableWorkflow — walk the DAG, dispatch
│                                  via step.run / step.sleep / step.waitForSignal
└── index.ts                       public API
```

The two executors share **everything except dispatch** — same DAG construction,
same resolver chain, same param-shape contract. The dev executor exists for
fast unit tests (no SQLite spin-up); the durable executor is what production
runs.

## Why the wait-block kind matters

wfkit's findings #12 ("one pause primitive for everything") proposes that
**every** wait shape return the same `__paused` sentinel and the runner sorts
out how to wake it. That's the right product surface — every workflow author
sees the same `wait_duration` / `wait_for_event` / `human_approval` blocks,
the same downstream output shape.

But on a durable runtime that uses deterministic replay (Temporal/openworkflow/
Restate), you can't just block inside `step.run` and expect the runtime to
know it should sleep — that step has already started, and its result is going
into the history. So we declare *at the block definition level* that a block
is `kind: 'wait'`, and the durable executor's dispatch dispatches differently:
the tool's `execute` is never called at all — the wait params are read, then
`step.sleep` or `step.waitForSignal` runs natively. The block's "output" is
synthesized from the sleep result or the signal payload.

The in-memory executor still calls the wait tool's `execute` (which returns
the sentinel) to keep the API self-consistent for unit tests.

This is the cleanest interpretation that keeps **the JSON document portable**
between the two executors. A workflow that uses `human_approval` runs in
either runtime; only durability characteristics differ.

## What it doesn't do (deliberate)

- **No `pauseSnapshots` table or cron reconciler.** openworkflow owns the
  durability boundary — its Postgres/SQLite backend is the source of truth
  (proven on both: see tests 10–12 for the same scenarios as 04, 07, 08
  but on real Postgres). The wfkit conv-08 design document still applies,
  but with openworkflow you don't write it; you inherit it.
- **No `expression` block, no `ai_generate_text` block, no `code_execute`.**
  All listed in wfkit's roadmap, all easy to add (each is ~30-80 LoC). Not
  on the spike's critical path.
- **No HTTP API / trigger router.** The package is the engine. Wrap
  `applyOperations` and `buildDurableWorkflow().run()` in your route handlers.
- **Compute blocks cannot suspend.** If a non-wait block's tool returns
  `__paused`, the durable executor throws a clear error. Pauses must be
  declared up front via `kind: 'wait'`. (You can compose: `http` → `wait_for_event`.)

## Where to extend

Read the [Architecture](./ARCHITECTURE.md) doc for the layered model and
extension points.

## Spec/impl split (`defineWorkflowSpec`)

```ts
// shared/specs.ts — no runtime deps:
export const SendEmailSpec = defineWorkflowSpec({
  name: "send-email", version: "1",
  input: z.object({ to: z.string(), subject: z.string() }),
  output: z.object({ delivered: z.boolean() }),
});

// worker:
wfkit.workflowFromSpec(SendEmailSpec, (b) =>
  b.step("send", smtp, ({ input }) => ({ to: input.to, subject: input.subject })),
);

// API service (no worker code bundled):
const handle = await wfkit.runSpec(SendEmailSpec, { to: "x@y.com", subject: "hi" });
//             ^? input is z.infer<typeof SendEmailSpec.input>
```

Two specs with the same name + different versions register cleanly
(workflow runtime name is `${name}@${version}`). `runSpec` validates the
input against `spec.input` BEFORE creating a run — bad inputs throw
without polluting `workflow_runs`.

## Tracing hooks (`withTracing`)

```ts
const traced = withTracing(backend, {
  onWorkflowRunCreate: (params, run) => {
    const span = tracer.startSpan(`workflow:${run.workflowName}`);
    // store span keyed by run.id for finish-on-complete
  },
  onWorkflowRunGet: (run) => { /* status update */ },
  onWorkflowRunCancel: (run) => { /* close span */ },
  onError: (err, hookName) => {
    metrics.increment("wfkit.tracing.hook_error", { hook: hookName });
  },
});

const wfkit = await createWfkit({ backend: traced });
```

No `@opentelemetry/api` dependency. The Proxy is decoupled from any
specific tracing SDK — wire your own. Hooks may be sync OR async; the
proxy awaits async hooks before returning the underlying op. Hooks that
throw are surfaced via `onError` and never break the workflow run.

## Webhook router (`createWebhookRouter`)

```ts
const router = createWebhookRouter({ wfkit });

router.register({
  path: "/tenants/:tenant/events/:eventId",
  method: "POST",
  spec: WebhookEventSpec,
  fromRequest: (req) => ({
    tenant: req.params.tenant!,
    eventId: req.params.eventId!,
    payload: req.body,
  }),
  idempotencyKey: (req) => `evt:${req.params.eventId}`,
});

// Plug into ANY HTTP layer:
app.all("*", async (req, res) => {
  const { status, body } = await router.handle({
    method: req.method, path: req.path, headers: req.headers, body: req.body,
  });
  res.status(status).json(body);
});
```

Behavior: 202 `{ runId }` on match, 404 on no match, 400 with structured
Zod issues on input validation failure, idempotency-key passthrough so
duplicate webhook deliveries dedupe to the same run.

HTTP-server agnostic — no Express/Hono/Bun dep. Path matcher is tiny
(no regexp, no wildcards) on purpose.

## Threat model

[`THREAT-MODEL.md`](./THREAT-MODEL.md) enumerates every defense the system
provides — each backed by a test — alongside every attack class that's
explicitly out of scope. Read it before deploying to production. The short
version: the system defends the LLM-input boundary thoroughly (visibility
flag, prototype pollution, cycle introduction, schema mismatches, weird
throw/return shapes, concurrent runs, durable cancel, replay determinism)
and explicitly delegates SSRF + secrets-in-free-form-fields to the integrator.
