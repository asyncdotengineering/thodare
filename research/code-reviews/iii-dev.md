# iii.dev — Deep Code Review

**Reviewer date:** 2026-05-02
**Repo reviewed:** `iii-hq/iii` (cloned shallow to `agent-control-panel/iii/`)
**Stated by:** Motia LLC (the same company behind the Motia framework)
**Tagline:** "A backend unification and orchestration system"
**Pronounced:** "three eye"

---

## 1. What is iii?

iii is a **distributed-execution / backend-unification engine** that collapses what would normally be 6+ separate backend categories (HTTP framework, queue, cron scheduler, pub/sub, KV state, WebSocket server, observability pipeline) into one engine speaking one WebSocket protocol with three primitives:

- **Worker** — a process that connects to the engine over WebSocket and registers capabilities. Workers can be SDK processes (TS/Python/Rust) or built-in workers (`iii-http`, `iii-queue`, `iii-cron`, `iii-state`, `iii-stream`, `iii-pubsub`, `iii-observability`, `iii-exec`, `iii-bridge`, `iii-worker-manager`, `iii-sandbox`).
- **Function** — a named handler (`orders::validate`, `agents::researcher`) that lives in a worker and can be invoked by ID. Function IDs use a `::` separator.
- **Trigger** — a binding declaring "fire this function when X happens." Trigger types: `http`, `cron`, `durable:subscriber` (queue), `state`, `stream:join`, `stream:leave`, `log`, plus user-defined custom types.

The design slogan they keep hammering is "Unix-style universal primitive" — they explicitly compare themselves to Unix's "everything is a file" and React's `Component`. The recent 0.11 release literally renamed internal "modules" to "workers" so that everything in the system has the same name. There is no Worker/Module split anymore — `iii-http` is a worker just like a user-written Python script.

This makes iii **both an orchestrator and the runtime its workloads sit inside**. It is far more ambitious than Temporal (durable execution only) or BullMQ (queue only); it competes with the entire stack of "I'd otherwise wire up Express + BullMQ + node-cron + Redis + Socket.io + OTel."

It is built and licensed by **Motia LLC**, and per the changelog this is a hard pivot: the older Motia framework (Node + Python) is being deprecated/repositioned as "just one worker among many" and there are first-class migration guides (`migrating-from-motia-js.mdx`, `migrating-from-motia-py.mdx`) showing how every Motia abstraction (`http()`, `cron()`, `queue()`, `state()`, `stream()`) maps to direct `iii.registerFunction` + `iii.registerTrigger` calls. iii is the new product. Motia was the prototype that the team is now eating.

---

## 2. Repo at a glance

```
engine/                Rust engine — runtime, routing, protocol, CLI, built-in workers (Elastic License v2)
sdk/packages/node/iii/         TypeScript SDK (Apache-2.0, npm: iii-sdk)
sdk/packages/node/iii-browser/ Browser WebSocket SDK (Apache-2.0)
sdk/packages/python/iii/       Python SDK (Apache-2.0, PyPI: iii-sdk)
sdk/packages/rust/iii/         Rust SDK (Apache-2.0, crates.io: iii-sdk)
console/                       React + Rust developer console (Apache-2.0)
skills/                        26+ Agent skills (auto-discovered by SkillKit)
docs/                          Mintlify/MDX documentation site
crates/                        Auxiliary Rust crates (iii-supervisor, iii-shell-proto, iii-network, iii-tools, motia-tools, scaffolder-core, iii-worker, iii-init, iii-filesystem, iii-shell-client)
infra/terraform/               Cloud deployment infra
website/                       iii.dev marketing site + manifesto
```

This is a **serious monorepo**. Rust workspace via `Cargo.toml`, JS/TS via `pnpm-workspace.yaml`, build orchestration via `turbo.json`. Engine ships as a distroless Docker image (`iiidev/iii`) with SBOM attestation, Trivy scanning, and provenance. There's even a curl-piped installer (`install.iii.dev/iii/main/install.sh`). The `engine/firmware/` directory ships precompiled `libkrunfw` binaries for macOS aarch64, Linux aarch64, and Linux x86_64 — i.e., **iii ships its own microVM firmware** for the `iii-sandbox` worker (libkrun-based).

The repo is highly polished: AGENTS.md for AI coding agents, `.cursor/rules/` and `.cursor/skills/`, lefthook hooks, NOTICE/PATENTS/LICENSE/SPDX, biome + prettier + cargo fmt, a 26-skill `skills/` catalog auto-discovered by SkillKit (works with Claude Code, Cursor, Codex, Gemini CLI, etc.). This team is shipping for the agent-built-software era, not retrofitting.

---

## 3. The core primitive — and the DX surface

The DX is **explicitly** "no decorator, no DSL, no file-scanning, no convention-over-configuration." Just two function calls:

**TypeScript:**
```ts
const iii = registerWorker('ws://localhost:49134', { workerName: 'caller-worker' })

const ref = iii.registerFunction('orders::validate', async (order) => {
  return { ok: true }
})

iii.registerTrigger({
  type: 'http',
  function_id: ref.id,
  config: { api_path: '/orders/validate', http_method: 'POST' },
})
```

**Python:**
```python
iii = register_worker('ws://localhost:49134', InitOptions(worker_name='math-worker'))

iii.register_function('math::add', lambda payload: {'c': payload['a'] + payload['b']})

iii.register_trigger({
    'type': 'http',
    'function_id': 'math::add',
    'config': {'api_path': '/math/add', 'http_method': 'POST'},
})
```

**Rust:**
```rust
iii.register_function((
    RegisterFunctionMessage::with_id("orders::validate".into()),
    |order: Value| async move { Ok(json!({"ok": true})) },
));

iii.register_trigger(IIITrigger::Http(HttpTriggerConfig::new("/orders/validate")
    .method(HttpMethod::Post))
    .for_function("orders::validate"))?;
```

All three SDKs have **identical mental models and identical wire format**. The change from Motia → iii-sdk explicitly *rejected* the file-scanning + magic-`config`-export DX in favor of imperative `registerFunction` / `registerTrigger` calls — the migration doc says this directly: "These conveniences came at a cost: they hid iii's three core primitives behind opaque abstractions that limited what you could build."

This is a deliberate architectural posture: **declarative-via-imperative**. You declare your topology in code (not YAML, not file structure), but each declaration is an explicit function call you can read and `grep`. There is no global registry, no autoscan. The trade-off: no static "what's my system?" without booting it.

But there *is* a runtime introspection answer: the engine itself ships discovery functions:
```ts
await iii.trigger({ function_id: 'engine::functions::list', payload: {} })
await iii.trigger({ function_id: 'engine::workers::list', payload: {} })
```
i.e., the system is its own service registry, queryable in JSON, at runtime. **This is a huge LLM-feedability story.**

---

## 4. The runtime / wire protocol

The engine is **Rust** and exposes three ports:

| Port  | Service                          |
|-------|----------------------------------|
| 49134 | WebSocket — worker connections   |
| 3111  | HTTP API                         |
| 3112  | Stream API (browser WebSocket)   |
| 9464  | Prometheus metrics               |

The protocol (`engine/src/protocol.rs`) is a **flat, tagged, JSON-over-WebSocket message enum** with these message types:

- `RegisterTriggerType`, `RegisterTrigger`, `TriggerRegistrationResult`, `UnregisterTrigger`
- `RegisterFunction`, `UnregisterFunction`
- `InvokeFunction`, `InvocationResult`
- `RegisterService`, `WorkerRegistered`
- `Ping`, `Pong`

Each `RegisterFunction` carries optional `request_format` and `response_format` (JSON Schema) and an `invocation` field that can describe an HTTP-invocable function — meaning **iii can register an external HTTP API as a "function"** (the `iii-http-invoked-functions` skill is exactly this). Every invocation can carry W3C `traceparent` and `baggage` headers natively for OpenTelemetry distributed tracing.

`InvokeFunction` supports an `action` field with two variants:
- `TriggerAction::Enqueue { queue }` — durable, retry-able, FIFO-orderable named-queue invocation
- `TriggerAction::Void` — fire-and-forget
- `(omitted)` — synchronous request/response

So the **same primitive (`iii.trigger(...)`)** does sync RPC, fire-and-forget, and durable enqueue depending on the action flag. This is unusually elegant — Temporal needs `client.execute()` vs `signal()` vs `query()` vs `start()`; iii has one verb.

When a worker disconnects, the engine **automatically unregisters all of its functions and triggers, cancels in-flight invocations to it, and fires `engine::workers-available`**. On reconnect, the SDK re-sends every registration. That is durable orchestration done at the topology layer, not the workflow layer — there is no event-sourced replay (the way Temporal does it), but the registry is self-healing.

---

## 5. Built-in workers — what the engine ships with

The engine ships eleven first-party workers, each a real `Worker` impl in `engine/src/workers/`:

| Worker                  | What it does |
|-------------------------|--------------|
| `iii-http`              | REST API. Owns `:3111`. Provides the `http` trigger type, `api_path` routing, `path_params`, middleware chains (`middleware_function_ids: ['middleware::auth', 'middleware::rate-limit']`), CORS, condition functions. |
| `iii-queue`             | Named + topic queues. Adapters: `builtin` (in-memory or file-backed), `redis`, `rabbitmq`. Three-stage RabbitMQ topology (main / retry-with-TTL / DLQ) is auto-provisioned. Built-in `iii::queue::redrive` function for DLQ replay. |
| `iii-pubsub`            | Topic broadcasting. Adapters: `local`, `redis`. Triggered via `durable:subscriber` triggers. |
| `iii-state`             | Distributed KV. Scope + key model. State changes can fire `state` triggers (reactive). Adapters: `kv` (in-mem or file), `redis`, `bridge`. |
| `iii-cron`              | Cron scheduling with distributed locks (Redis or KV). 7-field expression. |
| `iii-stream`            | WebSocket streams to browsers/clients. `stream:join` / `stream:leave` triggers. Auth function configurable. |
| `iii-observability`     | OpenTelemetry — traces, metrics, logs. `memory`, `otlp`, or `both` exporters. Configurable per-operation/per-service sampling rules with rate limits. Alert rules with metric thresholds and webhook actions. |
| `iii-exec`              | Spawns shell processes (this is how you run external SDK workers — e.g., `bun run --watch src/main.ts`). |
| `iii-bridge`            | Cross-instance bridge — connects two iii engines, exposing/forwarding functions across them. |
| `iii-worker-manager`    | Manages SDK WebSocket connections. |
| `iii-sandbox` (opt-in)  | **Ephemeral microVMs (libkrun)** spun up on demand from OCI images — Python + Node presets, allowlist-gated, idle-timeout, CPU/mem caps. This is how you let untrusted/AI-agent code execute safely. |

The `iii-sandbox` worker is buried in `config.yaml` as a commented block, but it's a big deal — they've shipped libkrun firmware in the binary distribution. **iii has a built-in answer for "let an AI agent run arbitrary code without nuking my engine."**

---

## 6. The state, queue, and stream models — copy/lift candidates

### 6.1 Queues

Two models, same primitive:

- **Named queue:** `iii.trigger({ function_id: 'orders::process', payload, action: TriggerAction.Enqueue({ queue: 'orders' }) })`. Routes to one worker. Used for backpressure, FIFO, retries, concurrency caps.
- **Topic queue:** `iii.trigger({ function_id: 'iii::durable::publish', payload: { topic: 'order.placed', data } })` + `registerTrigger({ type: 'durable:subscriber', config: { topic: 'order.placed' }, function_id: 'orders.handle' })`. Fan-out to N subscribers; replicas of the same function compete on that function's queue.

The retry/DLQ topology on RabbitMQ uses the standard **TTL + dead-letter-exchange bounce** (3 stages × 2 resources = 6 RabbitMQ objects per named queue — they document this transparently with reasoning, including why `nack(requeue=true)` is wrong and why sleeping in the worker is wrong). The builtin (in-process) and Redis adapters implement the same lifecycle without external resources. **Thodare should copy this conceptual model — it's industry-standard and well-rationalised.**

### 6.2 State

`state::get`, `state::set`, `state::delete`, `state::list`, `state::update`, all by triggering built-in functions with `{ scope, key, value }` payloads. State changes fire `state` triggers — i.e., **state is reactive by default**. Trigger conditions can gate (`condition_function_id`).

### 6.3 Streams

`iii-stream` keeps a per-`stream_name` × `group_id` × `item_id` data store and pushes deltas to subscribed WebSocket clients. Browsers connect via `iii-browser-sdk` directly to port 3112 — there is **no REST shim layer between the browser and the engine**. Auth happens via a configurable `auth_function`. Permissions are enforced via Worker-RBAC.

### 6.4 The HTTP `http()` wrapper

For non-JSON HTTP responses (file downloads, SSE, streaming) the SDK exposes an `http()` wrapper that converts the function input/output into a `(req, response)` shape with `response.status()`, `response.headers()`, `response.stream.write()`, `response.stream.end()`. Underneath it uses the channel-based binary streaming primitive (also accessible directly via `ChannelWriter` for arbitrary worker-to-worker binary streams). **This is much cleaner than the way most JSON-first frameworks handle SSE/binary.**

---

## 7. Licensing — the part that matters most for Thodare

This is **Elastic License v2 + Apache-2.0 split**, identical to ElasticSearch / Redis / MongoDB in posture but applied differently:

| Directory | License |
|-----------|---------|
| `engine/` | **Elastic License 2.0 (ELv2)** — source-available, NOT OSI-approved. Cannot be offered as a managed/hosted service to third parties; cannot be modified to circumvent license keys. |
| `sdk/`, `console/`, `docs/`, `website/`, `skills/` | Apache-2.0 |
| Inbound contributions | Apache-2.0 only (per CONTRIBUTING.md and SPDX) |

Translation: the engine itself is **not open-source by OSI standards**. Motia LLC reserves the right to be the sole commercial host of the iii engine. All client-side and integration code is genuinely Apache-2.0.

The `engine/PATENTS` file and the source headers (`// This software is patent protected. We welcome discussions - reach out at support@motia.dev`) make clear that Motia is staking out commercial rights at the engine layer.

**For Thodare this is critical context.** iii is *not* a true OSS engine; it is a single-vendor commercial offering with an open client SDK. If Thodare's value prop is "self-hostable, OSS, headless workflow orchestration," then iii is a **direct competitor with a more permissive marketing story than legal reality**. Thodare can be the Apache-2.0/MIT/AGPL alternative if iii starts charging or if its license-key gating bites.

---

## 8. What overlaps with Thodare?

Honestly, **a lot.**

| Thodare value prop                                   | iii has it? | Notes |
|------------------------------------------------------|-------------|-------|
| Self-hostable                                        | ✅ partial  | Engine runs anywhere, but ELv2 forbids reselling as a service |
| Headless workflow orchestration engine               | ✅          | Functions + named queues + topic queues + state = workflow engine |
| LLM-feedable                                         | ✅✅✅       | Single-page primitive list (3 concepts), JSON-first wire protocol, runtime discovery via `engine::functions::list`, 26 first-party agent skills |
| JSON-first                                           | ✅          | Wire protocol is tagged JSON; payloads are `Value`; req/resp formats are JSON Schema |
| Cross-language                                       | ✅          | TS/Python/Rust SDKs share identical mental model |
| Visual builder ready                                 | ⚠️ partial  | They have the `iii-console` (React + Rust) for inspection — workers, functions, traces, queues, runtime state — but it's an **observation** console, NOT a builder. You can't drag a node and have it write `registerFunction`. |
| Durable execution                                    | ✅ partial  | Queue retries + DLQ + reconnect-rehydration. **Not** event-sourced workflow replay (Temporal-style). No "workflow as a function with deterministic replay." |
| Visual DAG / pipeline                                | ❌          | The graph exists implicitly in the trigger registry — no first-class DAG concept |
| Step-by-step inspector                               | ✅          | OpenTelemetry traces with W3C `traceparent` propagation across SDKs |
| Triggers as data (not code)                          | ⚠️          | Triggers are registered imperatively in code, not stored as YAML/JSON config. But the engine itself stores them as JSON internally and surfaces them via `engine::triggers::list`-style functions. |

The **biggest architectural difference** is that iii does NOT have a "workflow" object. There is no `step.run()`, no `step.sleep()`, no event-sourced determinism, no `Workflow.execute()`. iii's "workflow" is "chain functions via queues + state, observe via OTel." This is more like Encore.dev or Restate than like Temporal/Inngest.

---

## 9. What Thodare can lift

1. **The three-primitive vocabulary** is genuinely good. "Worker / Trigger / Function" maps cleanly to Thodare's domain. The Unix-style "everything is a worker" framing — where the HTTP server *is* a worker registered the same way as a user worker — is excellent for cognitive load.

2. **Function IDs as namespaced strings** (`orders::validate`, `state::get`, `engine::functions::list`). This is far better than UUIDs, file paths, or class names for an LLM-navigable system. Built-ins (`state::*`, `stream::*`, `iii::durable::publish`, `iii::queue::redrive`) live in the same namespace as user code. Thodare should adopt this.

3. **The single `trigger()` verb with an `action` flag** that switches between sync / void / enqueue. This is much cleaner than separate API surfaces for each invocation mode.

4. **The wire protocol** — flat tagged JSON enum over WebSocket with explicit `Register*`/`Invoke*`/`*Result` messages — is small, debuggable, and easy to bridge into other transports. Worth studying `engine/src/protocol.rs` directly.

5. **Runtime self-introspection via built-in functions** (`engine::functions::list`, `engine::workers::list`). LLMs and visual builders can query the live system in JSON without any second control plane. **This is the biggest lift candidate for Thodare's "LLM-feedable + visual-builder-ready" combo.**

6. **JSON-Schema on every function registration** (`request_format`, `response_format`). They use Zod's `z.toJSONSchema()` in TS and Pydantic in Python. A visual builder can consume this directly to render forms.

7. **The middleware-as-function-IDs pattern** (`middleware_function_ids: ['middleware::auth', 'middleware::rate-limit']`). Middleware is just functions referenced by ID, not framework-wired magic. This is composable and visually buildable.

8. **The OpenTelemetry-by-default stance** with W3C trace propagation as a native protocol field, not an afterthought.

9. **Trigger conditions** (`condition_function_id` in trigger config) — gate handler execution by another function. Maps cleanly to a "guard node" in any visual builder.

10. **Skills directory** — they ship 26 agent skills (Claude/Cursor/Codex/Gemini compatible) covering every primitive and pattern. Thodare should ship a `thodare-skills/` tree from day one.

11. **The "everything is a function call" stance** for built-in operations: `state::get` is a function you trigger, not an SDK method. This keeps the surface area minimal and makes every operation traceable in OTel.

---

## 10. What Thodare should deliberately reject

1. **The license model.** Thodare's whole positioning is OSS + self-host. iii's ELv2 engine is a competitive opening — Thodare should explicitly stay Apache-2.0 / MIT (or AGPL if you want copyleft). Don't follow Motia into source-available.

2. **The lack of a workflow primitive.** iii has no notion of a multi-step durable workflow with replay or `step.sleep('1 day')`. Their answer is "use queues + state." For Thodare-as-workflow-engine, this is *the* primitive to add. Look at Inngest or Restate or Temporal for prior art. Don't follow iii's "we have queues, that's enough" stance.

3. **Imperative-only declaration.** iii rejected file-scanning and config-driven topology in their Motia-to-iii migration. For an LLM-fed, visual-builder-ready system, **declarative JSON/YAML topology is actually a feature, not a bug.** Thodare should support BOTH: imperative `registerFunction` for code-first authors AND a declarative `thodare.yaml` (or DB-backed) topology for the visual builder. iii went too far in the imperative direction for Thodare's audience.

4. **Single-engine-instance model.** iii has an `iii-bridge` worker for cross-instance, but it's an afterthought. If Thodare is meant to be self-hostable for *organizations*, multi-tenant / multi-engine federation should be designed in earlier.

5. **Run-it-as-a-binary distribution.** iii ships a Rust binary you `curl | sh` to install. Fine for a developer tool; less great for a managed-by-platform-team install. Thodare's headless angle suggests preferring containers + Helm + operator patterns over CLI binaries.

6. **Coupling of HTTP server to the engine.** `iii-http` is bundled, runs in-process, and owns port 3111. This is convenient but couples concerns. Thodare-as-headless probably wants the HTTP/RPC layer to be a separate optional concern.

7. **The `::` separator in IDs.** Honestly fine, but worth considering whether `:` or `/` or `.` is more LLM-friendly given how often models tokenize `::` as a single token. (Minor.)

8. **The libkrun microVM dependency for sandboxing.** Cool, but Linux/macOS ARM only and 10MB+ of binary firmware shipped in the engine repo. Thodare should consider deferring the sandbox to an external process (e.g., Daytona, e2b, Modal) rather than baking microVM firmware into core.

---

## 11. Reasons the user likely flagged iii.dev for Thodare

The angles in the prompt:

- **Workflow / durable execution related?** ✅ Yes — queues, retries, DLQ, state reactivity, cron, state machines via queue chains. Same problem space as Thodare. **No replay-based durable execution though.**
- **LLM agent framework related?** ✅ Yes — explicit `iii-agentic-backend` skill, `iii-sandbox` for agent code execution, function-ID-based discovery for LLM context, 26 SkillKit skills. The manifesto literally says "agents become first-class workers."
- **Visual builder related?** ⚠️ Partial — they have an inspection console but no node-based builder. The wire format and JSON-Schema-per-function are visual-builder-ready raw materials.
- **TypeScript framework related?** ✅ Yes — `iii-sdk` for Node + browser. But the engine is Rust and the SDKs are tri-language by design.

The most relevant overlap is the **LLM-feedable + JSON-first + headless-engine** combination. iii is essentially what Thodare wants to be at the *primitive* layer, minus the workflow durability story and minus the OSS license. **This is direct prior art and worth studying as both inspiration and competition.**

---

## 12. Concrete files worth re-reading later

- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/engine/src/protocol.rs` — the wire format
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/engine/config.yaml` — the engine config schema (workers + adapters)
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/docs/architecture/engine.mdx` — engine routing and reload semantics
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/docs/architecture/queues.mdx` — RabbitMQ 3-stage topology rationale
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/docs/architecture/trigger-types.mdx` — full trigger type catalog with TS/Python/Rust examples
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/docs/changelog/0-11-0/migrating-from-motia-js.mdx` — explains the Motia → iii pivot rationale
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/docs/changelog/0-11-0/everything-is-a-worker.mdx` — the "rename modules to workers" architectural commit
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/skills/SKILLS.md` — the 26-skill catalog (a model for what Thodare's skill kit could look like)
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/skills/iii-agentic-backend/SKILL.md` — explicitly compares iii to LangGraph / CrewAI / AutoGen / Letta
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/AGENTS.md` — model for Thodare's own AGENTS.md
- `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/LICENSE.spdx` and `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/iii/engine/LICENSE` — the ELv2 split
