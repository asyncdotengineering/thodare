# Code review — `@cloudflare/dynamic-workflows@0.1.1`

Repo: `cloudflare/dynamic-workflows` (MIT, 2026; published 2026-05-01).
Local checkout: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/dynamic-workflows`.
Total runtime source: ~300 LOC across four files in `packages/dynamic-workflows/src/`.

This review walks every file line-by-line, summarizes every test, and finishes with a concrete sketch of what a Thodare `world-cloudflare-dynamic` adapter built on top of this library would look like.

---

## 1. Public surface (every exported symbol)

Public surface, taken verbatim from `packages/dynamic-workflows/src/index.ts` (lines 25–40):

```ts
export {
  DynamicWorkflowBinding,
  dispatcherBindingImpl as _dispatcherBindingImpl,
  wrapWorkflowBinding,
} from './binding.js';
export {
  createDynamicWorkflowEntrypoint,
  dispatchWorkflow,
  MissingDispatcherMetadataError,
} from './entrypoint.js';
export type {
  DispatcherMetadata,
  LoadWorkflowRunner,
  LoadWorkflowRunnerContext,
  WorkflowRunner,
} from './types.js';
```

That is the entire surface. Notably absent from `index.ts`: `DispatcherEnvelope`, `WorkflowEventLike`, `WorkflowStepLike`, `wrapParams`, `unwrapParams`. The README and `AGENTS.md` (lines 32–38) are explicit that those are internal — the structural Workflow types exist purely so the library does not need to take a hard dependency on a specific `@cloudflare/workers-types` version.

| Symbol | Location | Signature | Role |
|---|---|---|---|
| `wrapWorkflowBinding(metadata, options?)` | `binding.ts:259-274` | `(metadata: DispatcherMetadata, options?: { bindingName?: string }): Workflow` | Returns a `Workflow`-shaped RPC stub that injects `{ __dispatcherMetadata, params }` on every `create`/`createBatch`. Looks up `DynamicWorkflowBinding` on `cloudflare:workers` `exports`; throws if not re-exported. |
| `DynamicWorkflowBinding` | `binding.ts:183-203` | `class extends WorkerEntrypoint<Record<string, unknown>, DynamicWorkflowBindingProps>` | RPC class the runtime instantiates per call to give `wrapWorkflowBinding` a serialisable stub. Must be re-exported from the dispatcher's main module so `cloudflare:workers` `exports` contains it. |
| `_dispatcherBindingImpl(getBinding, metadata)` | `binding.ts:129-156` | `(() => Workflow, DispatcherMetadata) => Workflow` | The plain-object guts of the binding wrapper, factored out for unit tests. Underscore-prefixed; "not covered by semver guarantees" per `index.ts:24`. |
| `createDynamicWorkflowEntrypoint<Env, Params, Result>(loadRunner)` | `entrypoint.ts:104-124` | `(loader): typeof WorkflowEntrypoint<Env, Params>` | Returns a real `WorkflowEntrypoint` subclass whose `run(event, step)` calls `dispatchWorkflow`. Register as `class_name` in `[[workflows]]`. |
| `dispatchWorkflow(context, event, step, loadRunner)` | `entrypoint.ts:55-80` | `({env, ctx}, event, step, loader) => Promise<Result>` | Lower-level primitive — unwraps the envelope, calls the loader, forwards `run(innerEvent, step)`. Exposed for users who want to subclass `WorkflowEntrypoint` themselves. |
| `MissingDispatcherMetadataError` | `entrypoint.ts:23-31` | `class extends Error` | Thrown by `dispatchWorkflow` when the event payload is not a `{ __dispatcherMetadata, params }` envelope. |
| `DispatcherMetadata` | `types.ts:26` | `Record<string, unknown>` | Whatever JSON-serialisable bag the dispatcher tags onto every `create`. The library never inspects it. |
| `WorkflowRunner<T, R>` | `types.ts:62-64` | `{ run(event: WorkflowEventLike<T>, step: WorkflowStepLike): Promise<R> }` | Structural target of the loader — anything with a `run` method works. The expected production shape is `stub.getEntrypoint('TenantWorkflow')`. |
| `LoadWorkflowRunnerContext<Env>` | `types.ts:74-78` | `{ metadata, env, ctx }` | The single arg the loader callback receives. |
| `LoadWorkflowRunner<Env, T, R>` | `types.ts:88-90` | `(ctx) => Promise<WorkflowRunner<T, R>> \| WorkflowRunner<T, R>` | Sync or async loader; both are accepted (`entrypoint.test.ts:143-156` exercises the sync path). |

Internal-but-load-bearing types defined in `types.ts` and never re-exported: `DispatcherEnvelope<T>` (`types.ts:32-35`, the `{ __dispatcherMetadata, params }` shape), `WorkflowEventLike<T>` (`types.ts:41-45`), `WorkflowStepLike` (`types.ts:52`, just `object` — the library never inspects step). Internal helpers in `binding.ts`: `wrapParams` (`75-80`), `unwrapParams` (`91-107`), `InstanceStub` (`32-65`), `wrapInstance` (`67-69`), `resolveBinding` (`158-167`), `DynamicWorkflowBindingProps` interface (`117-120`), `ExportsWithBinding` interface (`210-212`), `WrapWorkflowBindingOptions` interface (`217-226`).

---

## 2. `wrapWorkflowBinding` — line-by-line walkthrough

The user-visible function is short (`binding.ts:259-274`). It does three things and only three things:

```ts
export function wrapWorkflowBinding(
  metadata: DispatcherMetadata,
  options: WrapWorkflowBindingOptions = {}
): Workflow {
  const exports = workersExports as unknown as Partial<ExportsWithBinding>;
  const factory = exports.DynamicWorkflowBinding;
  if (typeof factory !== 'function') {
    throw new Error(
      'dynamic-workflows: `DynamicWorkflowBinding` is not registered on ' +
        "`cloudflare:workers` exports. Add `export { DynamicWorkflowBinding } from 'dynamic-workflows';` " +
        "to your dispatcher's main module."
    );
  }
  const bindingName = options.bindingName ?? 'WORKFLOWS';
  return factory({ props: { bindingName, metadata } });
}
```

Step by step:

1. **Read `cloudflare:workers` `exports`** (`binding.ts:263`). When a Worker re-exports `DynamicWorkflowBinding` at top level, the runtime registers it as a `WorkerEntrypoint` class on `cloudflare:workers` `exports.DynamicWorkflowBinding`. That entry is callable as a *factory* — `factory({ props })` returns an RPC stub with the `WorkerEntrypoint` interface.
2. **Validate the re-export** (`264-271`). If the consumer forgot to `export { DynamicWorkflowBinding }`, the factory is missing and the call throws synchronously at dispatcher boot time. This is a fail-fast-at-startup check, not a per-request one.
3. **Default `bindingName` to `WORKFLOWS`** (`272`).
4. **Construct an entrypoint stub specialised with `{ bindingName, metadata }`** (`273`). Per Cloudflare runtime semantics, `props` is plumbed into the new `WorkerEntrypoint` via `this.ctx.props`. The stub returned is structurally a `Workflow` (it has `create`, `createBatch`, `get`).

Crucially, `wrapWorkflowBinding` does **not** capture the real `Workflow` binding. It captures only its **name**. That is forced by Workers RPC: a `Workflow` binding is not structured-clonable, so it cannot be a `prop`. Instead, every call into the stub re-resolves the binding off `this.env[bindingName]` (`binding.ts:188-189`), which means the stub only works inside a worker that itself has a `WORKFLOWS` Workflow binding declared. That worker is the dispatcher.

The stub returned from `wrapWorkflowBinding` is therefore a thing that, when invoked from a tenant's loaded worker, RPCs back into the dispatcher worker, which then calls the real `WORKFLOWS` binding. That round-trip is the price of crossing the Worker Loader boundary.

When `.create(options)` is invoked on the stub, control flows into `DynamicWorkflowBinding.create` (`binding.ts:192-194`), which delegates to `dispatcherBindingImpl(...).create(...)`. `dispatcherBindingImpl` (`129-156`) is a thin closure-style implementation that wraps every `create`/`createBatch` call's `params` through `wrapParams` (`75-80`):

```ts
export function wrapParams<T>(params: T, metadata: DispatcherMetadata): DispatcherEnvelope<T> {
  return { __dispatcherMetadata: metadata, params };
}
```

The wrapped `WorkflowInstance` returned from `create` is then re-wrapped by `wrapInstance` (`67-69`) into an `InstanceStub` (`32-65`) — a small `RpcTarget` subclass that exposes `id`, `status`, `pause`, `resume`, `terminate`, `restart`, `sendEvent`. The reason: the native instance returned from `binding.create()` is not RPC-serialisable, so an `RpcTarget` shim is needed before sending it back across the Worker Loader boundary to tenant code. Note the explicit comment at `binding.ts:34-36`: `id` is implemented as a *prototype getter* (not an own property) because `RpcTarget` only exposes prototype members over RPC. This is a sharp edge: any consumer who tries to do their own instance-stub will trip on this rule.

`get(id)` is the same as `create`, minus the envelope: it just looks up the workflow and returns it inside an `InstanceStub` (`152-154`). No metadata is touched on `get`, which is correct — the library is all about routing *new* runs, not finding existing ones.

What `wrapWorkflowBinding` does **not** do:

- It does not store anything beyond `{ bindingName, metadata }`.
- It does not validate the metadata shape (it's just `Record<string, unknown>`; metadata could be `{}`, that would not throw, you would just get unroutable workflows).
- It does not sign or HMAC the metadata. There is no integrity check on the persisted envelope; tenant code that goes around the wrapper and writes its own envelope to the raw binding could spoof any metadata it wanted.
- It does not lazily create the binding — `factory({ props })` is called once per call to `wrapWorkflowBinding`, but the stub is cheap and the typical pattern (see the example) is to call `wrapWorkflowBinding` inside a `LOADER.get` callback that itself is cached.

---

## 3. `dispatchWorkflow` — line-by-line walkthrough

`entrypoint.ts:55-80`:

```ts
export async function dispatchWorkflow<Env, Params, Result>(
  context: { env: Env; ctx: ExecutionContext },
  event: WorkflowEventLike<unknown>,
  step: WorkflowStepLike,
  loadRunner: LoadWorkflowRunner<Env, Params, Result>
): Promise<Result> {
  const unwrapped = unwrapParams<Params>(event.payload);
  if (unwrapped === null) {
    throw new MissingDispatcherMetadataError();
  }

  const { metadata, params } = unwrapped;

  const innerEvent: WorkflowEventLike<Params> = {
    payload: params,
    timestamp: event.timestamp,
    instanceId: event.instanceId,
  };

  const runner = await loadRunner({
    metadata,
    env: context.env,
    ctx: context.ctx,
  });
  return runner.run(innerEvent, step);
}
```

Order of operations on every `run`:

1. **Unwrap the envelope from `event.payload`** (`61`). `unwrapParams` (`binding.ts:91-107`) requires the payload to be a non-null object containing both `__dispatcherMetadata` and `params`. If either is missing, returns `null`.
2. **Throw `MissingDispatcherMetadataError`** if not an envelope (`62-64`). The error message guides the caller to `wrapWorkflowBinding`.
3. **Reconstruct the inner `WorkflowEvent` for the tenant** (`68-72`). The tenant only ever sees `{ payload: <its own params>, timestamp, instanceId }` — the dispatcher metadata is stripped. `timestamp` and `instanceId` are passed through verbatim, so the tenant sees the same instance identity as the engine.
4. **Call the loader with `{ metadata, env, ctx }`** (`74-78`). `await` works for both sync and async loaders — `LoadWorkflowRunner` is typed as `Promise<R> | R`.
5. **Forward `run(innerEvent, step)` to the runner** (`79`). The `step` object passed in is forwarded as-is — the library treats it as opaque (`types.ts:48-52`), which means `step.do`, `step.sleep`, `step.sleepUntil`, `step.waitForEvent` all reach the tenant unchanged. This is what makes the library "transparent" with respect to Workflows GA.

Two important properties of this flow:

- **The loader is invoked on every `run` call**. Workflows runs may resume after hibernation (or after the worker isolate has been recycled), and each resume triggers a fresh invocation of the dispatcher's `run`, which calls the loader again. This is verified by `entrypoint.test.ts:186-207` ("invokes the loader fresh for every call"). The loader must be cheap or aggressively cache.
- **Errors from both the loader and the runner are propagated unchanged** (`entrypoint.test.ts:158-184`). The library doesn't swallow exceptions; the engine sees whatever the tenant throws.

`createDynamicWorkflowEntrypoint` (`entrypoint.ts:104-124`) wraps `dispatchWorkflow` in a real `WorkflowEntrypoint` subclass. The implementation has one TS gymnastic: because `WorkflowEntrypoint` is a generic class type, you cannot directly `extends` it with arbitrary `Env`/`Params` parameters, so the code `extends` a cast-to-constructor variant (`109-111`) and re-casts the result on the way out (`123`). That cast is harmless at runtime — `WorkflowEntrypoint` is a normal class — but it does mean type errors in user code that subclasses the *result* would surface as cryptic constructor-signature mismatches.

---

## 4. The envelope (verbatim TS + annotated payload)

From `types.ts:32-35`:

```ts
export interface DispatcherEnvelope<T = unknown> {
  __dispatcherMetadata: DispatcherMetadata;
  params: T;
}
```

`DispatcherMetadata` is just `Record<string, unknown>` (`types.ts:26`).

A real persisted `event.payload` for a Workflow run created by the basic example would look like:

```jsonc
{
  // Injected by wrapWorkflowBinding({ runId: "..." }) — opaque to the library.
  "__dispatcherMetadata": {
    "runId": "0a4e51b2-1c13-4d3d-9f5b-7c0c2d1e9f12"
  },
  // The tenant's original params that they passed to env.WORKFLOWS.create({ params }).
  "params": {
    "name": "world"
  }
}
```

This blob is what Cloudflare Workflows persists as `event.payload` — it survives across hibernations, retries, and isolate recycles. The README (`README.md:168`) is explicit about the implications: "Workflows persists `event.payload`. That payload is the dispatcher envelope, metadata included. Don't put secrets in metadata, and treat it as routing hints, not authorization — tenant code can read it back via `instance.status()`." The source enforces *nothing* about this — the metadata is plaintext, unsigned, and the tenant can read it back through any normal Workflows API that exposes the original params (notably `instance.status()` returns the original params under `output`/`params` depending on engine version).

---

## 5. The example end-to-end (`examples/basic`)

The example dispatcher in `examples/basic/src/index.ts` is *not* the canonical "two hardcoded tenants" thing the `AGENTS.md` describes (line 28) — it is an interactive code-execution playground. It's still the right pattern, just more elaborate.

`wrangler.jsonc` (`examples/basic/wrangler.jsonc:1-28`) declares:

- `worker_loaders: [{ binding: "LOADER" }]` — gives the dispatcher a `WorkerLoader` binding to dynamically load tenant code.
- `workflows: [{ name: "dynamic-workflow", binding: "WORKFLOWS", class_name: "DynamicWorkflow" }]` — registers the single Workflow class. `class_name: "DynamicWorkflow"` matches the `export const DynamicWorkflow` in `index.ts:91`.
- `migrations: [{ tag: "v1", new_classes: ["LogSession"] }]` — declares the `LogSession` Durable Object. Notably, there is **no** `durable_objects.bindings` block; the example uses the new `cloudflare:workers` `exports.LogSession.getByName(...)` pattern instead (see `logging.ts:73-75`).
- `compatibility_flags: ["experimental"]` — required for streaming tails.

A request flow walkthrough, starting from `POST /api/run` in the dashboard:

1. **Browser POSTs `{ source, payload }`** to the dispatcher (`index.ts:126-169`).
2. **Dispatcher allocates `runId = crypto.randomUUID()`** (`index.ts:138`). This single id is reused as (a) the Workflow instance id, (b) the `LogSession` DO key, (c) the Worker Loader cache key.
3. **Source is stashed in `LogSession`** (`index.ts:141`). This is the recovery path — if the loader cache misses on a future workflow resume, `loadTenantWorker` (`index.ts:52-81`) re-fetches the source from the DO.
4. **`loadTenantWorker(env, runId)` is called** (`index.ts:143`). It calls `env.LOADER.get('run-' + runId, async () => ({...}))` — Worker Loader caches by id, so subsequent calls with the same id return the cached isolate without re-running the loader callback. The loader returns a config that includes `env: { WORKFLOWS: wrapWorkflowBinding({ runId }) }` (`index.ts:69`). This is the wrapped binding tagged with this run's id.
5. **`stub.getEntrypoint().fetch(...)`** is called against the tenant's default fetch handler (`index.ts:149-155`). The tenant runs `await env.WORKFLOWS.create({ id: runId, params: payload })` (see `default-source.ts:67-68`). That `create` call:
   - flows out of the tenant isolate, across the Worker Loader RPC boundary,
   - into `DynamicWorkflowBinding.create` running in the dispatcher isolate,
   - which calls `dispatcherBindingImpl({ getBinding: () => env.WORKFLOWS, ... }).create(...)`,
   - which calls the real `env.WORKFLOWS.create({ id, params: { __dispatcherMetadata: { runId }, params: <payload> } })`,
   - and returns an `InstanceStub` (`binding.ts:32-65`) wrapping the real instance.
6. **The Workflows engine schedules the run.** Some time later (could be milliseconds; could be days for long-running workflows), the engine invokes `DynamicWorkflow.run(event, step)` on the dispatcher worker.
7. **`DynamicWorkflow.run` is the class returned from `createDynamicWorkflowEntrypoint`** (`index.ts:91-98`). Its `run` calls `dispatchWorkflow`, which unwraps `event.payload` to recover `{ metadata: { runId }, params: <payload> }`, then calls the consumer's `loadRunner` callback (`index.ts:91-98`):
   ```ts
   ({ env, metadata }) => {
     const runId = metadata['runId'] as string;
     const stub = loadTenantWorker(env, runId);
     return stub.getEntrypoint('TenantWorkflow') as unknown as WorkflowRunner;
   }
   ```
   `loadTenantWorker` is the same function as before — Worker Loader cache hit returns the same isolate; cache miss reloads from the DO-stored source.
8. **`stub.getEntrypoint('TenantWorkflow')`** returns a `Fetcher`-like RPC stub that *also* satisfies `WorkflowRunner` (it has a `run(event, step)` method by virtue of being a `WorkflowEntrypoint` subclass on the tenant side). The cast `as unknown as WorkflowRunner` is the load-bearing type laundering — it works because the tenant's `TenantWorkflow extends WorkflowEntrypoint` and exposes `run` over RPC.
9. **`runner.run(innerEvent, step)`** crosses the RPC boundary back into the tenant isolate. The tenant sees `event.payload === <its original params>` and a working `step` object. `step.do`, `step.sleep`, `step.sleepUntil`, `step.waitForEvent` all behave normally because the dispatcher is forwarding the engine's real `step` object unchanged.
10. **Logs flow out via the Tail Worker.** The loader config (`index.ts:78`) attaches `streamingTails: [exports.DynamicWorkerTail({ props: { runId } })]`. Every `console.log` from the tenant fires `DynamicWorkerTail.tailStream` (`logging.ts:194-226`), which RPCs into `LogSession.push(entries)`, which fans out to any connected SSE subscribers.

The pattern that matters for Thodare: the dispatcher reuses *the same* `loadTenantWorker` function from both its `fetch` handler (to start a run) *and* its `DynamicWorkflow.run` handler (to handle each `run`). Worker Loader's isolate cache makes that cheap. The only data the dispatcher needs to recover the tenant code on a fresh isolate is `runId` (everything else is in the DO).

---

## 6. The tests (every test summarized)

### `packages/tests/src/binding.test.ts`

Covers `_dispatcherBindingImpl` (the plain-object guts of `wrapWorkflowBinding`). The tests note (lines 4–11) that `DynamicWorkflowBinding` itself can't be instantiated in unit tests because workerd refuses to construct a `WorkerEntrypoint` outside a real RPC call — so the tests target the impl factory directly.

| Test (line) | Asserts |
|---|---|
| `injects metadata into create() params` (52) | `wrapped.create({ id, params })` calls underlying `create` with `params: { __dispatcherMetadata: { tenantId }, params: <orig> }` and preserves `id`. |
| `injects metadata when create() is called with no options` (66) | `wrapped.create()` (no args) still produces an envelope with `params: undefined`. |
| `injects metadata when create() has no params` (78) | `wrapped.create({ id })` (id but no params) still envelopes; `params` field is `undefined`. |
| `passes arbitrary metadata shapes` (91) | Metadata can be deeply nested objects, arrays, multiple keys. The library does no normalisation. |
| `injects metadata into every item of createBatch()` (112) | `createBatch([a, b, c])` envelopes each item independently; instance ids preserved in order. |
| `forwards get() unchanged` (135) | `wrapped.get(id)` calls underlying `get(id)` with no envelope; returned instance's `id` preserved. |
| `returns instances unchanged from the underlying binding` (145) | The instance shape (specifically `.id`) is whatever the underlying binding returns. (Note: in the unit test the underlying instance is plain-object — `wrapInstance`'s `RpcTarget` wrap is not exercised here because that requires workerd RPC.) |
| `does not mutate the caller-provided options` (158) | The user's `options` object is not mutated; `options.params` retains its original reference. |
| `does not double-wrap if the same wrapped binding is used twice` (169) | Two successive `create` calls each produce a single-layer envelope — there is no accidental re-envelope. |
| `resolves the underlying binding lazily on every call` (182) | `getBinding()` is invoked once per `create`/`get` call (3 calls → 3 lookups). This matters because the real `DynamicWorkflowBinding` re-reads `this.env[bindingName]` on every call. |

### `packages/tests/src/entrypoint.test.ts`

Covers `dispatchWorkflow` and a smoke test of `createDynamicWorkflowEntrypoint`.

| Test (line) | Asserts |
|---|---|
| `unwraps metadata from the event and passes it to the loader` (40) | Loader receives the `metadata` that was on the envelope; runner result is returned. |
| `passes env and ctx through to the loader` (58) | The dispatcher's `env` and `ctx` are forwarded verbatim to the loader callback. |
| `delivers the unwrapped params to the dynamic worker` (80) | The runner's `run` is called with `event.payload === <unwrapped params>`, and `instanceId` + `timestamp` carry through. |
| `forwards the WorkflowStep object untouched` (102) | The exact `step` reference passed into `dispatchWorkflow` is the one the runner receives. (This is the key "transparency" guarantee — `step.do` etc. are not wrapped.) |
| `throws MissingDispatcherMetadataError when the payload is not an envelope` (124) | A bare `{ not: 'envelope' }` payload throws. |
| `throws MissingDispatcherMetadataError on null payload` (135) | `payload: null` throws. |
| `supports synchronous loaders returning a runner directly` (143) | `LoadWorkflowRunner` may return either a `WorkflowRunner` or `Promise<WorkflowRunner>`. |
| `propagates errors thrown by the loader` (158) | Loader errors bubble; the library does not swallow or wrap them. |
| `propagates errors thrown by the dynamic worker run()` (171) | Runner errors bubble; the library does not swallow or wrap them. |
| `invokes the loader fresh for every call` (186) | The loader is called per `dispatchWorkflow` call — there is no internal memoisation. Two different envelopes with different `tenantId`s correctly route to different runners. |
| `returns a class that extends WorkflowEntrypoint` (211) | `Klass.prototype` is `instanceof WorkflowEntrypoint`. |
| `overrides the run method` (222) | `Klass.prototype.run !== WorkflowEntrypoint.prototype.run`. |

The test harness (`packages/tests/wrangler.toml` + `vitest.config.ts`) runs in workerd via `@cloudflare/vitest-pool-workers`. The minimal worker (`src/index.ts`) re-exports `DynamicWorkflowBinding` so `wrapWorkflowBinding` would work if invoked inside a test (no test currently does — the unit tests exercise the impl directly).

The notable absences:

- **No end-to-end test** that exercises `wrapWorkflowBinding` → `WorkflowEntrypoint.run` with a real `WorkerLoader`. The two halves of the dance are tested in isolation.
- **No test** for `DynamicWorkflowBinding`'s RPC-stub behaviour (the `InstanceStub`, the prototype-getter `id`). That code path is exercised only by the example.
- **No test** asserting that `wrapWorkflowBinding` throws when `DynamicWorkflowBinding` is not re-exported. (The `factory !== 'function'` guard at `binding.ts:265-271` is uncovered.)

---

## 7. What the library does NOT do (limitations imposed by the source)

Comparing the README's marketing to the code:

- **No metadata signing or integrity check.** The envelope is plain JSON. Tenant code could write to a raw `Workflow` binding (if it had one) and forge any metadata. The README acknowledges this (`README.md:168`); the source enforces nothing.
- **No tenant isolation enforcement.** The library trusts the loader callback completely — `loadRunner({ metadata })` is whatever the dispatcher wrote. If the dispatcher's loader callback maps `metadata.tenantId` → tenant code without authorisation checks, anyone who can call `env.WORKFLOWS.create(...)` from inside any tenant can spoof metadata for another tenant by going around the wrapper. **Security boundary**: the wrapper is a *convenience*, not a sandbox.
- **No support for non-`WorkflowEntrypoint` workflows.** `WorkflowRunner` is just `{ run(event, step) }` — but the realistic shape consumers will produce is `stub.getEntrypoint('Foo')`, which only works if the tenant exports a `WorkerEntrypoint`/`WorkflowEntrypoint`-style class. There is no helper for "workflow defined as a plain function".
- **No support for binding names other than via `options.bindingName`.** A dispatcher with multiple Workflow bindings needs one wrapped binding per name; there's no multiplexing.
- **No envelope versioning.** The envelope schema is `{ __dispatcherMetadata, params }` — if Cloudflare ever needs to evolve it, persisted workflows started under v0.1.x would fail to unwrap.
- **Loader is invoked on every `run` call.** No internal cache. The example deals with this by relying on Worker Loader's own isolate cache, but a naive implementation that fetches code from D1/KV in the loader will incur that round-trip on every step-resume. The `noUncheckedIndexedAccess` and other strict TS settings (`tsconfig.base.json:14-22`) are nice; they don't compensate for the missing cache.
- **`get(id)` is not metadata-aware.** Looking up an existing instance returns the raw stub — without re-routing through the dispatcher, you can't ask "give me the tenant view of this run". The tenant calling `env.WORKFLOWS.get(id).status()` will see the persisted envelope under `params`, not their own params.
- **Worker Loader cache is opaque.** The README claims hibernation/retries "just work". They do, *as long as the loader is idempotent and the cached isolate is still warm*. If the cached isolate is recycled mid-run, the next resume will re-invoke the loader — and if the loader fetches "the latest tenant code" rather than "the code that was active when this run started", the resume will silently pick up the new code. The basic example sidesteps this by storing the source in a per-run DO (`logging.ts:102-107`); this is the recommended pattern but not enforced.
- **No retries / circuit-breaking around `loadRunner`.** A loader that throws causes the entire workflow `run` to throw, which falls into Workflows' own retry semantics — but that's the engine's behaviour, not the library's.
- **No telemetry hooks.** The library has no logging, no metrics, no `onLoad`/`onDispatch` callbacks. Consumers wanting observability must wrap `dispatchWorkflow` themselves.

These are not bugs — the library is intentionally tiny — but a Thodare adapter has to fill the gaps.

---

## 8. Implications for Thodare's `world-cloudflare-dynamic`

The proposal sketch (Thodare's `world-abstraction-proposal.md`, T5: "one generic runtime workflow") maps cleanly onto this library. Concretely:

**Dispatcher worker** (`world-cloudflare-dynamic/src/index.ts`):

```ts
import {
  createDynamicWorkflowEntrypoint,
  DynamicWorkflowBinding,
  wrapWorkflowBinding,
  type WorkflowRunner,
} from '@cloudflare/dynamic-workflows';

export { DynamicWorkflowBinding };

interface Env {
  WORKFLOWS: Workflow;
  LOADER: WorkerLoader;
  THODARE_DB: D1Database;     // workflow JSON storage
  THODARE_KV?: KVNamespace;   // optional cache
}

interface ThodareMetadata {
  workflowId: string;
  organizationId: string;
  workflowVersion: string; // pin to immutable version
}

async function loadOrgRunner(env: Env, meta: ThodareMetadata): Promise<WorkerStub> {
  return env.LOADER.get(
    `org-${meta.organizationId}-wf-${meta.workflowId}@${meta.workflowVersion}`,
    async () => {
      const wfJson = await env.THODARE_DB.prepare(
        'SELECT definition FROM workflows WHERE org_id = ? AND id = ? AND version = ?'
      ).bind(meta.organizationId, meta.workflowId, meta.workflowVersion).first<{definition: string}>();
      if (!wfJson) throw new Error('Workflow not found');
      return {
        compatibilityDate: '2026-01-28',
        mainModule: 'index.js',
        modules: { 'index.js': THODARE_RUNTIME_BUNDLE },
        env: {
          WORKFLOWS: wrapWorkflowBinding({
            workflowId: meta.workflowId,
            organizationId: meta.organizationId,
            workflowVersion: meta.workflowVersion,
          }),
          THODARE_WORKFLOW_JSON: wfJson.definition,
          // org-scoped secrets, bindings, etc.
        },
        globalOutbound: null,
      };
    }
  );
}

export const ThodareWorkflow = createDynamicWorkflowEntrypoint<Env>(
  async ({ env, metadata }) => {
    const stub = await loadOrgRunner(env, metadata as ThodareMetadata);
    return stub.getEntrypoint('ThodareRuntimeWalker') as unknown as WorkflowRunner;
  }
);

export default {
  async fetch(request: Request, env: Env) {
    // POST /v1/workflows/:id/runs — looks up org from auth, dispatches.
    // ...
  },
};
```

**Where Thodare's workflow JSON lives**: D1 (per-org row, per-version row) is the natural fit — the dispatcher reads it inside the loader callback on cache miss. KV could be a read-through cache. The Thodare runtime walker bundle (the WASM/JS engine that interprets workflow JSON) is a *single* JS module compiled into the dispatcher as `THODARE_RUNTIME_BUNDLE` and shipped as `modules['index.js']` to every loaded worker. The walker reads `env.THODARE_WORKFLOW_JSON` at module scope (or in its `WorkflowEntrypoint` constructor) and walks it inside `run(event, step)`.

**Per-organization scoping**: the metadata bag carries `organizationId`. Worker Loader cache keys MUST include `organizationId` (the example above does this) so that a compromised tenant cannot somehow get cached against another org's id. Per the security caveat in §7, a naive loader is *not* a security boundary on its own — the dispatcher must look up `(workflowId, organizationId)` together against the DB and reject mismatches. **Pin the workflow version in metadata** so that mid-run edits to a workflow definition don't change semantics on the next step (this is the same reason the basic example stashes source in a DO — Thodare gets it for free if every run pins `workflowVersion`).

**The `WorkflowRunner` Thodare hands back**: a class `ThodareRuntimeWalker extends WorkflowEntrypoint` defined in the runtime bundle. Its `run(event, step)` reads `env.THODARE_WORKFLOW_JSON`, walks the steps, and uses `step.do` / `step.sleep` / `step.waitForEvent` for each node. Because `dispatchWorkflow` forwards the `step` object unchanged (verified by `entrypoint.test.ts:102-122`), the walker gets full Workflows GA semantics — durable steps, sleep, hibernation, event-driven resume.

**Is the pattern as clean as the proposal claims?** Mostly yes, with three caveats the proposal needs to address:

1. **One Workflow registration per Cloudflare account.** The library does not lift the limit on `class_name` per workflow binding — it just hides it. Thodare's `world-cloudflare-dynamic` deploys exactly one Cloudflare Workflow class. That is the win. But it also means *all* of Thodare's customers' workflows on Cloudflare share one Workflows engine queue and quota slot. Cloudflare's per-account Workflow concurrency caps therefore become a per-tenant noisy-neighbour vector. The library does nothing to mitigate this.
2. **Loader-on-every-step cost.** Every `step.do` resume invokes the dispatcher's `run`, which invokes the loader. The example relies on Worker Loader's isolate cache to make this O(1). For Thodare, that means the runtime bundle + per-org D1 lookup happens on cold caches — the loader callback should be aggressively memoised in-process and the workflow JSON itself should be considered immutable once a run starts (hence the version-pinning recommendation above).
3. **Metadata is plaintext, persisted, tenant-readable.** Per `README.md:168` and §7. Anything the dispatcher puts in metadata is visible to the tenant via `instance.status()` and survives forever in Workflows storage. For Thodare, putting `{ organizationId, workflowId, workflowVersion }` is fine — none of those are secrets — but do **not** put API keys, tokens, or per-run encrypted payloads there.

**License + vendoring**: MIT, copyright Dan Lapid 2026. The library is small enough (~300 LOC) that vendoring it inside Thodare's `world-cloudflare-dynamic` package is mechanically trivial. If Thodare ships it as a vendored dep, retain `LICENSE` text alongside the vendored source and add an `ATTRIBUTIONS.md` entry. The cleaner path is to take a hard dep on `@cloudflare/dynamic-workflows@^0.1.1` and pin a known-good version — the package surface is small, the API is unstable (0.1.x), and Cloudflare publishes through its own org so supply-chain risk is bounded. The `_dispatcherBindingImpl` underscore export tells you the maintainers expect to break it; do not import it.

---

## 9. Known unknowns (verify before committing)

These are things the source does not answer and a Thodare engineer must validate against the live Cloudflare engine:

- **Worker Loader cache eviction policy.** How long does an isolate stay warm? What triggers eviction? Mid-run eviction will re-invoke the loader — verify Thodare's loader is genuinely idempotent across evictions.
- **`WorkflowEntrypoint` resume after hibernation.** The library assumes the engine re-instantiates the dispatcher entrypoint on resume and re-calls `run` with the same envelope. Confirm with the Workflows GA contract (especially: does `event.payload` really survive `step.sleep('30 days')` byte-for-byte?).
- **`step.waitForEvent` across the RPC boundary.** The library claims transparency. Verify that `await step.waitForEvent(...)` inside the tenant's `run` actually suspends the workflow — that `step` reference crosses the Worker Loader RPC boundary correctly. The tests assert reference equality (`entrypoint.test.ts:102-122`) but with a fake `step`; nothing in the test suite exercises the real engine's `step` over RPC.
- **`InstanceStub.id` over RPC.** The prototype-getter trick (`binding.ts:34-36, 43-45`) is brittle. Verify on the live engine that tenant code reading `await instance.id` actually receives the right id (not `undefined`, not a Promise stub). The basic example's `default-source.ts:70` does `await instance.id` and relies on this working.
- **Per-account Workflow concurrency limits.** Whatever they are today, the dispatcher pattern multiplies them across all Thodare orgs. Get the actual numbers from Cloudflare and see if any rate-limit/queueing is needed in the dispatcher.
- **`exports.X.getByName(name)` for Durable Objects.** The example uses this DO discovery pattern with no `durable_objects.bindings` block (`logging.ts:73-75`, `wrangler.jsonc:19-23`). This is recent Workers tech; confirm it is GA / supported in production environments Thodare cares about.
- **What `cloudflare:workers` `exports` actually contains** at dispatcher boot time. The `wrapWorkflowBinding` factory throws if `DynamicWorkflowBinding` is missing — if Thodare's bundler tree-shakes the re-export, the dispatcher will throw on first request. Verify the build pipeline preserves the re-export.
- **CHANGELOG trajectory.** As of 2026-05-02, there is exactly one published patch (`0.1.1`, "Release to npm" — mechanical) and one initial minor (`0.1.0`). No `.changeset` entries pending. The library has been public for one day. Expect API churn before 1.0.

---

## Executive summary

`@cloudflare/dynamic-workflows@0.1.1` is a tiny (~300 LOC), focused glue library that does exactly one thing: it lets a single Cloudflare Workflow class dispatch `run(event, step)` to N tenant-supplied workers loaded via Worker Loader. It does so by wrapping the `Workflow` binding with a `WorkerEntrypoint` RPC class (`DynamicWorkflowBinding`) that smuggles `{ __dispatcherMetadata, params }` into every `create` call, and by providing a `WorkflowEntrypoint` subclass that unwraps the envelope on `run` and forwards to a consumer-supplied `loadRunner`. The `step` object is passed through unmodified, so `step.do`/`step.sleep`/`step.waitForEvent` all behave normally. The library enforces nothing about the metadata — it is plaintext, persisted, tenant-readable, and unsigned, so it is a routing hint only, not authorisation. The test suite (~200 LOC) exhaustively covers the envelope and `dispatchWorkflow` flows, but there is no end-to-end test that exercises the RPC-stub path or the `MissingDispatcherMetadataError` re-export guard. The pattern is structurally identical to Thodare's "T5: one generic runtime workflow" sketch and a `world-cloudflare-dynamic` adapter can be ~150 LOC: a `ThodareWorkflow` registration plus a loader that pulls (`organizationId`, `workflowId`, `workflowVersion`) out of metadata, fetches the pinned definition from D1, and ships Thodare's runtime walker as the `mainModule`. License is MIT.

File: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/dynamic-workflows.md`
