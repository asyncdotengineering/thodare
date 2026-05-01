---
title: Reference example
description: "A 30-line TypeScript file that boots @thodare/api locally."
---

If [Quickstart](/thodare/start/quickstart/) needs an API to talk to,
this is the smallest one you can run.

## Prerequisites

- **Node 22+**.
- **Postgres** at `postgresql://localhost:5432/thodare_local` (`createdb thodare_local`).

## Install

```sh
npm install @thodare/api @thodare/engine @thodare/openworkflow zod hono
```

## `server.ts`

```ts
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { createWfkit, defineConnector, hidden } from "@thodare/engine";
import { createControlPlaneApi } from "@thodare/api";
import { z } from "zod";

const PG_URL = process.env.DATABASE_URL ?? "postgresql://localhost:5432/thodare_local";

// 1. Define your connectors. Hidden params are server-side secrets the
// LLM literally cannot reference.
const slack = defineConnector({
  type: "slack",
  description: "Send a message to a Slack channel.",
  params: z.object({
    channel: z.string(),
    text: z.string(),
    accessToken: hidden(z.string()),  // ← LLM never sees this
  }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async run({ channel, text }) {
    // …call Slack…
    return { ok: true, ts: `${Date.now()}` };
  },
});

// 2. Create the kit + register connectors.
const backend = await BackendPostgres.connect(PG_URL, { schema: "ops" });
const wfkit = await createWfkit({ backend });
wfkit.register(slack);

// 3. Build the API.
const api = await createControlPlaneApi({
  pgUrl: PG_URL,
  schema: "ops",
  wfkit,
  baseURL: "http://localhost:3000",
  authSecret: process.env.AUTH_SECRET ?? "dev-secret-must-be-32-chars-or-more",
  rateLimitPerMin: 60,
});

// 4. Start the worker.
await wfkit.start();

// 5. Wire to your runtime.
//    Bun.serve({ port: 3000, fetch: api.app.fetch });
//    serve(api.app, { port: 3000 });   // @hono/node-server
//    export default api.app;            // Cloudflare Workers
```

## Run it

```sh
bun server.ts
# or
tsx server.ts
```

Then point [Quickstart](/thodare/start/quickstart/) at `http://localhost:3000`.

## What's in the box

- A Hono app at `api.app` you mount on any JS runtime.
- Postgres-backed durable execution with crash recovery.
- An LLM-feedable patch surface (`/api/workflows/:id/operations`).
- Bearer-token auth tied to organizations.
- Per-(org, principal) rate limiting.
- `/api/auth/*` routes from better-auth (sign up / sign in / org / key).
- `/api/bootstrap` for first-run admin (when armed).

## Production checklist

- Set `THODARE_BOOTSTRAP=1` once, copy the link from logs, then unset.
- Set `authSecret` to a real 32+ char value via your secret manager.
- Set `trustHost: true` over HTTPS so `Secure` cookie is enabled.
- Tune `rateLimitPerMin` to your traffic shape.
- Drive cron from pg_cron or a worker hitting `POST /api/admin/tick`.

## Next

- [Quickstart](/thodare/start/quickstart/) — interact with the API.
- [Deploy on Bun / Node / Workers](/thodare/how-to/deploy/) — production wiring.
