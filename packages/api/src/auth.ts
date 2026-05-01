/**
 * Thodare auth — wraps better-auth + the organization + apiKey plugins.
 *
 * Why these specific plugins:
 *
 *   - `organization` — every workflow / run / schedule is scoped to an
 *     organization. Multi-tenant from day one (a single-user dev still
 *     gets a "personal" org).
 *   - `apiKey` configured with `references: "organization"` — programmatic
 *     callers (LLM orchestrators, CI, server-to-server) authenticate with
 *     a long-lived `thd_…` key whose ownership IS the organization. No
 *     extra metadata join required to resolve the active org.
 *   - `bearer` — lets cookie sessions also be carried via the
 *     `Authorization: Bearer <session_token>` header, so non-browser
 *     clients (curl, mobile) can hold a session without a cookie jar.
 *
 * Database: better-auth gets its own `pg.Pool`. We set `search_path` on
 * the connection so all auth tables land in the API instance's schema —
 * this preserves the per-API-instance isolation our existing stores use.
 *
 * Migrations: `getMigrations(auth.options).runMigrations()` is the
 * programmatic equivalent of `npx @better-auth/cli migrate`. The test
 * harness calls it once per schema; production calls it during boot.
 */

import { betterAuth } from "better-auth";
import { organization, bearer } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { Pool, type PoolConfig } from "pg";
import { getMigrations } from "better-auth/db/migration";

export const API_KEY_PREFIX = "thd_";

export interface CreateAuthOptions {
  /** Postgres connection URL. */
  pgUrl: string;
  /**
   * The schema in which better-auth tables live. Set as `search_path` on
   * the auth Pool so migrations + queries land here without manual
   * prefixing. MUST already exist (the API factory creates it).
   */
  schema: string;
  /** Public base URL used in redirect / verification flows. */
  baseURL: string;
  /** Secret used for session signing. Min 32 chars. */
  secret: string;
  /** When false, skip cookie-secure flag (tests over plain http). */
  trustHost?: boolean;
}

export function createAuthPool(opts: { pgUrl: string; schema: string }): Pool {
  // `options: -c search_path=...` is libpq's per-connection setting. With
  // pg.Pool, every connection in the pool inherits it.
  const cfg: PoolConfig = {
    connectionString: opts.pgUrl,
    options: `-c search_path=${escapeIdent(opts.schema)},public`,
    max: 4,
  };
  return new Pool(cfg);
}

function escapeIdent(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)) {
    throw new Error(`unsafe schema identifier: ${s}`);
  }
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseAuth = any;

export function createAuth(opts: CreateAuthOptions): { auth: LooseAuth; pool: Pool } {
  const pool = createAuthPool({ pgUrl: opts.pgUrl, schema: opts.schema });
  const auth = betterAuth({
    database: pool,
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: [opts.baseURL, "http://test", "http://localhost"],
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      // Keep test bootstrap fast. Production should require verification.
      requireEmailVerification: false,
    },
    advanced: {
      // We're behind our own host gate; don't double-secure cookies in tests.
      useSecureCookies: opts.trustHost ?? false,
    },
    /**
     * Auto-create a personal organization for every new user, so a
     * first-time sign-up never 401s with `no_active_organization` on the
     * subsequent protected request.
     *
     * Strategy: directly INSERT the organization + member rows via the
     * Pool. We can't recursively call `auth.api.createOrganization` here
     * because the auth instance isn't fully constructed yet during
     * plugin init — and even if we waited, that path needs a session
     * for the calling user, which doesn't exist mid-signup.
     *
     * The active-org assignment is handled at session-create time via
     * the `organization` plugin's `setActiveOrganizationOnSessionCreate`
     * (default: true) — when a session has no active org, the plugin
     * auto-selects the user's first membership.
     *
     * Hook errors are caught and logged but never block sign-up. A user
     * without a personal org can still create one manually.
     */
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; email: string }) => {
            try {
              await autoCreatePersonalOrg(pool, user);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn("[thodare] auto-org create failed:", err instanceof Error ? err.message : err);
            }
          },
        },
      },
    },
    plugins: [
      organization({
        // Allow a fresh user to immediately set up their first org.
        allowUserToCreateOrganization: true,
        // Reasonable defaults; override per-deployment if needed.
        organizationLimit: 100,
        membershipLimit: 1000,
      }),
      apiKey([
        {
          configId: "default",
          references: "organization",
          defaultPrefix: API_KEY_PREFIX,
          defaultKeyLength: 48,
          requireName: false,
          // Accept the key from EITHER `Authorization: Bearer thd_…` (the
          // common curl/LLM-orchestrator pattern) or `x-api-key: thd_…`.
          // Bearer values that don't start with our prefix are passed
          // through untouched so the bearer-plugin can interpret them as
          // session tokens.
          customAPIKeyGetter: (ctx) => {
            const headers = ctx.request?.headers;
            if (!headers) return null;
            const auth = headers.get("authorization") ?? "";
            const m = auth.match(/^Bearer\s+(.+)$/i);
            const candidate = m?.[1];
            if (candidate !== undefined && candidate.startsWith(API_KEY_PREFIX)) {
              return candidate;
            }
            return headers.get("x-api-key");
          },
          // Plugin's built-in per-key rate limit collides with our own
          // (org, principal) bucket. Disable here; we own the limit.
          rateLimit: { enabled: false },
          // Synthesize a session whenever a request carries a valid API
          // key. `getSession({ headers })` then handles cookies AND keys
          // through one path — the auth guard stays a one-liner.
          enableSessionForAPIKeys: true,
        },
      ]),
      bearer(),
    ],
  });
  return { auth, pool };
}

export type Auth = LooseAuth;

/**
 * Run better-auth migrations against the configured Pool. Idempotent —
 * tables already present are left alone, missing columns get added.
 */
export async function runAuthMigrations(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * Insert a personal organization + membership for a freshly-created
 * user. Called from the user-create databaseHook.
 *
 * The organization plugin's `setActiveOrganizationOnSessionCreate`
 * default behavior auto-selects the first membership for sessions
 * without an active org, so we don't need to touch the session here.
 */
async function autoCreatePersonalOrg(pool: Pool, user: { id: string; email: string }): Promise<void> {
  const emailPrefix = (user.email.split("@")[0] || "user").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const slugSuffix = randomShortId();
  const slug = `${emailPrefix}-${slugSuffix}`.slice(0, 60);
  const name = `${emailPrefix}'s workspace`;
  const orgId = randomLongId();
  const memberId = randomLongId();
  const now = new Date();
  // Two writes inside a single connection — atomic against ROLLBACK if
  // either fails. Better-auth uses lower-case unquoted "user" / "session"
  // table names; we match its identifier choices.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, $4)`,
      [orgId, name, slug, now],
    );
    await client.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, $5)`,
      [memberId, orgId, user.id, "owner", now],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function randomLongId(): string {
  // 32-char URL-safe lower-case alphanum, mirrors better-auth's default
  // ID format closely enough for human-readable rows.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
