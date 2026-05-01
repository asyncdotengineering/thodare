---
title: Build your first workflow
description: "From an empty workflow to a run that completes — programmatically."
---

In this tutorial you'll write a TypeScript script that creates a
workflow, patches it (with intentional mistakes — to see how feedback
works), fixes it, and runs it. By the end you'll have walked the LLM
repair loop end to end without an LLM in the picture.

We assume `@thodare/api` is running and you have an API key. If not,
do [Quickstart](/thodare/start/quickstart/) first — five minutes.

## Step 1: a script skeleton

```ts
// loop.ts
const URL = "http://localhost:3000";
const TOKEN = process.env.THODARE_API_KEY!;
const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${URL}${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}
```

That's the entire HTTP shim. Every subsequent step is a one-liner.

## Step 2: create an empty workflow

```ts
const wf = await api<{ id: string; version: number }>("/api/workflows", {
  method: "POST",
  body: "{}",
});
console.log("workflow:", wf.id, "version:", wf.version);
```

## Step 3: send a deliberately broken patch

```ts
const patch1 = await api<{
  ok: boolean;
  version: number;
  summary: string;
  skipped_items: Array<{ reason_code: string; reason: string; block_id: string }>;
}>(`/api/workflows/${wf.id}/operations`, {
  method: "POST",
  headers: { ...H, "if-match": String(wf.version) },
  body: JSON.stringify({
    ops: [
      { operation_type: "add", block_id: "trg", type: "trigger_webhook", params: {} },
      { operation_type: "add", block_id: "n", type: "slak", params: { channel: "#x", text: "hi" } },
      { operation_type: "connect", block_id: "trg", target_block_id: "n" },
    ],
  }),
});
console.log("ok?", patch1.ok);
console.log("summary:", patch1.summary);
console.log("skipped:", patch1.skipped_items);
```

### What's happening

- `if-match` carries the version we read — optimistic concurrency. If
  another caller patched between our read and write, this returns 412.
- `slak` is a typo. The API doesn't reject the whole batch — it
  *applies* what it can (the trigger landed) and *skips* the rest with
  a structured reason: `{ reason_code: "block_type_not_registered",
  reason: "Block type 'slak' is not registered. Available: …" }`.
- That reason is feedable directly back to an LLM as tool output.
  The model rewrites the bad op on its next turn.

## Step 4: send the fix-up patch

```ts
const cur = await api<{ version: number }>(`/api/workflows/${wf.id}`);
const patch2 = await api<{ ok: boolean; version: number }>(
  `/api/workflows/${wf.id}/operations`,
  {
    method: "POST",
    headers: { ...H, "if-match": String(cur.version) },
    body: JSON.stringify({
      ops: [
        { operation_type: "add", block_id: "n", type: "slack", params: { channel: "#x", text: "hi" } },
        { operation_type: "connect", block_id: "trg", target_block_id: "n" },
      ],
    }),
  },
);
console.log("fixed?", patch2.ok);  // → true
```

## Step 5: dispatch a run

```ts
const run = await api<{ runId: string; spec: string }>(
  `/api/workflows/${wf.id}/run`,
  { method: "POST", body: JSON.stringify({ input: { hello: "world" } }) },
);
console.log("runId:", run.runId);
```

## Step 6: poll until done

```ts
while (true) {
  const r = await api<{ state: string; output?: unknown }>(`/api/runs/${run.runId}`);
  console.log("state=", r.state);
  if (r.state === "completed" || r.state === "failed") {
    console.log("output:", r.output);
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
```

## What you learned

- The patch endpoint never rejects a batch wholesale — it skips and
  explains. That's the LLM-feedable contract.
- Optimistic concurrency via `If-Match` keeps concurrent editors from
  clobbering each other.
- `POST /run` returns a run id immediately; the durable runtime takes
  it from there. The run survives anything short of a database failure.

## Next

- [The LLM repair loop, end to end](/thodare/tutorials/repair-loop/) — same flow, plumbed to a real LLM.
- [The patch loop primitive](/thodare/explanation/patch-loop/) — the *why* behind skip-don't-reject.
- [How to define a connector](/thodare/how-to/define-connector/) — extend the catalog the LLM sees.
