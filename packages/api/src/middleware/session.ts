/**
 * Session middleware — resolves authentication into `(user, organizationId)`
 * on the Hono context.
 *
 * Auth modes (any one of these is sufficient):
 *
 *   - **Cookie session** — set by better-auth's emailAndPassword sign-in.
 *   - **Bearer session token** — `Authorization: Bearer <session_token>`,
 *     enabled by the `bearer` plugin. Same identity as the cookie path.
 *   - **API key** — `Authorization: Bearer thd_…` or `x-api-key: thd_…`.
 *     Verified by the apiKey plugin (configured with `references:
 *     "organization"`) — `referenceId` IS the organization id, no join.
 *
 * Resolution order:
 *
 *   1. `auth.api.getSession({ headers })` — handles cookies + Bearer
 *      session tokens. If a real user session exists, use it.
 *   2. If the caller carried an API key (`thd_…`), verify it via
 *      `auth.api.verifyApiKey`. The verified key surfaces user + org.
 *
 * On success: `c.set("user", …)`, `c.set("organizationId", …)`,
 * `c.set("authMode", …)`. Routes downstream consume those.
 *
 * On failure: 401 `{ error: "unauthorized" | "no_active_organization" }`.
 *
 * Fail-closed: any path NOT in `openPaths` and NOT under `/api/auth/*`
 * requires a resolved identity.
 */

import type { MiddlewareHandler } from "hono";
import type { Auth } from "../auth.js";
import { API_KEY_PREFIX } from "../auth.js";

export interface SessionUser {
  id: string;
  email: string;
}

export type AuthMode = "session" | "api-key";

export type AuthVariables = {
  user: SessionUser;
  organizationId: string;
  authMode: AuthMode;
  /** When `authMode === "api-key"`, the key's id (for telemetry). */
  apiKeyId?: string;
};

const AUTH_PREFIX = "/api/auth/";

function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const candidate = m?.[1];
  if (candidate !== undefined && candidate.startsWith(API_KEY_PREFIX)) {
    return candidate;
  }
  return headers.get("x-api-key");
}

export function authGuard(opts: {
  auth: Auth;
  /** Paths that bypass auth entirely. `/api/auth/*` is always open. */
  openPaths?: string[];
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const open = new Set(opts.openPaths ?? []);
  const auth = opts.auth;

  return async (c, next) => {
    const path = c.req.path;
    if (open.has(path)) return next();
    if (path.startsWith(AUTH_PREFIX)) return next();

    // 1. Cookie / bearer-session-token resolution.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user && session.session) {
      const orgId =
        (session.session as { activeOrganizationId?: string }).activeOrganizationId ??
        (session.user as { activeOrganizationId?: string }).activeOrganizationId;
      if (!orgId) return c.json({ error: "no_active_organization" }, 401);
      c.set("user", { id: session.user.id, email: session.user.email });
      c.set("organizationId", orgId);
      c.set("authMode", "session");
      return next();
    }

    // 2. API-key fallback.
    const candidate = extractApiKey(c.req.raw.headers);
    if (candidate) {
      // The api-key plugin adds verifyApiKey to the auth.api surface at
      // runtime, but its type is widened by better-auth's plugin system
      // and TS can't statically prove the method exists. Cast through a
      // narrow ad-hoc shape.
      const verifier = auth.api as unknown as {
        verifyApiKey: (input: { body: { configId: string; key: string } }) => Promise<{
          valid: boolean;
          key?: { id: string; referenceId: string; userId?: string; name?: string };
        }>;
      };
      const result = await verifier.verifyApiKey({
        body: { configId: "default", key: candidate },
      });
      if (result.valid && result.key) {
        // The api-key plugin (configured with references: "organization")
        // sets referenceId = organizationId. Identity here is the key
        // itself; we synthesize a SessionUser so downstream code can rely
        // on `c.get("user")` regardless of auth mode.
        c.set("user", {
          id: result.key.userId ?? result.key.id,
          email: `apikey:${result.key.name ?? result.key.id}`,
        });
        c.set("organizationId", result.key.referenceId);
        c.set("authMode", "api-key");
        c.set("apiKeyId", result.key.id);
        return next();
      }
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}
