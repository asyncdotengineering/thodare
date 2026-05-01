# @thodare/engine — Threat Model

The system has a defined security boundary. Some attacks are stopped; some
are out-of-scope and the caller must defend on their own. This file
enumerates **both** so nothing is left implicit.

Every row points at a test that pins the behavior.

---

## ✅ DEFENDED — system blocks these

| Attack | Defense | Test |
| --- | --- | --- |
| LLM names a `'hidden'` param at the top level (e.g. `accessToken: "stolen"`) | `applyOperations` filters the param against the block's `subBlocks` + tool's `user-or-llm` allowlist; rejected with a structured `ValidationError` | `09.llm-surface-guarantees`, `13.adversarial-llm-input` |
| LLM emits an unknown `block_id` type (`salesforce_lookup`) | Skipped with `block_type_not_registered` reason; rest of batch applies | `01.regression-llm-roundtrip`, `13` |
| LLM hallucinates `{{enrich.full_name}}` against an `http` block (no such field) | Reference walker checks `block.outputs`; structured error names the available outputs | `01`, `09` |
| LLM tries to introduce a cycle (A→B→A or A→B→C→A) | `applyConnect` does a trial DAG build before committing; skipped with `cycle_introduced` | `09`, `13` |
| LLM tries a self-loop (A→A) | Same as cycle; rejected | `13` |
| LLM tries `__proto__` / `constructor` / `prototype` as a param NAME | Filtered by allowlist; never lands in workflow JSON; `Object.prototype` stays untainted | `13` |
| LLM tries a `__proto__` payload via `JSON.parse` (own-property form) | Same — own-property filter applies; `Object.prototype` clean | `18` |
| LLM emits 50 ops with 25 invalid types + 25 valid | All 25 valid land; 25 skips returned with reasons | `13` |
| LLM references a downstream / sibling block (not actually upstream) | Reachability walker rejects; structured "not upstream" error | `13` |
| LLM references a `enabled: false` block | Resolver returns `undefined` for missing output; doesn't crash | `13` |
| LLM emits `EditOp` with unknown `operation_type` | `EditOpSchema.safeParse` rejects | `18` |
| LLM emits two `add` ops for the same `block_id` | Second skips with `block_already_exists`; first wins | `09`, `16`, `18` |
| LLM emits a connection from/to a non-existent block | Skipped with `invalid_edge_source` / `invalid_edge_target` | `16` |
| Compute block returns the `__paused` sentinel on the durable runtime | `runner/openworkflow.ts` throws a clear error | `14` |
| Tool throws a non-Error (string, null, object) | Executor coerces to a string log message; doesn't crash internally | `14` |
| Tool returns `undefined` | Recorded; downstream `String(undefined)` = `"undefined"`; no crash | `14` |
| Trigger payload is itself a string containing `{{}}` | Single-pass resolver does NOT re-expand it | `14`, `17`, `18` |
| Env value is a string containing `{{}}` | Same — single-pass; no infinite expansion | `17` |
| Resume payload contains a `{{}}` string | Same — not re-expanded downstream | `18` |
| Tool mutates its `params` argument | Workflow JSON is unaffected on the next run (no shared mutable state) | `18` |
| Two distinct durable workflows registered with the same name | Throws at registration time | `18` |
| Cancelling a paused durable run | `handle.cancel()` is honored — downstream blocks never run | `18` |
| Worker crashes mid-flight | Cached step results are not re-executed; failed step retries on a fresh worker | `08`, `11` |
| Two workflows waiting on the same event name | An `emit` wakes both | `15` |
| `wait_for_event` with a tight timeout and no emitter | Resumes with `timedOut: true` | `15` |
| Emit BEFORE any waiter is parked | Signal is silently dropped (not buffered); waiter eventually times out | `15` |
| 100-block linear chain on durable runtime | Completes in <6s | `14` |
| 100-block fan-out (1 trigger → 100 leaves) | Completes in <6s | `17` |
| 20 concurrent in-memory runs against the same tool | All 20 distinct values land; no race | `18` |
| Block ID 10 KB long | Preserved through apply + execute | `17` |
| Date.now() / non-determinism inside `step.run` | Memoized — observed once across replay | `17` |

---

## ⚠️ OUT OF SCOPE — caller's responsibility

| Attack | Why we don't defend | Mitigation |
| --- | --- | --- |
| **SSRF** — LLM puts `url: "http://169.254.169.254/..."` or `http://localhost:5432/...` into an `http_request` block | The `url` is a `user-or-llm` field by design; an HTTP block must accept arbitrary URLs | The user's `http_request` tool implementation should validate the URL (allowlist, deny RFC 1918 / link-local / `localhost` / cloud metadata IPs). Wrap the built-in tool, don't ship as-is. |
| **Secrets via free-form fields** — `headers: { Authorization: "{{vars.secret}}" }` or stuffing tokens into `body` | The `visibility` flag protects only TOP-LEVEL param names. Free-form objects (HTTP body/headers, transform templates) are intentionally pass-through | Document for users that secrets must come from `{{env.X}}` and not from LLM-written values. Optionally lint workflows for known-secret patterns at apply time |
| **Resource exhaustion via huge payloads** — trigger with a 100 MB body | @thodare/engine doesn't impose request size limits | Set body-size limits on the HTTP route that calls `compiled.run(input)`. Use openworkflow's deadlineAt to bound execution time |
| **Idempotency on in-memory `resume(snapshot, …)`** | The dev-only in-memory executor doesn't track snapshot consumption | Use the durable runtime in production. openworkflow's run-id is unique per `compiled.run()` |
| **Untrusted `code_execute` blocks** | Not implemented yet (roadmap item) | When implemented, gate to admins only; use `isolated-vm` with aggressive CPU/memory caps; treat AI-generated code as hostile |
| **Determinism inside compute tools** — tool calls `Math.random()` *outside* `step.run`-controlled code | The runner wraps the tool's `execute` in `step.run`, so anything inside is memoized correctly. Anything that escapes (timers, side effects from imports) is the tool author's problem | Don't read shared mutable state from tools. Use `ctx.executionId` if you need a stable seed |
| **Hostile workflow document submitted bypass `applyOperations`** | The pure-function apply layer is the only intended entry point; if a caller writes raw JSON to the workflow store, all bets are off | Always run user/LLM input through `applyOperations` before persisting |

---

## 🐛 PRODUCTION GOTCHA — discovered during the 15-min wall-clock demo

`WorkflowRunHandle.result()` defaults to a **5-minute timeout**. Any
workflow longer than that — drip campaigns, multi-day approvals, the
realistic agent-control-panel use case — will throw `Timed out waiting
for workflow run …` from `result()` even though the workflow itself is
alive and parked in Postgres.

The workflow does NOT die — Postgres has the state — but the caller's
process gave up listening. If the caller process is the same as the
worker process, you also lose the worker, orphaning the run.

This finding cost us the first attempt at the 15-minute multi-wait demo.
It surfaced precisely because we ran on real wall-clock instead of
test-suite-fast 1-second waits.

**Mitigation, two options:**

1. Pass an explicit timeout: `handle.result({ timeoutMs: <ms> })`. Set
   it to your worst-case expected duration plus a slack budget. The
   `examples/multi-wait-real-time.ts` demo does this.
2. Don't `await result()` at all for long flows. Persist the run id, let
   the worker process own the run, and query status via the backend
   when the result is actually needed. (This is the pattern any HTTP
   API surface should use anyway — you don't hold an HTTP request open
   for 3 weeks waiting for a human approval.)

```ts
// in examples/multi-wait-real-time.ts:
const expectedMs = WAIT_SECONDS.reduce((a,b)=>a+b,0)*1000 + 5*60*1000;
await handle.result({ timeoutMs: expectedMs });
```

**Proof, with run log preserved at
[`examples/multi-wait-real-time.run.log`](./examples/multi-wait-real-time.run.log)**:

```
+0.2s    "start"
+300.5s  "after-w1"        first 5-min wait survived
+420.4s  >>> worker stopped
+425.4s  >>> worker restarted (5s downtime, run orphaned in PG)
+601.0s  "after-w2"        second 5-min wait survived ACROSS THE RESTART
+901.4s  "done"            third 5-min wait survived
+901.6s  total elapsed: 901.6s = 15:01.6
```

1.6s of overhead total across three 5-minute waits AND a mid-flight
worker restart. With the `result()` timeout fix, the demo runs
end-to-end clean.

---

## 🚧 KNOWN BEHAVIOR (non-issues to flag)

| Behavior | Why | Test |
| --- | --- | --- |
| `{{trigger}}` (no path) returns the whole trigger object intact | Documented resolver behavior — single-key ref returns raw value | `14`, `16` |
| Single-ref `"{{block.field}}"` template returns the raw value (preserves type) | Important so objects don't get JSON-stringified into params unnecessarily | resolver.ts |
| Interpolated `"got [{{x}}] back"` template stringifies, missing → `""` | Symmetric: interpolation is always a string; missing slots become empty | `13` |
| `connection.condition` is stored but **not yet evaluated** by the executor | The current executor uses `sourceHandle` for branch selection. `condition` is a forward-compatibility field for evaluated edges | (no test — feature-flagged) |
| Block `name` aliasing: the resolver tries `id` first, falls back to `name`. If a block's `id` collides with another block's `name`, `id` wins | Predictable, but worth knowing | `17` |

---

## How to extend this document

When a new test reveals a defense or limitation, add a row here. The list
should be exhaustive — anyone reading this should be able to determine, for
any AI-generated workflow they hand to the system, exactly which guarantees
hold.
