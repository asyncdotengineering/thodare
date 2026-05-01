---
title: Define a connector
description: "How to write a Thodare connector — Zod schemas, hidden params, kind: 'wait'."
---

## Goal

Add a new block type to the catalog the LLM sees. Connectors are
plain TypeScript: a Zod schema for params, a Zod schema for outputs,
and an async `run()`.

## Step 1: declare the connector

```ts
import { defineConnector, hidden } from "@thodare/engine";
import { z } from "zod";

export const slack = defineConnector({
  type: "slack",
  description: "Send a message to a Slack channel.",
  params: z.object({
    channel: z.string(),
    text: z.string(),
    accessToken: hidden(z.string()),
  }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async run({ channel, text, accessToken }, ctx) {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text }),
    });
    const body = await r.json();
    return { ok: body.ok, ts: body.ts };
  },
});
```

### Hidden params

`hidden(z.string())` brands the field as server-side-only. Hidden
params **never appear** in `GET /api/connectors`, so the LLM literally
cannot reference them in `params`. Server code fills them at execution
time (typically from `ctx.env` or your secret store). See
[Why hidden matters](/thodare/explanation/patch-loop/#why-hidden-matters).

## Step 2: register on the kit

```ts
const wfkit = await createWfkit({ backend });
wfkit.register(slack, anotherConnector, …);
```

Order matters only for catalog display; functionally it's a `Map` keyed
by `type`.

## Step 3: verify it appears

```sh
curl -s "$URL/api/connectors?detail=summary" -H "$H" | jq '.[] | select(.type == "slack")'
# → { "type": "slack", "description": "Send a message to a Slack channel.",
#     "params": { "channel": "...", "text": "..." }, ... }
```

`accessToken` does not appear. Confirmed.

## Wait blocks

If your connector needs to pause durably (waiting for an external
event), set `kind: "wait"` and emit a pause sentinel. See
[How a run executes](/thodare/explanation/how-it-runs/) for the
machinery.

## Common issues

**Connector type collides with a built-in.** Built-ins reserve
`trigger_webhook`, `http`, `slack`, `transform`, `wait_duration`,
`wait_for_event`, `human_approval`. Pick a unique `type` (e.g.,
`slack-team-bot` instead of bare `slack`).

**`hidden` field missing at execution.** The connector runs
server-side; you need to supply the value before `run()`. The standard
pattern is `ctx.env["SECRET_NAME"]` set during boot.

## Next

- [Register a webhook route](/thodare/how-to/register-webhook/) — connectors that take inbound HTTP.
- [How a run executes](/thodare/explanation/how-it-runs/) — what `run()` plugs into.
