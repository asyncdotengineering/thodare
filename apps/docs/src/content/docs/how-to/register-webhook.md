---
title: Register a webhook route
description: "Wire an inbound HTTP path to a workflow. Programmatic only — by design."
---

## Goal

Make `POST /api/webhooks/leads` dispatch a workflow run named
`lead-notifier` whenever Stripe / Resend / your own webhooker hits it.

## Step 1: register from your boot code

```ts
import { defineWorkflowSpec } from "@thodare/engine";
import { z } from "zod";

const api = await createControlPlaneApi({ /* … */ });

api.webhooks.register({
  path: "/leads",
  method: "POST",
  workflowName: "lead-notifier",
  inputSchema: z.object({ email: z.string().email() }),
  fromRequest: (req) => ({ email: (req.body as { email: string }).email }),
  idempotencyKey: (req) => (req.body as { event_id: string }).event_id,
});
```

### Why programmatic

There is **no HTTP endpoint** to register a webhook route at runtime.
That's deliberate — letting authenticated callers bind URLs to
workflow names is a phishing primitive (anyone in the org could redirect
inbound traffic). Routes live in your boot code, alongside the rest of
your config.

## Step 2: verify

```sh
curl -sX POST "$URL/api/webhooks/leads" \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","event_id":"evt_123"}'
# → 202 { "workflowRunId": "..." }
```

## Step 3: handle idempotency

If your webhook source retries (Stripe, Resend, GitHub all do),
`idempotencyKey` makes a re-delivery a no-op. The function builds a
deterministic key from the request — the same key always returns the
same run id, never dispatching twice.

```ts
idempotencyKey: (req) => req.headers["stripe-signature"] as string,
```

## Step 4: verify the signature inside `fromRequest`

Webhooks come from the public internet. Your `fromRequest` is the
trust boundary:

```ts
fromRequest: async (req) => {
  const sig = req.headers["stripe-signature"];
  const event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_SECRET);
  return { type: event.type, data: event.data };
},
```

A throw aborts dispatch. The auth guard does NOT cover
`/api/webhooks/*` — third parties don't have your API keys. Per-route
HMAC verification is the right boundary, not bearer auth.

## Common issues

**Route returns 404.** The path matcher is exact + `:param` capture.
`/leads/:tenant` matches `/leads/acme` but not `/leads/acme/extra`.

**Body shows up as `{}` even though you sent JSON.** The router parses
JSON; if `content-type` isn't `application/json`, body is empty. Most
webhook senders set this correctly.

**Signature verification keeps failing.** `req.rawBody` (the
unparsed bytes) is what HMAC libraries want, not `req.body` (the parsed
JSON).

## Next

- [The router source](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/src/runner/webhooks.ts) — ~120 LoC, no Express dep.
- [How a run executes](/thodare/explanation/how-it-runs/) — what dispatch does after the route fires.
