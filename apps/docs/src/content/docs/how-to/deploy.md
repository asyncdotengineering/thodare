---
title: Deploy on Bun / Node / Workers
description: "Mount the Hono app on the runtime of your choice."
---

## Goal

Take the `api.app` Hono instance from
[Reference example](/thodare/start/reference-example/) and serve it
in production.

## Bun

```ts
import { ... } from "@thodare/api";
const api = await createControlPlaneApi({ /* … */ });
await wfkit.start();

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: api.app.fetch,
});
```

That's the entire production server. Bun handles TLS termination via
your reverse proxy or the platform.

## Node

```ts
import { serve } from "@hono/node-server";
const api = await createControlPlaneApi({ /* … */ });
await wfkit.start();

serve({
  fetch: api.app.fetch,
  port: Number(process.env.PORT ?? 3000),
});
```

`@hono/node-server` is the canonical adapter. No Express, no Koa
shim needed.

## Cloudflare Workers

```ts
import { createControlPlaneApi } from "@thodare/api";

let api: Awaited<ReturnType<typeof createControlPlaneApi>>;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!api) {
      api = await createControlPlaneApi({
        pgUrl: env.DATABASE_URL,
        schema: "ops",
        wfkit: await createWfkit({ /* Workers-compatible backend */ }),
        baseURL: "https://api.your-domain.dev",
        authSecret: env.AUTH_SECRET,
      });
      await api.app.fetch; // no worker.start() needed; Workers don't have a long-running worker
    }
    return api.app.fetch(req);
  },
} satisfies ExportedHandler<Env>;
```

> ⚠️ **openworkflow's worker assumes a long-running process.** Workers
> can run the API surface but the *durable execution* runtime needs
> somewhere persistent. Either run a dedicated worker pod alongside (most
> common), or wait for Workers + Durable Objects support — tracking issue
> on the upstream openworkflow side.

## Production checklist

| Step | Why |
|---|---|
| Set `authSecret` to ≥32 random chars from a secret manager | Session signing |
| Set `trustHost: true` over HTTPS | `Secure` cookie flag |
| Set `THODARE_BOOTSTRAP=1` once on first deploy, then unset | First admin |
| Tune `rateLimitPerMin` to your traffic | Per-(org,principal) bucket |
| Set up `pg_cron` or a worker for `/api/admin/tick` | Cron schedules fire |
| Run a separate openworkflow worker pod | Durable execution proceeds |
| Front with a TLS-terminating reverse proxy / load balancer | Standard practice |
| Set up DB backups | Standard practice |

## Common issues

**Cookies not setting in browsers.** `trustHost: false` (the default)
sends cookies without the `Secure` flag, which most browsers reject
over HTTPS. Set `trustHost: true` once you're behind TLS.

**`/api/auth/*` returns 403 `MISSING_OR_NULL_ORIGIN`.** better-auth's
CSRF gate. Browsers send `Origin` automatically; scripted clients
need to add `Origin: $baseURL` explicitly.

## Next

- [Bootstrap a fresh deployment](/thodare/how-to/bootstrap-admin/) — minting the first admin.
- [Schedule a workflow](/thodare/how-to/schedule-workflow/) — drive the tick.
