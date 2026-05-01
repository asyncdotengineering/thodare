/**
 * /api/webhooks/* — delegated to @thodare/engine's createWebhookRouter.
 *
 * Routes are registered via `api.webhooks.register({...})` programmatically
 * (NOT exposed as a mutating HTTP endpoint — webhook routes are
 * infrastructure, not user-mutable, to avoid arbitrary URL → workflow
 * binding from API callers).
 */

import { Hono } from "hono";
import { createWebhookRouter, defineWorkflowSpec, type Wfkit } from "@thodare/engine";
import { z } from "zod";

export interface WebhookRouteRegistration {
  path: string;
  method?: string;
  workflowName: string;
  fromRequest?: (req: any) => unknown | Promise<unknown>;
  idempotencyKey?: (req: any) => string;
  inputSchema?: z.ZodTypeAny;
}

export interface WebhooksController {
  register: (route: WebhookRouteRegistration) => void;
  app: Hono;
}

export function createWebhooksController(opts: { wfkit: Wfkit }): WebhooksController {
  const app = new Hono();
  // We keep our own list of registered routes, then create a wfkit webhook
  // router on first request. (Lazy because some routes might be added after
  // the API has booted.)
  const routes: WebhookRouteRegistration[] = [];
  let routerCache: ReturnType<typeof createWebhookRouter> | null = null;
  let routerCacheVersion = -1;
  let registrationVersion = 0;

  const buildRouter = () => {
    const r = createWebhookRouter({ wfkit: opts.wfkit });
    for (const route of routes) {
      // Build an ad-hoc spec — we wrap the workflowName as a spec so the
      // wfkit router can dispatch via runSpec.
      const spec = defineWorkflowSpec({
        name: route.workflowName,
        version: "1",
        ...(route.inputSchema ? { input: route.inputSchema } : {}),
      });
      r.register({
        path: route.path,
        method: route.method ?? "POST",
        spec,
        fromRequest: route.fromRequest ?? ((req: any) => req.body),
        ...(route.idempotencyKey ? { idempotencyKey: route.idempotencyKey } : {}),
      });
    }
    return r;
  };

  app.all("*", async (c) => {
    if (!routerCache || routerCacheVersion !== registrationVersion) {
      routerCache = buildRouter();
      routerCacheVersion = registrationVersion;
    }
    const url = new URL(c.req.url);
    const result = await routerCache.handle({
      method: c.req.method,
      path: url.pathname.replace(/^\/api\/webhooks/, ""),
      headers: Object.fromEntries(c.req.raw.headers.entries()),
      body: await c.req.json().catch(() => ({})),
      query: Object.fromEntries(url.searchParams.entries()),
    });
    return c.json(result.body as object, result.status as 200 | 202 | 400 | 404 | 500);
  });

  return {
    app,
    register(route) {
      routes.push(route);
      registrationVersion += 1;
    },
  };
}
