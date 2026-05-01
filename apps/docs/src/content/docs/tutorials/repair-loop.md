---
title: The LLM repair loop, end to end
description: "Wire a real LLM to the patch endpoint and watch it converge in two rounds."
---

In [Build your first workflow](/thodare/tutorials/first-workflow/) you
sent patches by hand. Here you'll do the same flow, but the patches
come from an LLM that reads `skipped_items[]` and corrects itself.

Any LLM that can call tools works. We'll use OpenAI's
`gpt-4o-mini` for the example because the snippets stay short — the
pattern is the same for Claude / Llama / etc.

## The agent loop

The LLM gets two tools:

- `apply_patch(ops)` — calls `POST /api/workflows/:id/operations`. Returns
  `{ ok, version, summary, skipped_items }`.
- `run_workflow(input)` — calls `POST /api/workflows/:id/run`. Returns `{ runId }`.

Plus the `/api/connectors?detail=summary` catalog as system context.

## Step 1: prep the system prompt

```ts
const cat = await fetch(`${URL}/api/connectors?detail=summary`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then((r) => r.json());

const systemPrompt = `
You build small workflows by emitting EditOp[] patches.
Available block types and their params:

${JSON.stringify(cat, null, 2)}

Workflow JSON shape:
  - blocks: each has { id, type, params }.
  - connections: each is { source, target } (block ids).
  - Add a trigger_webhook block as the entry point.
  - When apply_patch returns ok: false, read skipped_items[].reason
    and fix the offending op on your next turn.
`;
```

## Step 2: define the tools

```ts
const tools = [
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply EditOp[] to the workflow. Returns ok + skipped_items[].",
      parameters: {
        type: "object",
        properties: { ops: { type: "array" } },
        required: ["ops"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_workflow",
      description: "Dispatch a run with the given input.",
      parameters: {
        type: "object",
        properties: { input: { type: "object" } },
      },
    },
  },
];
```

## Step 3: drive the loop

```ts
import OpenAI from "openai";
const oai = new OpenAI();

const wf = await api<{ id: string; version: number }>("/api/workflows", {
  method: "POST",
  body: "{}",
});

let messages: any[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: "Build a workflow that fires a Slack message to #sales when a webhook arrives." },
];

while (true) {
  const r = await oai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    tools,
  });
  const m = r.choices[0].message;
  messages.push(m);

  if (!m.tool_calls?.length) {
    console.log("Model finished:", m.content);
    break;
  }

  for (const tc of m.tool_calls) {
    const args = JSON.parse(tc.function.arguments);
    let result: unknown;

    if (tc.function.name === "apply_patch") {
      const ver = (await api<{ version: number }>(`/api/workflows/${wf.id}`)).version;
      result = await api(`/api/workflows/${wf.id}/operations`, {
        method: "POST",
        headers: { ...H, "if-match": String(ver) },
        body: JSON.stringify({ ops: args.ops }),
      });
    } else if (tc.function.name === "run_workflow") {
      result = await api(`/api/workflows/${wf.id}/run`, {
        method: "POST",
        body: JSON.stringify({ input: args.input ?? {} }),
      });
    }

    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(result),
    });
  }
}
```

### What's happening

- The model emits an `apply_patch` tool call. The handler calls the
  Thodare API and feeds the response (including `skipped_items[]`)
  back as the tool result.
- If `ok === false`, the model sees the skip log and *self-corrects*
  on the next turn — usually one or two rounds.
- Once `ok === true`, it emits `run_workflow`, gets a `runId`, and you
  can poll `/api/runs/:runId` (extend the loop with another tool if
  you want the model to wait + report).

## What you'll see in the model's transcript

Round 1 (typical mistake): `slak` instead of `slack`, or a missing
trigger block, or a connection to a nonexistent target. The skip
reasons surface in `skipped_items[].reason`:

```json
[
  {
    "reason_code": "block_type_not_registered",
    "operation_type": "add",
    "block_id": "n",
    "reason": "Block type 'slak' is not registered. Available: trigger_webhook, slack, http, …"
  }
]
```

Round 2: model reads "Available: …", picks `slack`, retries. `ok: true`.

That convergence is what the skip-not-reject pattern buys.

## What you learned

- An LLM with two tools and the connector catalog as system context
  builds a working workflow in ~2 rounds.
- The structured skip log is the only "training signal" the model
  needs at runtime — no fine-tuning required.
- Optimistic concurrency (`If-Match`) protects against parallel
  editors silently overwriting each other.

## Next

- [Cron-driven workflow](/thodare/tutorials/cron-driven/) — schedule the workflow you just built.
- [The patch loop primitive](/thodare/explanation/patch-loop/) — the design rationale.
