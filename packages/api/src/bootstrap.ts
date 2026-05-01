/**
 * First-run admin bootstrap — solves the cold-start paradox.
 *
 * A fresh deploy of @thodare/api against an empty Postgres has zero
 * users and zero API keys. Every protected route 401s. The signup
 * chain is gated by an `Origin` header most operators don't think to
 * set. Result: support tickets that boil down to "where do I get the
 * first key?"
 *
 * The fix (lifted from Plausible / Sentry / Outline self-host):
 *
 *   1. On API boot, if `THODARE_BOOTSTRAP=1` AND the `user` table is
 *      empty, print a one-time signed bootstrap link to stderr.
 *   2. Hitting that link mints the first user + personal org + API
 *      key. The link self-disables on first use because the user
 *      table is no longer empty.
 *
 * Production deploys without `THODARE_BOOTSTRAP=1` never expose the
 * route. The signed token is derived from `authSecret` + a fixed
 * domain string so it's stable across crashes (one-time across the
 * deploy, not across each restart).
 */

import { Hono } from "hono";
import { createHmac, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Auth } from "./auth.js";
import { API_KEY_PREFIX } from "./auth.js";

export const BOOTSTRAP_PATH = "/api/bootstrap";

export interface BootstrapOptions {
  pool: Pool;
  auth: Auth;
  authSecret: string;
  baseURL: string;
  /** Logger; defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * Compute the deterministic bootstrap token from `authSecret`. Stable
 * across server restarts so logs printed once at startup remain valid
 * until the first successful bootstrap.
 */
export function computeBootstrapToken(authSecret: string): string {
  return createHmac("sha256", authSecret).update("thodare:bootstrap:v1").digest("hex");
}

/**
 * Whether the bootstrap mechanism is currently armed.
 *
 *   - `THODARE_BOOTSTRAP=1` must be set.
 *   - The `user` table must be empty (no rows).
 */
export async function isBootstrapArmed(opts: { pool: Pool }): Promise<boolean> {
  if (process.env["THODARE_BOOTSTRAP"] !== "1") return false;
  try {
    const r = await opts.pool.query(`SELECT COUNT(*)::int AS c FROM "user"`);
    const count = (r.rows[0] as { c: number } | undefined)?.c ?? 0;
    return count === 0;
  } catch {
    // If the user table doesn't exist yet, we're definitely empty.
    return true;
  }
}

/**
 * Build the Hono router for `/api/bootstrap`. The router is mounted
 * unconditionally; it self-checks armed state on every request, so a
 * boot when armed → first-use fires → subsequent calls 404.
 */
export function createBootstrapRouter(opts: BootstrapOptions): Hono {
  const app = new Hono();
  const expectedToken = computeBootstrapToken(opts.authSecret);

  app.get("/", async (c) => {
    if (!(await isBootstrapArmed({ pool: opts.pool }))) {
      return c.json({ error: "not_found" }, 404);
    }
    const provided = c.req.query("token") ?? "";
    // Constant-time-ish comparison (we're not in adversarial-timing
    // territory but the habit is cheap).
    if (provided.length !== expectedToken.length || !timingSafeEq(provided, expectedToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // Generate credentials. Email is derived from a random ID so it's
    // unique across re-bootstraps if someone wipes the DB.
    const random = randomBytes(8).toString("hex");
    const email = `admin-${random}@bootstrap.thodare.local`;
    const password = randomBytes(18).toString("base64url");

    // Sign up via better-auth's HTTP path so the auto-org databaseHook
    // fires (creates the personal org). Then issue an API key via
    // direct internal call.
    const baseURL = opts.baseURL;
    const signUpRes = await opts.auth.handler(new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ email, password, name: "Bootstrap admin" }),
    }));
    if (!signUpRes.ok) {
      const txt = await signUpRes.text();
      return c.json({ error: "sign_up_failed", detail: txt }, 500);
    }
    const signUpBody = (await signUpRes.json()) as { user?: { id: string } };
    const userId = signUpBody.user?.id;
    if (!userId) return c.json({ error: "sign_up_failed", detail: "no user returned" }, 500);

    // Capture session cookie to authenticate the api-key creation.
    const cookie = (signUpRes.headers.get("set-cookie") ?? "")
      .split(",")
      .map((s: string) => s.split(";")[0]!.trim())
      .filter(Boolean)
      .join("; ");
    if (!cookie) return c.json({ error: "sign_up_failed", detail: "no session cookie" }, 500);

    // Look up the auto-created org.
    const orgListRes = await opts.auth.handler(new Request(`${baseURL}/api/auth/organization/list`, {
      method: "GET",
      headers: { origin: baseURL, cookie },
    }));
    const orgs = (await orgListRes.json()) as Array<{ id: string; slug: string }>;
    if (!Array.isArray(orgs) || orgs.length === 0) {
      return c.json({ error: "no_org", detail: "auto-org hook didn't fire" }, 500);
    }
    const organizationId = orgs[0]!.id;
    const organizationSlug = orgs[0]!.slug;

    // Mint the API key.
    const keyRes = await opts.auth.handler(new Request(`${baseURL}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL, cookie },
      body: JSON.stringify({
        configId: "default",
        name: "bootstrap-admin-key",
        organizationId,
      }),
    }));
    if (!keyRes.ok) {
      const txt = await keyRes.text();
      return c.json({ error: "key_create_failed", detail: txt }, 500);
    }
    const keyBody = (await keyRes.json()) as { key?: string; id?: string; data?: { key: string; id: string } };
    const apiKey = keyBody.key ?? keyBody.data?.key;
    const apiKeyId = keyBody.id ?? keyBody.data?.id;
    if (!apiKey || !apiKeyId) return c.json({ error: "key_create_failed" }, 500);

    return c.json({
      ok: true,
      email,
      password,
      apiKey,
      apiKeyPrefix: API_KEY_PREFIX,
      apiKeyId,
      organizationId,
      organizationSlug,
      message:
        "Save this. The bootstrap link self-disables now that you've used it. " +
        "Sign in with email + password, or use Authorization: Bearer <apiKey>.",
    });
  });

  return app;
}

/**
 * On API boot, if armed, log the bootstrap link to stderr so the
 * operator can copy it from `journalctl` / `kubectl logs` / wherever.
 * No-op when not armed.
 */
export async function logBootstrapLinkIfArmed(opts: BootstrapOptions): Promise<void> {
  if (!(await isBootstrapArmed({ pool: opts.pool }))) return;
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const token = computeBootstrapToken(opts.authSecret);
  const url = `${opts.baseURL}${BOOTSTRAP_PATH}?token=${token}`;
  log("");
  log("🔓 First-run bootstrap is armed.");
  log(`   ${url}`);
  log("   Curl that URL once to mint your first admin user + org + API key.");
  log("   The link self-disables after first use.");
  log("");
}

function timingSafeEq(a: string, b: string): boolean {
  // crypto.timingSafeEqual requires equal-length Buffers; we already
  // checked length before calling.
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
