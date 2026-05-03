---
title: EditOp shape
description: "The patch primitive that drives the LLM repair loop."
---

`POST /api/workflows/:id/operations` takes `{ ops: EditOp[] }`. Each
op is one of five shapes.

## `add`

```ts
{
  operation_type: "add",
  block_id: string,             // unique within the workflow
  type: string,                 // a key from the connector catalog
  params?: Record<string, unknown>,
}
```

Skips: `block_already_exists`, `block_type_not_registered`,
`tool_not_allowed`.

Hidden params (e.g., a connector's `accessToken: hidden(...)`) are not
a skip — the field is stripped from the resulting block and a
`validation_errors[]` entry surfaces the rejection. The block still
applies.

## `edit`

```ts
{
  operation_type: "edit",
  block_id: string,
  params: Record<string, unknown>,   // merged into existing
}
```

Skips: `block_not_found`. Hidden-param attempts surface as
`validation_errors[]`, not skips (see above).

## `delete`

```ts
{ operation_type: "delete", block_id: string }
```

Skips: `block_not_found`. Edges referencing the block are also removed.

## `connect`

```ts
{ operation_type: "connect", block_id: string, target_block_id: string }
```

Skips: `invalid_edge_source`, `invalid_edge_target`,
`duplicate_connection`, `cycle_introduced`.

## `disconnect`

```ts
{ operation_type: "disconnect", block_id: string, target_block_id: string }
```

Skips: `edge_not_found`.

## Response shape

```ts
{
  ok: boolean,                  // true iff zero skips and zero validation_errors
  workflow: SerializedWorkflow, // the new state after applying the batch
  version: number,              // new version
  validation_errors: ValidationError[],
  skipped_items: SkippedItem[],
  summary: string,              // human-readable; feedable to the LLM
}
```

`SkippedItem`:
```ts
{
  reason_code: SkipReason,
  operation_type: "add" | "edit" | "delete" | "connect" | "disconnect",
  block_id: string,
  reason: string,              // verbose
  details?: Record<string, unknown>,
}
```

`ValidationError`:
```ts
{
  block_id: string,
  block_type: string,
  field?: string,
  value?: unknown,
  error: string,
}
```

`SkipReason` is one of:

```
block_not_found
block_already_exists
block_type_not_registered
tool_not_allowed
invalid_edge_target
invalid_edge_source
duplicate_connection
edge_not_found
cycle_introduced
```

Zod failures on params are caught structurally, not thrown. The block
stays in the workflow with whatever params landed; subsequent
`edit` ops can correct the params. Partial validity > no progress.
