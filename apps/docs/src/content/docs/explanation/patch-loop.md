---
title: The LLM patch loop primitive
description: "Why skip-don't-reject is the load-bearing piece of the API."
---

The patch endpoint is the single load-bearing piece of Thodare.
Every other route is mechanical plumbing. This is the one that earns
the LLM-control-plane name.

## The contract

```
POST /api/workflows/:id/operations
  Body: { ops: EditOp[] }
  Headers: If-Match: <expectedVersion>      ← optional, optimistic concurrency
  → 200: { ok, version, validation_errors, skipped_items, summary }
  → 412: { error: "version_mismatch", current: <n> }
```

Every field in the 200 response is feedable directly back to the LLM
as tool output. That's the design intent: the API isn't a wall the
LLM hits — it's a partner that explains rejections.

## Skip, don't reject

Most APIs return 400 on the first bad field. If a 5-op patch contains
one bad op, all 5 are rejected. The LLM has to figure out which one was
bad and try again from scratch.

Thodare does the opposite. Bad ops are **skipped**; the rest of the
batch applies. The 200 response carries:

- `ok: false` — at least one op was skipped.
- `summary` — a human-readable summary the LLM reads directly:
  `"Applied 3 operation(s). 2 skipped: …"`.
- `skipped_items[]` — structured rejections with `reason_code`,
  `block_id`, `reason`.

The `reason_code` is enumerable — your prompt can switch on it. The
`reason` text is verbose enough for the LLM to *fix the op* on the
next turn.

## Why this works

A failed-but-skipped op is the only training signal the LLM gets at
runtime. If the API rejected the entire batch on first error, the LLM
would have no way to learn from a single round-trip — it would have
to retry the whole thing. The skip-and-explain pattern is what makes
single-shot LLM workflow construction work.

## Why hidden matters

Connectors can mark params as `hidden(z.string())`. Hidden params
**never appear** in `GET /api/connectors`. The LLM literally cannot
see them, so it cannot reference them in `params`. If it tries (e.g.,
hallucinates `accessToken: "fake"`), the op is skipped with
`reason_code: "hidden_param_in_input"`.

This is structural, not prompt-guarded. A jailbroken LLM that ignores
your system prompt still cannot land an `accessToken` field in the
workflow — it would fail validation at apply time.

## A two-round example

**Round 1.** LLM proposes:

```json
{
  "ops": [
    {"operation_type":"add","block_id":"trg","type":"trigger_webhook","params":{}},
    {"operation_type":"add","block_id":"e","type":"slak","params":{"channel":"#sales","text":"hi"}},
    {"operation_type":"connect","block_id":"trg","target_block_id":"e"}
  ]
}
```

Response:

```json
{
  "ok": false,
  "version": 2,
  "skipped_items": [
    {"reason_code":"block_type_not_registered","operation_type":"add","block_id":"e",
     "reason":"Block type 'slak' is not registered. Available: trigger_webhook, slack, http, …"},
    {"reason_code":"invalid_edge_source","operation_type":"connect","block_id":"e",
     "reason":"Source block e does not exist."}
  ],
  "summary": "Applied 1 operation(s). 2 skipped: …"
}
```

**Round 2.** LLM reads the skips, learns "slak" → "slack", retries:

```json
{
  "ops": [
    {"operation_type":"add","block_id":"e","type":"slack","params":{"channel":"#sales","text":"hi"}},
    {"operation_type":"connect","block_id":"trg","target_block_id":"e"}
  ]
}
```

Response: `{ ok: true, version: 3, summary: "Applied all 2 operation(s) successfully." }`.

Two rounds, no human intervention. That convergence is what the
skip-not-reject pattern buys.

## What this is and isn't

- **Is** a primitive for AI-driven workflow construction.
- **Is** safe with optimistic concurrency.
- **Isn't** a transactional editor. Skipped ops are lost — they're
  not queued, retried, or held. The LLM is expected to re-emit them.
- **Isn't** a query layer. There's no "undo last patch" — version
  history is via the database snapshot, not an op log.

## Implementation

[`packages/api/src/routes/workflows.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/api/src/routes/workflows.ts) +
[`packages/engine/src/operations/apply.ts`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/src/operations/apply.ts).
