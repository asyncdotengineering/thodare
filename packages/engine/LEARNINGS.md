# @thodare/engine — Learnings & Borrowed Patterns

A field journal of what we discovered building this — what came from the
wfkit conversations, what came from the openworkflow source, and what we
learned by reading other production users via `gh search code`.

When we use a pattern from someone else's repo, this file says where it
came from and which file in @thodare/engine codifies it.

---

## 1. The 5-minute `result()` timeout (production gotcha)

**How we found it:** The first 15-minute wall-clock demo died at +5:00 with
`Error: Timed out waiting for workflow run …`. The workflow itself was
alive in Postgres; only `await handle.result()` gave up.

**Root cause:** `WorkflowRunHandle.result()` defaults to `resultTimeoutMs:
300000` (5 minutes). Hardcoded. A drip campaign or human-in-loop run that
takes longer than 5 min throws unless you pass `{ timeoutMs }` explicitly.

**What real users do:** [`Chigala/durable-agent`](https://github.com/Chigala/durable-agent)
doesn't call `handle.result()` at all. They roll their own poll loop:

```ts
private async waitForResult(runId: string): Promise<AgentResult> {
  const POLL_INTERVAL_MS = 1000;
  while (true) {
    const workflowRun = await this.backend.getWorkflowRun({ workflowRunId: runId });
    // ... map status, return / throw on terminal states
  }
}
```

No upper bound. The poll loop runs forever (or until terminal status).

**How we fixed it:** Added [`createDurableHandle`](./src/runner/handle.ts)
that exposes:
- `id` — the run id, so callers can persist it and reattach via `getHandle(id)`
- `describe()` — single backend read, non-blocking; for status checks
- `result({ timeoutMs?, pollIntervalMs? })` — polls forever by default
  (timeoutMs = undefined ⇒ Infinity), with an explicit error message that
  guides the caller toward `describe()` if they need non-blocking
- `cancel()` — wraps `backend.cancelWorkflowRun`

`buildDurableWorkflow` now exposes `runDurable(input, opts)` which returns
this handle, alongside the raw `run()` for legacy interop. `backend` is a
**required** option — you can't accidentally construct a `DurableWorkflow`
without the means to call describe/result/cancel.

**Tests:** [`tests/20.durable-handle.test.ts`](./tests/20.durable-handle.test.ts) — 5 specs.

---

## 2. Cron / scheduled triggers

**The question:** @thodare/engine has `wait_duration` (relative) and
`wait_for_event` (signal-driven). What about "fire this workflow every
Monday at 9am"?

**The shape that production deployments converge on:**

- A `schedules` table holds rows with `cron_expression`, `timezone`,
  `next_scheduled_at`, `end_at`.
- A periodic dispatcher (often itself a workflow) ticks on cadence.
  Each tick:
  1. Atomically claims schedules due as of `cutoffMinute`.
  2. Spawns child workflows for each via `runWorkflow(spec, input,
     { idempotencyKey })`.
- `enqueueScheduleDispatch` builds the idempotency key from `cutoffMinute`
  so a double-fired cron tick still only spawns one child workflow.

**The non-obvious lesson:** durable-execution patterns don't bolt cron onto openworkflow
itself. They built it as a periodic workflow that uses openworkflow's
existing primitives (`runWorkflow` + `idempotencyKey`). One concept.
Same observability surface as everything else.

**How we built it:** [`src/runner/cron.ts`](./src/runner/cron.ts) ports
the pattern:

- `ScheduleSpec` — `{ id, cron, workflowName, payload, endAt?, timezone? }`
- `ScheduleStore` — a single-method contract: `tryClaim(scheduleId,
  cutoffMinuteIso) → boolean`. The Set-based in-memory impl is for tests;
  production replaces with `INSERT … ON CONFLICT DO NOTHING`.
- `parseCron` / `isCronMatch` — minute-resolution `m h d M w` parser:
  `*`, step (`*/N`), comma lists, ranges. Sub-second cadences are out of
  scope — use `wait_duration` blocks for that.
- `dispatchOnce({ store, runWorkflow }, cutoffMinute)` — the unit of work.
  Idempotent per-cutoff. Per-schedule failures land in the result's
  `failed[]` array; they never block the rest of the tick.
- `startCronDispatcher()` — convenience wrapper that calls `dispatchOnce`
  on a `tickIntervalMs` cadence (default 60s). Has `tickOnStart` (default
  true — catches up on boot) and `tickNow()` for manual triggering.

The contract is intentionally tiny so production can wire Postgres /
Redis / pg_cron behind it without touching dispatcher logic.

**Tests:**
- [`tests/21.cron-dispatcher.test.ts`](./tests/21.cron-dispatcher.test.ts) — 10 specs (parse / match / dispatch / e2e openworkflow run)
- [`tests/22.adversarial-cron.test.ts`](./tests/22.adversarial-cron.test.ts) — 7 specs (concurrent dispatchOnce, throwing schedules, malformed cron, end_at, clock-rewind, idempotency-key stability)

**What we explicitly didn't do:** No `trigger_cron` block type. wfkit
conversation 08 #12: "don't build scheduled jobs as a separate feature —
a scheduled email is a one-block workflow that pauses immediately." The
cron dispatcher fires *normal* workflows. The schedule is metadata, not a
new workflow primitive.

---

## 3. The pre-1.0 `backend` re-exposure problem

**What we found in openworkflow's source:** `class OpenWorkflow` takes
`{ backend }` in its constructor but never re-exposes it. So if you
later need backend access (to call `getWorkflowRun(runId)` directly,
say), you have to thread it separately.

**The Proxy-wrapping technique:** the backend is a thin interface, easy
to wrap with `Proxy` for cross-cutting concerns (tracing, auth,
rate-limiting). For example, injecting OTel context on
`createWorkflowRun`:

```ts
function withTraceContext(backend: BackendPostgres): BackendPostgres {
  return new Proxy(backend, {
    get(target, property) {
      if (property === "createWorkflowRun") {
        return async (params: Parameters<typeof target.createWorkflowRun>[0]) =>
          target.createWorkflowRun({
            ...params,
            context: injectActiveTraceContextIntoWorkflowRunContext(params.context),
          });
      }
      // …passthrough
    },
  });
}
```

`@thodare/engine` ships `withTracing(backend, hooks)` as the generic
form — see §9b below.

---

## 4. Atomic claim contract for cron dispatchers

**Why this matters:** A naive cron dispatcher with `hasFired/markFired` as
two separate ops has a race: two workers both check, both see "not
fired", both fire. The correct pattern is to fold check-and-set into one
SQL operation: `INSERT ... ON CONFLICT DO NOTHING RETURNING 1`, or
equivalently `SELECT … FOR UPDATE` + conditional UPDATE. Either the
row inserts/advances (caller is the winner) or it conflicts (caller skips).

We built the in-memory `tryClaim` exactly that way — single method,
returns boolean, no separate `hasFired`. This means our store contract
is honest about what production needs to provide.

**Test:** `22.adversarial-cron.test.ts` — "CONCURRENT dispatchOnce calls
for the same cutoff fire each schedule exactly once".

---

## 5. The "math is hard, look at logs" rule

This came up twice in this session and it's worth writing down.

When estimating durations, **calculate**. Don't say "1.5 min from now"
when the actual answer is "2 min from now" — bad estimates compound and
mask the real bug. The first 15-min demo died at +5:00 because of the
`result()` timeout, not because of the math; but the bad math made me
miss the silent crash for several minutes.

**Discipline:** any time I quote an offset, derive it from a recent log
line. `420 - 300.5 = 119.5s` — write the arithmetic, then state the
answer. Especially in long-running operations.

---

## 6. Workspace test discovery (annoying but knowable)

`npx vitest run` from the workspace root crawls into hoisted
`node_modules` and tries to run openworkflow's bundled tests, which need
`jsdom`. The aggregate `npm test` runs each workspace's vitest in its
own working directory, which is fine.

**Discipline:** never `npx vitest` from the root. Use `npm test` or
`cd <package> && npx vitest`.

---

## 7. The wait-block kind is the right boundary

When we built @thodare/engine, the question was "should any tool be
allowed to return `__paused`, or only declared wait blocks?"

The in-memory executor allows any tool to return the sentinel — that's
useful for unit tests of arbitrary tool behavior. But the durable
runtime can't honor it: by the time `step.run` has invoked the tool, the
step is committed to history and there's no way to retroactively pause.

So the durable runtime explicitly throws when a `kind: 'compute'` block
returns `__paused`. Wait blocks (`kind: 'wait'`) are dispatched
differently — their tool's `execute` is never called at all; the runner
reads the block's params and uses `step.sleep` / `step.waitForSignal`
directly.

The lesson: pause has to be declarative, not opportunistic, on a
deterministic-replay runtime. If openworkflow ever exposed a "yield this
step's value as a pause" primitive we could relax this; until then,
declared wait kinds are the contract.

---

## 8. The Zod / Drizzle / tRPC playbook for "god-tier DX"

We refactored the public API after tagging Zod, Drizzle, and tRPC as the
DX benchmarks. Three patterns from those libraries paid off here:

### Zod's pattern: schema is the single source of truth

`defineConnector({ params: z.object({…}), outputs: z.object({…}), run })`
takes Zod schemas for params and outputs. The `run({ … }, ctx)` function
receives `z.infer<typeof params>` — fully typed. Runtime validation happens
at the connector boundary; if workflow JSON disagrees with the schema, you
get a structured error before the side effect fires.

The `hidden(z.string())` / `userOnly(...)` helpers brand the schema with a
visibility marker (a Symbol-keyed property). Reading the brand at
registration time builds the underlying Tool's `params[k].visibility`. The
security policy lives ON THE SCHEMA, not in a sidecar metadata object —
you can't accidentally forget it.

→ [`src/define/connector.ts`](./src/define/connector.ts), [`src/define/visibility.ts`](./src/define/visibility.ts)

### Drizzle's pattern: chained builder accumulating types

`defineWorkflow(name).input(zod).step(...).step(...).build()` mirrors
Drizzle's `db.select().from(...).where(...)` shape. Each `.step()` returns
a NEW builder type that accumulates `{ stepId: outputType }` into a phantom
map; the next `.step(id, connector, paramsFn)` sees `{ input, ...prevSteps }`
in `paramsFn`'s argument, fully typed.

The runtime trick: `input` and each prev step are **Proxy objects** that
return template strings (`"{{trigger.email}}"`) on coercion AND new
sub-proxies on property access. So `enrich.body.name` returns a proxy at
path `"{{enrich.body.name}}"`. When the user composes them into a string
template (\`Lead ${enrich.body.name}\`) JS coerces them to their templates.
When `.build()` runs we `JSON.parse(JSON.stringify(...))` the paramsFn
return — the proxies' `toJSON()` collapses them to wire-format strings.

End result: type-safe authoring, JSON-serializable wire format, no codegen,
no separate macro language.

→ [`src/define/workflow.ts`](./src/define/workflow.ts) — `makeRef`, `WorkflowBuilder`

### tRPC's pattern: lifecycle bundled into a single client object

`createWfkit({ backend })` returns a `Wfkit` that owns the OpenWorkflow
client, both registries, and worker lifecycle. `register(...)` accepts
connectors variadically. `start()` / `restart()` / `stop()` enforce the
ordering invariants (you can't `register` after `start` because openworkflow
snapshots its registry — we throw a clear error if you try). One object,
one mental model.

Versus the old surface where `buildDurableWorkflow` took `{ ow, backend,
blockRegistry, toolRegistry, workflow, env }` and the user had to construct
each piece separately and remember the order.

→ [`src/client.ts`](./src/client.ts)

### What we deliberately DIDN'T copy

- **No codegen**. Drizzle's CLI-driven schema generator and tRPC's separate
  client/server packages add operational complexity. @thodare/engine is one
  package, no codegen step. Type inference is enough.
- **No "everything is a Zod schema" overreach**. Workflow shape itself
  stays as plain JSON because the LLM emits JSON via patches; making the
  workflow itself a Zod schema would require codegen to round-trip.
- **No "fluent everywhere"**. `applyOps(workflow, ops)` is still a plain
  function. Fluency is for AUTHORING; the LLM's surface is JSON-in /
  structured-result-out.

The principle: borrow the schemas-as-types and chained-builders patterns,
but stop short of codegen and runtime metaprogramming that can't survive
serialization. Workflow JSON has to be portable.

**Tests:** [`tests/23.dx-define-connector.test.ts`](./tests/23.dx-define-connector.test.ts) (4),
[`tests/24.dx-workflow-builder.test.ts`](./tests/24.dx-workflow-builder.test.ts) (3),
[`tests/25.dx-end-to-end.test.ts`](./tests/25.dx-end-to-end.test.ts) (3 incl. PG).

---

## 9. Three add-ons we shipped on top of openworkflow

Three small modules on top of openworkflow's primitives that turned out
to be the difference between "raw library" and "control plane":

### 9a. `defineWorkflowSpec` — spec/impl split

The pattern: export the workflow's *spec* (name, version, input/output
schemas) from a shared module; export the *implementation* from the
worker bundle; let the API call `runSpec(spec, input)` without
importing the worker.

```ts
// shared:
export const SendVerificationOTPSpec = defineWorkflowSpec<I, O>({
  name: "auth.send-verification-otp",
  version: "1",
});

// worker:
export const SendVerificationOTPWorkflow =
  defineWorkflow(SendVerificationOTPSpec).step(...).build();

// API (no worker bundle imported):
await wfkit.runSpec(SendVerificationOTPSpec, input, { idempotencyKey });
```

Typed Zod schemas attached for input/output. Runtime registers
`${name}@${version}` so two specs with the same name and different
versions disambiguate cleanly. `runSpec` validates input against
`spec.input` BEFORE creating a run — bad inputs throw without
polluting `workflow_runs`.

→ [`src/define/spec.ts`](./src/define/spec.ts), [`src/client.ts`](./src/client.ts)
→ Tests: [`tests/26.dx-workflow-spec.test.ts`](./tests/26.dx-workflow-spec.test.ts)

### 9b. `withTracing` — Proxy + user-supplied hooks

Wraps the openworkflow backend with a `Proxy` that calls user-supplied
hooks on lifecycle events (`onWorkflowRunCreate`, `onWorkflowRunGet`,
`onWorkflowRunCancel`, `onError`). Decoupled from any specific tracing
SDK — wire OTel / Sentry / a console logger from inside the hooks.
The Proxy awaits async hooks before returning the underlying op
result; thrown hook errors go to `onError` and never break the run.

~80 LoC of glue.

→ [`src/runner/tracing.ts`](./src/runner/tracing.ts)
→ Tests: [`tests/27.tracing.test.ts`](./tests/27.tracing.test.ts)

### 9c. `createWebhookRouter` — inbound HTTP → workflow dispatch

A small HTTP-server-agnostic router: match path → extract params →
validate body via the spec's input Zod schema → dispatch via
`runSpec`. ~120 LoC, no Express/Hono/Bun dep; the caller plugs us
into any layer in 5 lines. Path matcher is hand-rolled for the cases
we actually need (exact match + `:param` capture); no
`path-to-regexp` dependency.

→ [`src/runner/webhooks.ts`](./src/runner/webhooks.ts)
→ Tests: [`tests/28.webhooks.test.ts`](./tests/28.webhooks.test.ts)

### Out of scope (for now)

- **Long-running automation handoff** — domain-specific; build it as
  a `wait_for_event` chain in your own workflow.
- **Conversation/state-machine wrappers** — domain-specific.
- **Built-in OTel instrumentation** — opted for hook-based abstraction
  so users wire their own.
- **DI WorkflowContext** — closures + `ToolContext.env` is enough for now.

The principle: ship operational scaffolding (spec/impl split, tracing,
webhook routing); leave the product domain to whoever's building on
top. Each module above is ≤300 LoC with a clean abstraction line.

---

## 10. Putting an HTTP face on a closed workflow registry

Spike 4 (`packages/api/`) is the HTTP layer that exposes @thodare/engine
to LLM orchestrators and UIs. Building it surfaced three architectural
decisions worth recording, all of which trace back to a single uncomfortable
property of openworkflow: **its workflow registry is closed at
`worker.start()`.**

### 10a. One generic runtime workflow, not per-workflow registration

The naive plan was: when the API gets `POST /api/workflows`, register a new
openworkflow workflow keyed by the workflow ID. That doesn't work — the
worker has already started by the time API requests arrive, and openworkflow
freezes its registry to keep deterministic replay across upgrades. You can't
register more.

The fix: register **exactly one** openworkflow workflow named
`wfkit-runtime` whose input is `{ workflow: SerializedWorkflow, input: unknown }`,
and have it walk the wfkit JSON dynamically using the same block-executor
table as the static `defineWorkflow().build({ ow }).register()` path.

Implementation: [`runner/runtime-workflow.ts`](./src/runner/runtime-workflow.ts)
+ [`runner/walk.ts`](./src/runner/walk.ts) (extracted so both paths share one
walker — fewer divergence bugs).

What we lose: per-workflow durability isolation in `step_attempts` (every
run is keyed under one openworkflow workflow name). What we keep: per-run
durability, retries, cancellation, replay. The trade is unambiguously
correct for a control plane whose value proposition is "you can register
new workflow JSON without redeploying the runtime."

### 10b. Pin workflow JSON at run-start

The other half of the registry-frozen problem: if the LLM patches a workflow
while a run is in-flight on the old version, the run must finish on the
JSON it started with. Otherwise replay diverges.

The control plane handles this by **passing the workflow JSON itself into
the run input** at dispatch time. The runtime workflow gets a self-contained
description of what to execute; updates to the source workflow row don't
affect in-flight runs.

Cost: each run carries the full workflow JSON in its input column. For our
expected workflow sizes (≤50 blocks, ~10 KB JSON) this is cheap. If
workflows grow to 1000+ blocks, store the JSON in a content-addressed table
and pass the hash instead.

### 10c. Auth fail-closed by default

`createControlPlaneApi({ tokens: [] })` means **no** request authorizes
(except `/health`). Empty list is the worst possible outcome of a
secret-loading misconfiguration; the API treats it as "lock everything"
rather than the more permissive (and actually dangerous) "no auth
configured = no auth required."

This is a one-line decision (`tokenSet.has(m[1])` — the empty set never
contains anything) but it's a deliberate one. Operators get a loud 401 when
their secret pipeline breaks; they don't get a silent open API.

### 10d. The patch endpoint is the load-bearing piece

Everything else in the API — CRUD, runs, schedules, webhooks — is
mechanical plumbing. The piece that earns the LLM-control-plane name is
`POST /api/workflows/:id/operations`:

- Accepts `EditOp[]` (typed shape, validated by Zod).
- Applies them through `wfkit.applyOps()` — bad ops are **skipped, not
  fatal**, and returned in `skipped_items[]` with structured reason codes.
- Responds with `{ ok, version, validation_errors, skipped_items, summary }`
  — every field is feedable directly back to the LLM as tool output.
- Optimistic concurrency via `If-Match: <version>` so concurrent edits
  surface as 412, not silent last-write-wins.

The reason this is load-bearing: a failed-but-skipped op is the LLM's only
training signal for "I picked the wrong block type" or "I introduced a
cycle." If the API rejected the entire batch on first error, the LLM would
have no way to learn from a single round-trip — it would have to retry the
whole thing. The skip-and-explain pattern is what makes single-shot LLM
workflow construction work.

→ [`packages/api/src/routes/workflows.ts`](../api/src/routes/workflows.ts)
→ Tests: [`packages/api/tests/02.patch-endpoint.test.ts`](../api/tests/02.patch-endpoint.test.ts)
→ End-to-end demo: [`packages/api/examples/full-llm-loop.ts`](../api/examples/full-llm-loop.ts)

### What we deliberately didn't put in the API

- **A `register-webhook` HTTP endpoint.** Webhook routes are infra
  (`api.webhooks.register({...})` from boot code), not user-mutable. Letting
  arbitrary API callers bind URLs to workflow names is a phishing primitive.
- **Multi-tenant isolation primitives.** `tokens` is flat. The first real
  tenant boundary will need per-token schema scoping; we'll add it the day
  there's a second tenant, not before.
- **A websocket / SSE run-state stream.** `GET /api/runs/:runId` polls;
  callers wanting push need to wire openworkflow's `listStepAttempts`
  cursor stream themselves. Streaming wire format is a real design
  decision we don't have enough signal to commit to yet.

---

## How to extend this document

When you discover something we didn't know — or borrow a pattern from
another openworkflow user — add a section here. Cite the source repo and
link to the @thodare/engine file that codifies it.
