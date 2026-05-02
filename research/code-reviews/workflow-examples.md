# Code Review — `vercel/workflow-examples`

> Source under review: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/workflow-examples/`
> WDK version pinned in nearly every example: `workflow@4.2.4`, `@workflow/ai@4.1.2`, `@workflow/world-postgres@4.1.1`, `@workflow/world-local@4.1.1`.
> Reviewer goal: extract the exact surface, semantics, and integration contracts that Thodare must either copy, adapt, or deliberately diverge from.

---

## 1. Examples Matrix

| # | Example | Unique demonstration | Primitives used | Deploy target / runtime | Approx. LoC | Novel pattern |
|---|---|---|---|---|---|---|
| 1 | `kitchen-sink/` | Reference card for every primitive in 6 files | `FatalError`, `RetryableError`, `getStepMetadata`, `getWorkflowMetadata`, `getWritable`, `createHook`, `DurableAgent`, `Promise.race`/`all`, batching | tsc-only (no server, no deploy target) | 391 | "Use step / use workflow" directives only — no imports of magic per-call helpers |
| 2 | `custom-adapter/` (Bun) | Build-your-own host: SWC plugin + 3 well-known routes + `Bun.serve` | `sleep`, `createWebhook`, `start` | Bun + `@workflow/world-local` | 105 | The cleanest "implement a World yourself" template |
| 3 | `ai-sdk-workflow-patterns/` | Five canonical AI agent compositions durabilized via WDK | `globalThis.fetch = fetch from "workflow"`, AI SDK `generateObject`/`generateText` | Next.js 16 (Vercel) | 619 | Treats AI SDK calls as durable steps by swapping `fetch` |
| 4 | `rag-agent/` | RAG with embeddings + pgvector + `DurableAgent` tools | `getWritable`, `DurableAgent`, `defineHook` (implicit via tools), Drizzle in steps | Next.js + Postgres (Drizzle, pgvector) | 388 | Tools that themselves call other steps (composition) |
| 5 | `flight-booking-app/` | Multi-turn agent w/ session loop, follow-up hooks, observability events on the writable | `DurableAgent`, `defineHook`, `getWritable`, `getWorkflowMetadata`, `sleep`, `FatalError`, `start` | Next.js + Vercel World OR `@workflow/world-postgres` | 14,331 (incl. UI) | `preventClose`/`sendStart`/`sendFinish` agent stream flags + workflow-level observability events emitted as `data-workflow` chunks |
| 6 | `postgres/` | Off-Vercel deploy story; how the user opts into a different World | `sleep`, `FatalError`, `withWorkflow` (next.config) | Next.js + `@workflow/world-postgres` (any host) | 187 | `instrumentation.ts` calls `getWorld().start?.()`, env vars `WORKFLOW_TARGET_WORLD` + `WORKFLOW_POSTGRES_URL` swap backends |
| 7 | `birthday-card-generator/` | Long-running scheduled workflow (`sleep(birthday)`), parallel webhooks for RSVPs, progress streamed back | `createWebhook`, `sleep(Date)`, `getWritable`, `start`, `getRun` (`run.readable`, `run.exists`, `run.status`, `run.returnValue`, `run.getReadable({startIndex})`) | Next.js + Vercel | 2,004 | Replayable progress stream w/ `startIndex` resume; `sleep(Date)` for absolute time |
| 8 | `ffmpeg-processing/` | Express+Nitro media pipeline, sandbox provisioning, binary stream in + out | `getWritable`, `FatalError`, `start` (with `ReadableStream` arg), `run.readable` | Nitro + Express + `@vercel/sandbox` | 330 | Streams as workflow inputs/outputs; sandbox lifecycle via `try/finally` step |
| 9 | `actors/` | Long-lived workflow as actor; `for await (event of hook)` event loop | `defineHook`, `for await` async-iterator semantics on a hook, `getWorkflowMetadata().workflowRunId` as actor ID | Next.js | 889 | Hook created **outside** loop, reused via async-iterator |
| 10 | `astro/` | `workflow/astro` integration | `start`, `sleep`, `FatalError` | Astro (Vercel) | 85 | `integrations: [workflow()]` is the only wiring |
| 11 | `hono/` | Hono on Nitro module | `start`, `sleep`, `FatalError` | Nitro + Hono | 68 | `modules: ["workflow/nitro"]` |
| 12 | `nextjs/` | Reference Next.js wiring | `start`, `sleep`, `FatalError` | Next.js | 176 | `withWorkflow(nextConfig)` wraps next.config |
| 13 | `nitro/` | Pure Nitro | same | Nitro | 85 | `modules: ["workflow/nitro"]` + `serverDir` |
| 14 | `nuxt/` | Nuxt 4 module | same | Nuxt | 73 | `modules: ["workflow/nuxt"]` |
| 15 | `sveltekit/` | SvelteKit Vite plugin | same | SvelteKit | 115 | `plugins: [sveltekit(), workflowPlugin()]` |
| 16 | `vite/` | Vite + Nitro hybrid | same | Vite + Nitro | 92 | `plugins: [nitro(), workflow()]` from `workflow/vite` |

---

## 2. Primitives Reference

WDK exposes a deliberately small surface. Every primitive below was confirmed in source. Citations are absolute file:line.

### 2.1 Directives — `"use workflow"` and `"use step"`

These are **string-literal directives** placed at the top of an `async function` body. They are the entire authoring surface; everything else is a normal import.

- `"use workflow"` — marks a function as a durable workflow entry. Every example: e.g. `workflow-examples/kitchen-sink/1-basics.ts:20`, `workflow-examples/postgres/workflows/user-signup.ts:4`.
- `"use step"` — marks an async function as an idempotent unit of work the engine can checkpoint and retry. e.g. `workflow-examples/kitchen-sink/1-basics.ts:4`, `workflow-examples/rag-agent/workflows/chat/createResource.ts:11`.

The Bun custom-adapter shows the magic: the SWC plugin `@workflow/swc-plugin` (mode `client`) rewrites these directives into RPC stubs at build time (`workflow-examples/custom-adapter/workflow-plugin.ts:9-25`). There is no special call site syntax — a step is invoked with `await stepFn(arg)` exactly like a regular function.

### 2.2 `sleep(duration)`

```ts
import { sleep } from "workflow";
await sleep("5s");                 // workflow-examples/postgres/workflows/user-signup.ts:7
await sleep(birthday!);            // workflow-examples/birthday-card-generator/.../generate-birthday-card.ts:109
```

- Accepts a duration string (`"5s"`, `"1m"`, etc.) or a `Date`.
- Workflow is suspended; consumes no compute. Confirmed in postgres example header comment ("Pause for 5s - doesn't consume any resources").
- Used inside tools as a workflow-level helper without a `"use step"` directive (`flight-booking-app/.../steps/tools.ts:363-367` notes "No 'use step' here - sleep is a workflow-level function").

### 2.3 `FatalError` / `RetryableError`

```ts
import { FatalError, RetryableError } from "workflow";
throw new FatalError("Invalid Email");                     // postgres/workflows/user-signup.ts:33
throw new RetryableError("Retryable error", {
  retryAfter: "5s",
});                                                         // kitchen-sink/2-control-flows.ts:29-32
```

Semantics (from `kitchen-sink/2-control-flows.ts:69-78`, comments verbatim):

> *"Only FatalErrors will bubble up here. Non-fatal errors are retried."*

- Default behavior: any unhandled `Error` thrown inside a `"use step"` triggers automatic retry.
- `FatalError` short-circuits retries and bubbles to the workflow `catch`/the run failure status.
- `RetryableError({ retryAfter })` lets a step **request** the engine pause before the next attempt (rate-limit-aware backoff).
- `getStepMetadata().attempt` exposes the retry counter so a step can branch on attempt # (`kitchen-sink/2-control-flows.ts:23-25`).

### 2.4 `getStepMetadata()` / `getWorkflowMetadata()`

```ts
import { getStepMetadata, getWorkflowMetadata } from "workflow";
const { attempt } = getStepMetadata();                                   // kitchen-sink/2-control-flows.ts:23
const ctx = getWorkflowMetadata();                                       // kitchen-sink/5-hooks.ts:6
const { workflowRunId, workflowStartedAt } = getWorkflowMetadata();      // flight-booking-app/.../chat/index.ts:30
const metadata = getWorkflowMetadata();
const actorId = metadata.workflowRunId;                                  // actors/workflows/counter-actor.ts:40-41
```

- `getStepMetadata()` returns at minimum `{ attempt }` and is callable inside `"use step"`.
- `getWorkflowMetadata()` returns `{ workflowRunId, workflowStartedAt: Date, ... }`. Used as a stable identity: actor ID, hook tokens, observability events.
- The actor pattern hinges on `workflowRunId` being unique per `start()` invocation.

### 2.5 `getWritable<T>()`

```ts
import { getWritable } from "workflow";
const writable = getWritable<UIMessageChunk>();                          // kitchen-sink/4-ai.ts:16
const writable = getWritable<string>();                                  // birthday-card-generator/.../stream-progress.ts:11
```

- Returns a `WritableStream<T>` that the workflow run owns. Caller-side, `start()` returns a run with a corresponding `run.readable` that can be piped back to the HTTP client (`birthday-card-generator/.../route.ts:41` — `return new Response(run.readable, ...)`).
- Writers must `releaseLock()` after each write inside a step so subsequent steps can write (see `flight-booking-app/.../steps/writer.ts:22-23`).
- Replayable: `run.getReadable<T>({ startIndex })` lets a reconnecting client resume from a tail index (`birthday-card-generator/.../[runId]/stream/route.ts:25-26`).

### 2.6 `createWebhook()`

```ts
import { createWebhook } from "workflow";
const webhook = createWebhook();
await sendOnboardingEmail(user, webhook.url);                            // custom-adapter/workflows/user-signup.ts:11-13
await webhook;                                                            // suspends until URL is hit
const webhooks = rsvpEmails.map((_) => createWebhook());
const rsvpReplies = await Promise.all(
  webhooks.map(async (webhook) => {
    const request = await webhook;                                        // birthday/.../generate-birthday-card.ts:78-79
    const url = new URL(request.url);
    return { email: url.searchParams.get("email"), ... };
  }),
);
```

- Returns `{ url, ... }` plus a thenable. The `url` is a public, single-use callback that the workflow handler at `/.well-known/workflow/v1/webhook/:token` resolves (`custom-adapter/server.ts:18`).
- Resolves to the HTTP request that hit the URL (the birthday example reads `searchParams` off it).
- Many can be `Promise.all`-ed for parallel "fan out, wait for each callback" patterns.

### 2.7 `createHook<T>({ token })` and `defineHook<T>()`

```ts
// inline create
import { createHook } from "workflow";
const hook = createHook<{ type: string; data: { id: string } }>({
  token: `openai:${respId}`,
});
const payload = await hook;                                              // kitchen-sink/5-hooks.ts:65-71

// declared once, used in workflow + API route
import { defineHook } from "workflow";
export const counterActorHook = defineHook<CounterEvent>();              // actors/workflows/counter-actor.ts:19
const receiveEvent = counterActorHook.create({ token: `counter_actor:${actorId}` });
for await (const event of receiveEvent) { ... }                          // actors/workflows/counter-actor.ts:60

// from outside (API route): resume by token
const result = await counterActorHook.resume(token, event);              // actors/.../[actorId]/event/route.ts:27
```

- `createHook` (per-call, raw) vs `defineHook` (module-level, gives you `.create({ token })` + `.resume(token, payload)` with shared types).
- `defineHook` accepts a `schema` (Zod) for validated payloads (`flight-booking-app/.../hooks/approval.ts:4-9`).
- A hook is **simultaneously a thenable and an async iterator**. `await hook` resolves once; `for await (const e of hook)` keeps draining (the actor loop). This dual nature is undocumented in obvious places but load-bearing for the actor pattern.
- Token namespacing convention: `<purpose>:<id>` (e.g. `openai:resp_abc`, `counter_actor:run_xyz`, raw `toolCallId`).

### 2.8 `fetch` from `"workflow"` (the durable fetch shim)

```ts
import { fetch } from "workflow";
globalThis.fetch = fetch;                                                // ai-sdk-workflow-patterns/sequential-workflow.ts:12
```

- A drop-in replacement for `globalThis.fetch` that wraps the call in a step under the hood. Idempotent retries, replay-cached responses.
- The AI SDK pattern files all begin by overwriting `globalThis.fetch` — so every `generateText`/`generateObject`/`embed` call inside `'use workflow'` becomes a durable step automatically (no `"use step"` wrapper needed).
- This is the single most leveraged trick in the AI examples and the reason `@workflow/ai` is small.

### 2.9 `DurableAgent` (from `@workflow/ai/agent`)

```ts
import { DurableAgent } from "@workflow/ai/agent";
const agent = new DurableAgent({
  model: "anthropic/claude-4-opus-20250514",
  tools: { getWeatherInformation: { description, inputSchema, execute } },
});
await agent.stream({
  messages: await convertToModelMessages(messages),
  writable,
});                                                                       // kitchen-sink/4-ai.ts:18-32
```

Flight booking expands the surface (`flight-booking-app/workflows/chat/index.ts:65-91`):

```ts
const result = await agent.stream({
  messages,
  writable,
  preventClose: true,    // keep the writable open across turns
  sendStart: turnNumber === 1,
  sendFinish: false,
});
// result.steps[].toolCalls, result.steps[].finishReason, result.steps[].usage
// result.messages — assistant messages produced this turn
```

- `tools` is a record of `{ description, inputSchema (Zod), execute }`. `execute` may be a `"use step"` function, a workflow-level function (sleep, hooks), or compose other steps (RAG: `findRelevant` is itself a step that calls more steps, `rag-agent/workflows/chat/findRelevant.ts:7-11`).
- Built on top of AI SDK; expects `globalThis.fetch = fetch` to be set OR runs durably without it (kitchen-sink doesn't set `globalThis.fetch` for the DurableAgent, AI-SDK pattern files do — implying DurableAgent auto-instruments its own fetch).
- `result.usage` carries token counts; flight booking persists these on observability events.

### 2.10 Caller-side: `start`, `getRun`, `runtime.getWorld`

```ts
import { start, getRun } from "workflow/api";
const run = await start(handleUserSignup, [email]);                      // every framework integration
run.runId                                                                 // string
run.readable                                                              // ReadableStream — pipe back to the client
run.exists, run.status, run.returnValue                                   // birthday/.../[runId]/route.ts:12-22
run.getReadable<string>({ startIndex })                                   // birthday/.../[runId]/stream/route.ts:25
const tailIndex = await stream.getTailIndex();                            // ditto :26

import { getWorld } from "workflow/runtime";
await getWorld().start?.();                                               // postgres/instrumentation.ts:5, flight/instrumentation.ts:6
```

- `start(workflowFn, argsArray)` returns a `Run` handle synchronously after the run is durably scheduled.
- `getRun(runId)` rehydrates a handle (used by progress polling endpoints).
- `getWorld().start?.()` is the lifecycle hook for Worlds with async workers (Postgres). The `?.` matters — Vercel World doesn't need it; Postgres World does. This is the only Thodare-relevant code that touches the World adapter directly.

### 2.11 Build-time framework integrations (named imports per host)

| Import | Used by |
|---|---|
| `withWorkflow` from `workflow/next` | `nextjs/next.config.ts:1`, `postgres/next.config.ts:1` |
| `workflow` from `workflow/astro` (Astro integration) | `astro/astro.config.mjs:3` |
| `"workflow/nitro"` (Nitro module string) | `hono/nitro.config.ts:4`, `nitro/nitro.config.ts:5`, `ffmpeg-processing/nitro.config.ts:4` |
| `"workflow/nuxt"` (Nuxt module string) | `nuxt/nuxt.config.ts:4` |
| `workflowPlugin` from `workflow/sveltekit` (Vite plugin) | `sveltekit/vite.config.ts:3` |
| `workflow` from `workflow/vite` (Vite plugin) | `vite/vite.config.ts:3` |

All ultimately install the same SWC transform on `"use workflow"`/`"use step"` files and mount the three well-known routes.

---

## 3. Patterns Reference (verbatim)

### 3.1 Custom adapter — write your own World host

This is the pattern Thodare's `world-cloudflare-dynamic` and `world-wdk` should mirror. The Bun example proves a complete host is ~100 LoC.

**The three required HTTP routes** (`workflow-examples/custom-adapter/server.ts:9-19`):

```ts
import flow from './.well-known/workflow/v1/flow.js';
import step from './.well-known/workflow/v1/step.js';
import * as webhook from './.well-known/workflow/v1/webhook.js';

const server = Bun.serve({
  routes: {
    '/.well-known/workflow/v1/flow':   { POST: req => flow.POST(req) },
    '/.well-known/workflow/v1/step':   { POST: req => step.POST(req) },
    '/.well-known/workflow/v1/webhook/:token': webhook,  // exports GET, POST, DELETE
    '/': { GET: async req => {
        const run = await start(handleUserSignup, [email]);
        return Response.json({ runId: run.runId });
    }},
  },
});
```

The `.well-known/workflow/v1/{flow,step,webhook}.js` files are **emitted by `bun x workflow build`** (see `package.json` script `dev: "bun x workflow build && PORT=3152 bun run server.ts"`, `clean` script removes `.well-known`). The host doesn't write these — the WDK CLI does. The host only mounts them.

**The build-time transform** (`workflow-examples/custom-adapter/workflow-plugin.ts:9-25`):

```ts
import { plugin } from "bun";
import { transform } from '@swc/core';

plugin({
  name: 'workflow-transform',
  setup(build) {
    build.onLoad({ filter: /workflows\/.*\.(ts|tsx|js|jsx)$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = await transform(source, {
        filename: args.path,
        jsc: { experimental: {
          plugins: [[require.resolve('@workflow/swc-plugin'), { mode: 'client' }]],
        }},
      });
      return { contents: result.code, loader: 'ts' };
    });
  },
});
```

Registered via `bunfig.toml`: `preload = ["./workflow-plugin.ts"]`.

**Backend selection** is a peer dep: `"@workflow/world-local": "4.1.1"` in `custom-adapter/package.json:17`. The `workflow build` CLI reads the World pkg and code-generates the `.well-known/*` route handlers that adapt that World's persistence/queue.

**Implications**: A World implementation appears to be a **separate npm package** that the WDK CLI inspects to generate route handlers. Writing one means implementing whatever interface `@workflow/world-local`/`@workflow/world-postgres` export. Read those packages separately to lock the contract.

### 3.2 AI SDK durability — the 1-line trick

```ts
// workflow-examples/ai-sdk-workflow-patterns/sequential-workflow.ts:7-13
export async function sequentialWorkflow(input: string) {
  'use workflow';
  // Uses Workflow's "fetch" step. This allows AI SDK calls
  // to automatically work as steps
  globalThis.fetch = fetch;

  const { text: copy } = await generateText({ model: MODEL, prompt: ... });
```

Every AI-SDK-pattern file repeats the same three lines. This means:
- AI SDK calls become **per-HTTP-call steps**, not per-`generateText`-call steps. A retry replays one fetch, not the whole prompt construction.
- Embedding-heavy code (`rag-agent/workflows/chat/shared/embedding.ts:11`) calls `embedMany`, which under the hood is one fetch — so one durable step per embedding batch.
- For non-AI HTTP calls, the same pattern works: import `fetch` from `workflow`, swap globally, every `fetch(...)` is now a step.

### 3.3 Batching — two patterns, different failure modes

**Pattern A: each item is a step** (`kitchen-sink/6-batching.ts:11-32`):

```ts
export async function batchOverSteps() {
  'use workflow';
  const chunks = chunk(arr, CHUNK_SIZE);
  for (const [index, batch] of chunks.entries()) {
    await Promise.all(batch.map(logItem));     // logItem has "use step"
  }
}
async function logItem(item: number) { 'use step'; console.log(item); }
```

> *"If a step fails, doesn't fail the entire batch."* (line 9)

**Pattern B: batch is a step** (`kitchen-sink/6-batching.ts:44-78`):

```ts
export async function batchInStep() {
  'use workflow';
  const chunks = chunk(arr, CHUNK_SIZE);
  for (const batch of chunks) {
    await processItems(batch);                 // processItems has "use step"
  }
}
async function processItems(items: number[]) {
  'use step';
  await Promise.all(items.map(async (item) => { console.log(item, Date.now()); }));
}
```

> *"NOTE: If a batch fails, the entire batch will be retried from the beginning."* (line 43)

**Tradeoff**: Pattern A multiplies orchestration overhead by N (engine bookkeeping per item) but isolates failures. Pattern B amortizes overhead but loses partial progress on retry. The CHUNK_SIZE choice is what tunes this.

### 3.4 Streaming back to caller

```ts
// inside the workflow:
const writable = getWritable<UIMessageChunk>();                          // flight-booking-app/.../chat/index.ts:31

// inside a step:
async function emitToolStart(toolName: string) {
  const writable = getWritable<UIMessageChunk>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: 'data-workflow', data: { type: 'tool-start', toolName, timestamp: Date.now() } });
  } finally {
    writer.releaseLock();
  }
}                                                                         // flight-booking-app/.../steps/tools.ts:9-24

// caller side:
const run = await start(generateBirthdayCard, [...]);
return new Response(run.readable, {
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8',
             'x-workflow-run-id': run.runId },
});                                                                       // birthday/.../route.ts:34-47

// reconnect / replay from index N:
const stream = run.getReadable<string>({ startIndex });
const tailIndex = await stream.getTailIndex();
return new Response(stream, { headers: { 'x-workflow-stream-tail-index': String(tailIndex) }});
                                                                         // birthday/.../[runId]/stream/route.ts:25-32
```

**Key facts:**
- The writable is a singleton per run; calling `getWritable()` from any step returns the same stream.
- `releaseLock()` is mandatory after each write — multiple steps need to take and release the writer.
- `run.getReadable({ startIndex })` makes the stream **replayable**: the engine retains the chunk log keyed by index.
- The `x-workflow-stream-tail-index` header is the convention for a client to know how far to skip ahead on the next reconnect.

### 3.5 Human-in-the-loop / external-callback hooks

**OpenAI background response pattern** (`kitchen-sink/5-hooks.ts:56-80`):

```ts
export async function withCreateHook() {
  'use workflow';
  const respId = await initiateOpenAIResponse();             // OpenAI background mode

  const hook = createHook<{ type: string; data: { id: string } }>({
    token: `openai:${respId}`,
  });

  const payload = await hook;                                // suspends until resumed
  if (payload.type === 'response.completed') {
    const text = await getOpenAIResponse(payload.data.id);
  }
}
```

OpenAI's webhook (configured externally) hits the workflow host's `/.well-known/workflow/v1/webhook/:token` route. The host reads the token from the URL and calls the engine's `resumeHook(token, payload)`.

**Tool-mediated approval** (`flight-booking-app/.../steps/tools.ts:369-388`):

```ts
async function executeBookingApproval(args, { toolCallId }) {
  // No "use step" - hooks are workflow-level
  const hook = bookingApprovalHook.create({ token: toolCallId });
  const { approved, comment } = await hook;
  if (!approved) return `Booking rejected: ${comment || 'No reason provided'}`;
  return `Booking approved...`;
}
```

The `toolCallId` (assigned by AI SDK) becomes the hook token, so the UI can render an approve/reject button keyed to a specific tool call mid-stream.

---

## 4. Framework Integration Contract

Each framework integration does **two things**:

1. Inject the WDK build-time transform (the `@workflow/swc-plugin` that rewrites `"use workflow"`/`"use step"` files).
2. Mount the three `/.well-known/workflow/v1/{flow,step,webhook}` HTTP routes on the host's router.

Side-by-side wiring:

| Framework | Wiring (single line / file) | Where workflows live | Where the start endpoint lives |
|---|---|---|---|
| Next.js | `export default withWorkflow(nextConfig);` (`nextjs/next.config.ts:8`) | `workflows/*.ts` | `app/api/signup/route.ts` |
| Astro | `integrations: [workflow()]` (`astro/astro.config.mjs:7`) | `src/workflows/*.ts` | `src/pages/api/signup.ts` |
| Hono (on Nitro) | `modules: ["workflow/nitro"]` (`hono/nitro.config.ts:4`) + `routes: { "/**": "./src/index.ts" }` mounting Hono | `workflows/*.ts` | `src/index.ts` (Hono `app.post('/api/signup', ...)`) |
| Nitro (raw) | `modules: ["workflow/nitro"], serverDir: "./server"` (`nitro/nitro.config.ts:4-5`) | `workflows/*.ts` | `server/api/signup.post.ts` |
| Nuxt | `modules: ["workflow/nuxt"]` (`nuxt/nuxt.config.ts:4`) | `server/workflows/*.ts` | `server/api/signup.post.ts` |
| SvelteKit | `plugins: [sveltekit(), workflowPlugin()]` (`sveltekit/vite.config.ts:6`) | `workflows/*.ts` | `src/routes/api/signup/+server.ts` |
| Vite (+Nitro) | `plugins: [nitro(), workflow()]` (`vite/vite.config.ts:6`) | `workflows/*.ts` | `api/signup.post.ts` |
| Bun (custom) | Hand-rolled SWC plugin in `workflow-plugin.ts` + 3 routes in `server.ts` | `workflows/*.ts` (filtered by `onLoad` regex) | `server.ts` route map |

**Universal start-handler shape:**

```ts
import { start } from "workflow/api";
import { handleUserSignup } from "<path>/workflows/user-signup";
const { email } = await req.json();
await start(handleUserSignup, [email]);
return Response.json({ message: "User signup workflow started" });
```

This is identical across **all 7 framework integrations** (compare `astro/.../signup.ts:5-12`, `nextjs/.../route.ts:5-15`, `hono/src/index.ts:7-11`, etc.). The only variation is the host's request/response binding (`Response.json` vs `c.json` vs `defineEventHandler` vs `NextResponse.json`).

**What Thodare needs to provide to support a new framework**:
1. A bundler hook (Vite plugin, Webpack loader, Astro integration, Nitro module, etc.) that runs `@workflow/swc-plugin` on files with `"use workflow"`/`"use step"`.
2. A way to mount three HTTP handlers — generated by the WDK CLI into a known path — onto the framework's router.
3. (Optional) An entry point for `getWorld().start?.()` for Worlds with background workers — `instrumentation.ts` in Next, `register()` lifecycle elsewhere.

---

## 5. Top 10 Surprises

1. **`"use workflow"` and `"use step"` are the entire authoring DSL.** No decorators, no factory wrappers, no class hierarchy. Steps are just async functions with a directive. Confirmed across all 16 examples.
2. **Hooks are simultaneously thenables and async iterators.** `await hook` resolves once; `for await (const e of hook) { ... }` keeps draining (`actors/workflows/counter-actor.ts:60`). The actor README explicitly says to create the hook **outside the loop** (line 200). This dual nature is undocumented in the surface but load-bearing.
3. **`globalThis.fetch = fetch from "workflow"` is the AI SDK's durability mechanism.** Not a special agent class — just a fetch swap (`ai-sdk-workflow-patterns/sequential-workflow.ts:12`). Every AI SDK call becomes a step "for free." `DurableAgent` apparently auto-instruments without the swap (kitchen-sink/4-ai.ts doesn't do the swap), suggesting two layers.
4. **`run.readable` and `run.getReadable({ startIndex })` are different.** The former is consumed once at start time. The latter is replayable from any index for reconnects (`birthday/.../[runId]/stream/route.ts:25`). The header `x-workflow-stream-tail-index` is the wire convention for resuming.
5. **`sleep(Date)` accepts an absolute date.** `await sleep(birthday!)` in the birthday card generator schedules a workflow to wake at a specific calendar time, potentially weeks later (`birthday-card-generator/.../generate-birthday-card.ts:109`). This implies the engine persists wake-times in a queryable index, not just relative timers.
6. **The `.well-known/workflow/v1/*.js` routes are CLI-generated, not hand-written.** `bun x workflow build` emits them. The custom-adapter's `clean` script literally does `rm -rf .well-known`. This means a World package's contract is largely "what does `workflow build` need to know about you to emit these handlers."
7. **`getWorld().start?.()` uses optional chaining for a reason.** Vercel World needs no startup; Postgres World needs to launch background workers (`postgres/instrumentation.ts:5`, `flight-booking-app/instrumentation.ts:6`). The optionality lets the same `instrumentation.ts` work for both deploy targets.
8. **`releaseLock()` after every writer write is mandatory.** All 12 step-level writes I read pair `getWriter()` with `try/finally writer.releaseLock()` (`flight-booking-app/.../steps/tools.ts:21-24`, `flight-booking-app/.../steps/writer.ts:22-23`, `birthday-card-generator/.../stream-progress.ts:14`). Skipping it deadlocks the next step that calls `getWritable().getWriter()`.
9. **Stream input/output is actually supported as workflow args + return.** `compressAudioWorkflow(input: ReadableStream<Uint8Array>)` accepts a ReadableStream as a workflow argument (`ffmpeg-processing/.../audio-convert/index.ts:9`), and the Express handler bridges it via `Readable.fromWeb` (`ffmpeg-processing/src/index.ts:47`). Implies the WDK serializer special-cases streams.
10. **`FatalError` from a step also short-circuits API HTTP responses.** The route handler does `error instanceof FatalError ? 400 : 500` (`birthday-card-generator/.../route.ts:51-58`, `actors/.../route.ts:38-41`). FatalError isn't just an engine signal — it's an HTTP-status-code signal because the run's terminal error type leaks back to `start()` callers / `getRun().status`.

Bonus eleventh: **the SWC plugin runs in `mode: 'client'`** in the Bun adapter (`custom-adapter/workflow-plugin.ts:18`). The mode flag implies there is also a `'server'` (or other) mode that the framework integrations select differently — worth confirming when reading `@workflow/swc-plugin` source.

---

## 6. Implications for Thodare

### 6.1 What to lift directly

- **Adopt the `"use workflow"` / `"use step"` directive surface verbatim.** Anything else fragments the ecosystem; users can copy any of these 16 examples into Thodare with zero rewrite if Thodare implements WDK's contract. This is the single biggest leverage point for `world-wdk`.
- **Adopt the three well-known routes (`/.well-known/workflow/v1/{flow,step,webhook}`).** These are the universal RPC seam. Thodare's hosts (Cloudflare Worker, Hono, Bun) expose the same three routes; the engine inside each route delegates to Thodare's `World`.
- **Adopt the `start(workflowFn, args) → { runId, readable, getReadable, exists, status, returnValue }` `Run` shape.** It is what every framework adapter consumes. Diverging here breaks framework integration drop-in.
- **Adopt the hook-as-thenable + async-iterator dual.** The actor pattern is a free win for users; replicating only the thenable side cripples long-lived workflows.
- **Adopt the `fetch` import + `globalThis.fetch = fetch` swap pattern.** It's the cheapest way to make every existing HTTP-using library (AI SDK, OpenAI client, Anthropic client) durable inside Thodare workflows without wrappers.
- **Lift the writable contract verbatim** (`getWritable<T>()`, replayable via `startIndex`, `x-workflow-stream-tail-index` header). Streaming is the differentiator that makes durable workflows usable for AI UIs.

### 6.2 Patterns to copy into `examples/deploy-*` scaffold

The custom-adapter is the template. Each `examples/deploy-<runtime>` should ship:

1. A ~30 LoC server file mounting three routes + an entry route (`server.ts` analog).
2. A build hook (Vite plugin / Bun preload / Wrangler config) that runs the equivalent of `@workflow/swc-plugin`.
3. A `workflows/user-signup.ts` that exercises `sleep`, `createWebhook`, `FatalError`, retry — exactly the mix in the existing custom-adapter, hono, postgres signup workflows.
4. A README with the same five sections every WDK starter has: prereqs, install, dev, curl-to-trigger, deploy.
5. For Worlds with workers (Postgres, Cloudflare DO-backed), an `instrumentation.ts`-style bootstrap that calls `getWorld().start?.()`.

The `postgres/` example is the model for World-swap UX:
- Env vars: `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` + `WORKFLOW_POSTGRES_URL=...`.
- A migrate script: `"migrate": "workflow-postgres-setup"`.
- Doc note: "Run this again after upgrading the world package."

For `world-cloudflare-dynamic`, the parallel is:
- `WORKFLOW_TARGET_WORLD=@thodare/world-cloudflare-dynamic`.
- `WORKFLOW_CF_ACCOUNT_ID` / `WORKFLOW_CF_API_TOKEN` / `WORKFLOW_CF_NAMESPACE`.
- `wrangler` deploy as the "migrate" analog (DO bindings, KV namespaces).

### 6.3 What to deliberately do differently

- **Don't tie the WDK CLI to a single transform pipeline.** `bun x workflow build` codegen-ing into `.well-known/` works but is brittle (the `clean` script is telling). Thodare can offer the same artifacts as a runtime-resolved import (`import { flowHandler, stepHandler, webhookHandler } from '@thodare/host'`) so users don't need a build-time codegen step at all in serverless contexts.
- **Don't require a separate World package per backend.** WDK's split (`@workflow/world-local` + `@workflow/world-postgres` + `@workflow/world-cloudflare`) is fine, but Thodare's `World` interface should be small enough that a user can implement one inline (5-10 methods). Document the interface; encourage user-owned Worlds.
- **Reconsider directive-only authoring as the *only* surface.** Directives are unfriendly to bundlers that strip them, to TypeScript code-actions, and to runtime-only environments that can't run an SWC plugin (e.g. Deno without esbuild plugins). Offer a parallel **explicit** surface (`createStep(fn)`, `createWorkflow(fn)`) for the same semantic, so directive-free hosts work too. The directive can compile down to the explicit form.
- **Type the writable per-stream, not per-run.** WDK's `getWritable<T>()` is a single per-run channel. Thodare can offer **named writables** so a workflow can stream telemetry to one channel and UI chunks to another, decoupling observability from product output. The flight-booking writer.ts hack (`type: 'data-workflow'` envelope on a UI-message stream) is evidence the single-channel model leaks.
- **Make hook tokens type-safe end-to-end.** WDK's `defineHook` is a step in this direction but `.resume(token, payload)` still takes a string token. A typed-token API (`hook.token({ runId, kind: "approval" }) → ApprovalToken`) would eliminate the `counter_actor:${actorId}` / `openai:${respId}` stringly-typed conventions.
- **Be explicit about Promise.race + replay semantics.** `kitchen-sink/2-control-flows.ts` uses `Promise.race([delayedMessage(2000, ...), delayedMessage(10000, ...)])`. Replaying this requires the engine to remember **which** branch won. WDK clearly handles this (the example wouldn't work otherwise). Thodare should document this contract loudly because users will bring intuitions from non-deterministic engines.

### 6.4 Concrete asks for `world-wdk`

This is the World adapter that lets Thodare host workflows authored against WDK's surface. From this review:
- It must accept the WDK SWC-transformed code unchanged.
- It must expose the same `start`/`getRun`/`getWorld` factories under the `workflow/api` and `workflow/runtime` import names.
- It must implement the three well-known routes' handlers as plain functions a host can mount.
- It must support the writable replay API (`getReadable({ startIndex })`, `getTailIndex()`).
- It must implement `defineHook`'s `.resume(token, payload)` and the dual thenable/async-iterator on `.create({ token })`.

Reviewing `@workflow/world-local` and `@workflow/world-postgres` source directly is the next step before locking the `World` interface — those two packages contain the *real* contract; this examples repo only proves the surface.

---

### Executive Summary (200 words)

Vercel's workflow-examples repo is unusually disciplined: 16 examples, each minimal, each pinning `workflow@4.2.4`, each demonstrating exactly one or two patterns. The authoring surface is just two string-literal directives — `"use workflow"` and `"use step"` — plus a small set of named imports (`sleep`, `FatalError`, `RetryableError`, `createWebhook`, `createHook`, `defineHook`, `getStepMetadata`, `getWorkflowMetadata`, `getWritable`, and a durable `fetch` shim). Built atop these, `@workflow/ai`'s `DurableAgent` makes AI SDK agents fault-tolerant without per-call wrappers — the trick is `globalThis.fetch = fetch` from `"workflow"`. The custom-adapter (Bun, ~100 LoC) is the canonical "host your own" template: an SWC plugin transforms workflow files at load, and three `/.well-known/workflow/v1/{flow,step,webhook}` routes are mounted on `Bun.serve`. Every framework integration (Next/Astro/Hono/Nitro/Nuxt/SvelteKit/Vite) does the same two things in different idioms. For Thodare: lift the directive surface, the well-known routes, the `Run` shape, hook async-iterator semantics, and the writable-replay protocol verbatim — diverging only on per-package World fragmentation and on offering an explicit non-directive surface for bundlers that strip directives.

**File:** `/Users/mithushancj/documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/workflow-examples.md`
