/**
 * Postgres test harness for @thodare/api.
 *
 * Each test gets a unique schema (so runs are isolated and
 * concurrent-safe) AND a freshly bootstrapped:
 *
 *   - test user        (`test-<uuid>@thodare.dev` / fixed password)
 *   - personal org     (slug `org-<uuid>`)
 *   - active org       (set on the user's session)
 *   - API key          (`thd_…`, owned by the org via apiKey plugin's
 *                       `references: "organization"`)
 *
 * Tests authenticate by calling `withAuth(h.token)` — the token is the
 * raw API key, sent as `Authorization: Bearer thd_…`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { createWfkit, defineConnector, type Wfkit } from "@thodare/engine";
import { z } from "zod";
import { createControlPlaneApi, type ControlPlaneApi } from "../src/index.js";

const PG_URL = process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test";
const TEST_PASSWORD = "test-password-1234";
const AUTH_SECRET = "test-secret-thodare-control-plane-not-for-prod-use";
const BASE_URL = "http://test";

export interface ApiHarness {
  app: ControlPlaneApi["app"];
  api: ControlPlaneApi;
  wfkit: Wfkit;
  schema: string;
  /** Invoke the API as a fetch call. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Raw API key — pass through `withAuth(token)` for `Authorization: Bearer`. */
  token: string;
  /** The bootstrapped organization id. */
  organizationId: string;
  /** The bootstrapped test user id. */
  userId: string;
  /** Email of the bootstrapped test user. */
  userEmail: string;
  /** Helper to mint a SECOND user + org + key (for cross-tenant isolation tests). */
  createOtherTenant: () => Promise<{ token: string; organizationId: string; userId: string; userEmail: string }>;
  dispose: () => Promise<void>;
}

export interface NewApiHarnessOptions {
  /** Built-in connectors registered on the kit. Default: []. */
  connectors?: ReturnType<typeof defineConnector>[];
  /** Per-(org,principal) rate limit (req/min). Default: 1000 (off in tests). */
  rateLimitPerMin?: number;
  /** Skip starting the openworkflow worker. Default: false. */
  skipStartWorker?: boolean;
  /** Skip auto-bootstrap of user+org+key. Default: false. */
  skipBootstrap?: boolean;
}

let tmpDirs: string[] = [];

/**
 * Sign up a user, create an org, set it active, issue an API key.
 * Returns the raw API key (`thd_…`) plus the org/user ids.
 *
 * All steps go through better-auth's HTTP handler — we drive the same
 * routes the real client would, so the bootstrap is end-to-end correct.
 */
async function bootstrapTenant(
  api: ControlPlaneApi,
  emailHint: string,
): Promise<{ token: string; organizationId: string; userId: string; userEmail: string }> {
  const fetcher = (path: string, init?: RequestInit) =>
    api.app.fetch(new Request(`${BASE_URL}${path}`, init));

  // 1. Sign up. better-auth's emailAndPassword route also signs the user
  // in (autoSignIn: true) and returns a Set-Cookie session.
  const signUpRes = await fetcher("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({
      email: emailHint,
      password: TEST_PASSWORD,
      name: emailHint.split("@")[0],
    }),
  });
  if (!signUpRes.ok) {
    const txt = await signUpRes.text();
    throw new Error(`bootstrap: sign-up failed ${signUpRes.status}: ${txt}`);
  }
  const signUpBody = (await signUpRes.json()) as { user?: { id: string }; token?: string };
  const userId = signUpBody.user?.id;
  if (!userId) throw new Error(`bootstrap: sign-up returned no user`);

  // Capture session cookie for subsequent calls.
  const cookie = (signUpRes.headers.get("set-cookie") ?? "")
    .split(",")
    .map((s) => s.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error(`bootstrap: no session cookie returned`);

  const authHeaders = { "content-type": "application/json", cookie, origin: BASE_URL };

  // 2. The auto-org databaseHook (see auth.ts) inserted a personal org +
  // membership during sign-up. Look it up — that's the active org.
  const orgListRes = await fetcher("/api/auth/organization/list", {
    method: "GET",
    headers: { cookie, origin: BASE_URL },
  });
  if (!orgListRes.ok) {
    const txt = await orgListRes.text();
    throw new Error(`bootstrap: organization/list failed ${orgListRes.status}: ${txt}`);
  }
  const orgs = (await orgListRes.json()) as Array<{ id: string; slug: string }>;
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error(`bootstrap: auto-org hook didn't fire — no organization for ${emailHint}`);
  }
  const organizationId = orgs[0]!.id;

  // The org plugin's `setActiveOrganizationOnSessionCreate` (default true)
  // already activated the only membership; no explicit set-active needed.

  // 3. Issue an API key. Because the apiKey plugin is configured with
  // `references: "organization"`, organizationId is the canonical owner.
  const keyRes = await fetcher("/api/auth/api-key/create", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      configId: "default",
      name: "test-key",
      organizationId,
    }),
  });
  if (!keyRes.ok) {
    const txt = await keyRes.text();
    throw new Error(`bootstrap: api-key/create failed ${keyRes.status}: ${txt}`);
  }
  const keyBody = (await keyRes.json()) as { key?: string; data?: { key: string } };
  const token = keyBody.key ?? keyBody.data?.key;
  if (!token) throw new Error(`bootstrap: api-key/create returned no key`);

  return { token, organizationId, userId, userEmail: emailHint };
}

export async function newApiHarness(opts: NewApiHarnessOptions = {}): Promise<ApiHarness> {
  const schema = `cpa_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const tmp = mkdtempSync(join(tmpdir(), "cpa-"));
  tmpDirs.push(tmp);

  const backend = await BackendPostgres.connect(PG_URL, { schema });
  const wfkit = await createWfkit({ backend });
  if (opts.connectors) {
    wfkit.register(...opts.connectors);
  }

  const api = await createControlPlaneApi({
    pgUrl: PG_URL,
    schema,
    wfkit,
    baseURL: BASE_URL,
    authSecret: AUTH_SECRET,
    rateLimitPerMin: opts.rateLimitPerMin ?? 1000,
  });

  if (!opts.skipStartWorker) {
    await wfkit.start();
  }

  const fetcher = async (path: string, init?: RequestInit) => {
    return api.app.fetch(new Request(`${BASE_URL}${path}`, init));
  };

  const primaryEmail = `test-${randomUUID().slice(0, 8)}@thodare.dev`;
  const primary = opts.skipBootstrap
    ? { token: "", organizationId: "", userId: "", userEmail: "" }
    : await bootstrapTenant(api, primaryEmail);

  return {
    app: api.app,
    api,
    wfkit,
    schema,
    fetch: fetcher,
    token: primary.token,
    organizationId: primary.organizationId,
    userId: primary.userId,
    userEmail: primary.userEmail,
    createOtherTenant: async () => {
      const email = `other-${randomUUID().slice(0, 8)}@thodare.dev`;
      return bootstrapTenant(api, email);
    },
    dispose: async () => {
      try { await api.dispose(); } catch {}
      try { await wfkit.stop(); } catch {}
      try {
        const sql = postgres(PG_URL, { max: 1 });
        try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await sql.end({ timeout: 5 }); }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[harness] dispose warning:`, e);
      }
    },
  };
}

/** Helper: build a Headers object with the bearer token attached. */
export function withAuth(token: string, extra: Record<string, string> = {}): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...extra };
}

/** Helper: a sample echo connector tests can reuse. */
export const echoConnector = defineConnector({
  type: "echo",
  params: z.object({ msg: z.string() }),
  outputs: z.object({ msg: z.string() }),
  async run({ msg }) { return { msg }; },
});

/** Cleanup any leaked tmp dirs after the suite. */
export function cleanupTmp(): void {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpDirs = [];
}
