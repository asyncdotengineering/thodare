/**
 * In-memory token bucket rate limit, keyed by `(organizationId, principal)`
 * where `principal` is either the API key id (for programmatic callers) or
 * the user id (for sessions). Fine for single-process deployments; swap
 * the bucket map for Redis when you go multi-process.
 *
 * Must run AFTER the auth middleware — it consumes `c.get("organizationId")`,
 * `c.get("user")`, and `c.get("apiKeyId")`. If those are not set (e.g., open
 * paths that bypassed auth), this middleware is a no-op.
 */

import type { MiddlewareHandler } from "hono";
import type { AuthVariables } from "./session.js";

export function tokenBucketRateLimit(opts: {
  perMin: number;
  openPaths?: string[];
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const open = new Set(opts.openPaths ?? []);
  const buckets = new Map<string, { tokens: number; refilledAt: number }>();
  const refillIntervalMs = 60_000;

  return async (c, next) => {
    if (open.has(c.req.path)) return next();
    if (c.req.path.startsWith("/api/auth/")) return next();

    const orgId = c.get("organizationId");
    const apiKeyId = c.get("apiKeyId");
    const user = c.get("user");
    if (!orgId || !user) return next(); // auth middleware will have rejected; safety only

    // Key = (org, principal). API keys have their own id; sessions key by user.
    const key = `${orgId}:${apiKeyId ?? user.id}`;

    const now = Date.now();
    const cur = buckets.get(key) ?? { tokens: opts.perMin, refilledAt: now };
    const elapsed = now - cur.refilledAt;
    if (elapsed > 0) {
      const refill = (elapsed / refillIntervalMs) * opts.perMin;
      cur.tokens = Math.min(opts.perMin, cur.tokens + refill);
      cur.refilledAt = now;
    }
    if (cur.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - cur.tokens) / opts.perMin) * refillIntervalMs);
      buckets.set(key, cur);
      return c.json({ error: "rate_limited", retryAfterMs }, 429);
    }
    cur.tokens -= 1;
    buckets.set(key, cur);
    return next();
  };
}
