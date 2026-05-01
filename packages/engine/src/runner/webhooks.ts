/**
 * createWebhookRouter — typed inbound-webhook → workflow dispatch.
 *
 * Pattern: HTTP-server-agnostic webhook router for
 * `apps/control-plane-worker/openworkflow/handle-integration-webhook-event/`
 * but reduced to the part that's reusable across products: a router that
 * matches paths, extracts params, validates payload via the workflow's
 * Zod input schema, and dispatches a typed runSpec on the kit.
 *
 * HTTP-server agnostic: `handle({ method, path, headers, body })` takes a
 * fabricated request shape so the same router plugs into Express, Hono,
 * Bun.serve, raw http, or test code.
 */

import type { Wfkit } from "../client.js";
import type { WorkflowSpec } from "../define/spec.js";
import type { DurableHandle } from "./handle.js";

export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Populated by the matcher with `:param` captures. */
  params: Record<string, string>;
  /** Populated from the URL query string by the caller (router does not parse it). */
  query?: Record<string, string>;
}

export interface WebhookResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RegisterRouteOptions<SpecT extends WorkflowSpec<any, any, any, any>> {
  path: string;
  method?: string;
  spec: SpecT;
  /**
   * Extract the workflow input from the request. Receives the request object
   * with `:param` captures populated; returns the input shape declared by
   * `spec.input`.
   */
  fromRequest: (req: WebhookRequest) => SpecInputType<SpecT> | Promise<SpecInputType<SpecT>>;
  /** Derive an idempotency key from the request — duplicate deliveries dedupe to the same run. */
  idempotencyKey?: (req: WebhookRequest) => string;
}

export interface CreateWebhookRouterOptions {
  wfkit: Wfkit;
}

export interface WebhookRouter {
  register: <SpecT extends WorkflowSpec<any, any, any, any>>(opts: RegisterRouteOptions<SpecT>) => void;
  handle: (req: Omit<WebhookRequest, "params"> & { params?: Record<string, string> }) => Promise<WebhookResponse>;
  /** Read access to the registered routes. Useful for test introspection. */
  routes: () => ReadonlyArray<{ method: string; path: string; specName: string }>;
}

export function createWebhookRouter(opts: CreateWebhookRouterOptions): WebhookRouter {
  type Compiled = {
    method: string;
    pathTemplate: string;
    matcher: (path: string) => Record<string, string> | null;
    spec: WorkflowSpec<any, any, any, any>;
    fromRequest: (req: WebhookRequest) => unknown | Promise<unknown>;
    idempotencyKey?: (req: WebhookRequest) => string;
  };
  const routes: Compiled[] = [];

  return {
    register(routeOpts) {
      const method = (routeOpts.method ?? "POST").toUpperCase();
      routes.push({
        method,
        pathTemplate: routeOpts.path,
        matcher: compilePathMatcher(routeOpts.path),
        spec: routeOpts.spec,
        fromRequest: routeOpts.fromRequest as (req: WebhookRequest) => unknown,
        ...(routeOpts.idempotencyKey !== undefined
          ? { idempotencyKey: routeOpts.idempotencyKey }
          : {}),
      });
    },

    routes() {
      return routes.map((r) => ({
        method: r.method,
        path: r.pathTemplate,
        specName: `${r.spec.name}@${r.spec.version}`,
      }));
    },

    async handle(rawReq) {
      const reqMethod = (rawReq.method ?? "GET").toUpperCase();
      for (const route of routes) {
        if (route.method !== reqMethod) continue;
        const params = route.matcher(rawReq.path);
        if (!params) continue;

        const req: WebhookRequest = {
          method: reqMethod,
          path: rawReq.path,
          headers: rawReq.headers,
          body: rawReq.body,
          params,
          ...(rawReq.query ? { query: rawReq.query } : {}),
        };

        // Resolve the workflow input from the request.
        let input: unknown;
        try {
          input = await route.fromRequest(req);
        } catch (e: unknown) {
          return {
            status: 500,
            body: {
              error: "from_request_failed",
              message: e instanceof Error ? e.message : String(e),
            },
          };
        }

        // Validate against spec.input (if present) BEFORE creating a run.
        if (route.spec.input) {
          const parsed = route.spec.input.safeParse(input);
          if (!parsed.success) {
            return {
              status: 400,
              body: {
                error: "validation_failed",
                issues: parsed.error.errors.map((e: { path: (string | number)[]; message: string }) => ({
                  path: e.path,
                  message: e.message,
                })),
              },
            };
          }
        }

        // Dispatch.
        const idempotencyKey = route.idempotencyKey?.(req);
        let handle: DurableHandle;
        try {
          handle = await opts.wfkit.runSpec(
            route.spec,
            input,
            idempotencyKey ? { idempotencyKey } : undefined,
          );
        } catch (e: unknown) {
          return {
            status: 500,
            body: {
              error: "dispatch_failed",
              message: e instanceof Error ? e.message : String(e),
            },
          };
        }

        return { status: 202, body: { runId: handle.id } };
      }
      return { status: 404, body: { error: "no_route" } };
    },
  };
}

/* ──────────────  Path matcher  ────────────── */

/**
 * Compile a path template like "/tenants/:tenant/events/:eventId" into a
 * matcher that returns either a `Record<paramName, captured>` or null on
 * no match. Trailing slashes are normalized.
 *
 * Intentionally tiny — no wildcards, no optional segments, no regex
 * inside :params. The webhook surface is well-known; we don't need
 * path-to-regexp's complexity.
 */
function compilePathMatcher(template: string): (path: string) => Record<string, string> | null {
  const tplParts = normalize(template).split("/");
  const paramNames: Array<string | null> = tplParts.map((seg) =>
    seg.startsWith(":") ? seg.slice(1) : null,
  );
  return (path: string) => {
    const parts = normalize(path).split("/");
    if (parts.length !== tplParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < tplParts.length; i++) {
      const tplSeg = tplParts[i]!;
      const pathSeg = parts[i]!;
      if (paramNames[i] != null) {
        params[paramNames[i]!] = decodeURIComponent(pathSeg);
        continue;
      }
      if (tplSeg !== pathSeg) return null;
    }
    return params;
  };
}

function normalize(p: string): string {
  let out = p;
  if (!out.startsWith("/")) out = `/${out}`;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Helper: extract the input type from a WorkflowSpec. */
type SpecInputType<S> = S extends WorkflowSpec<infer I, any, any, any> ? I : never;
