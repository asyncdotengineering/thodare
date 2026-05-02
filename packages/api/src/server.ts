/**
 * createControlPlaneApi — the factory that wires Hono + better-auth +
 * stores + @thodare/engine into one app.
 *
 * Auth model: better-auth handles identity (sessions OR API keys via the
 * apiKey plugin, configured with `references: "organization"`). Every
 * non-/health, non-/api/auth route runs through the auth guard and
 * resolves to `(user, organizationId)` on the Hono context.
 */

import { Hono } from "hono";
import type { Pool } from "pg";
import type { Wfkit } from "@thodare/engine";
import { createWorkflowStore, type WorkflowStore } from "./store/workflows.js";
import { createWorkflowsRouter } from "./routes/workflows.js";
import { createConnectorsRouter } from "./routes/connectors.js";
import { createRunsRouter } from "./routes/runs.js";
import { createSchedulesRouter, createAdminRouter } from "./routes/schedules.js";
import { createWebhooksController, type WebhooksController } from "./routes/webhooks.js";
import { createRuntimeHost } from "./runtime-host.js";
import { createScheduleStore, type ScheduleStore } from "./store/schedules.js";
import { createCredentialsStore, type CredentialStore } from "./store/credentials.js";
import { createCredentialsRouter } from "./routes/credentials.js";
import { authGuard, type AuthVariables } from "./middleware/session.js";
import { tokenBucketRateLimit } from "./middleware/rate-limit.js";
import { createAuth, runAuthMigrations, type Auth } from "./auth.js";
import { BOOTSTRAP_PATH, createBootstrapRouter, logBootstrapLinkIfArmed } from "./bootstrap.js";

export interface CreateControlPlaneApiOptions {
  pgUrl: string;
  /** Schema for ALL tables — better-auth tables AND the API's own tables. */
  schema: string;
  wfkit: Wfkit;
  /** Public base URL of the API (used by better-auth for redirects). */
  baseURL: string;
  /** Secret for session signing. Must be ≥32 chars. */
  authSecret: string;
  /** Per-(org,principal) rate limit (req/min). Default 60. */
  rateLimitPerMin?: number;
  /** API version string surfaced via /health. Default reads package.json. */
  versionLabel?: string;
  /** Set true in production over HTTPS to enable Secure cookies. */
  trustHost?: boolean;
  /** 32-byte master key for credential encryption. If unset, reads THODARE_CREDENTIALS_MASTER_KEY env var (base64). */
  credentialsMasterKey?: Uint8Array;
}

export interface ControlPlaneApi {
  app: Hono<{ Variables: AuthVariables }>;
  store: WorkflowStore;
  schedules: ScheduleStore;
  credentials: CredentialStore;
  credentialsMasterKey: Uint8Array | undefined;
  webhooks: WebhooksController;
  auth: Auth;
  authPool: Pool;
  dispose: () => Promise<void>;
}

const HEALTH_PATH = "/health";

export async function createControlPlaneApi(
  opts: CreateControlPlaneApiOptions,
): Promise<ControlPlaneApi> {
  // 0. Resolve the credentials master key. Both the programmatic
  // (`opts.credentialsMasterKey`) and env (`THODARE_CREDENTIALS_MASTER_KEY`)
  // paths are length-validated; an invalid key fails fast at boot rather
  // than silently producing weak ciphertexts at first use.
  let masterKey: Uint8Array | undefined = opts.credentialsMasterKey;
  if (masterKey && masterKey.length !== 32) {
    throw new Error(
      `opts.credentialsMasterKey must be exactly 32 bytes, got ${masterKey.length}`,
    );
  }
  if (!masterKey && process.env["THODARE_CREDENTIALS_MASTER_KEY"]) {
    const buf = Buffer.from(process.env["THODARE_CREDENTIALS_MASTER_KEY"]!, "base64");
    if (buf.length !== 32) {
      throw new Error(
        `THODARE_CREDENTIALS_MASTER_KEY must decode to 32 bytes, got ${buf.length}`,
      );
    }
    masterKey = new Uint8Array(buf);
  }

  // 1. Make sure the schema exists; both better-auth and our stores write
  // into it.
  const store = createWorkflowStore({ pgUrl: opts.pgUrl, schema: opts.schema });
  await store.init();
  const schedules = createScheduleStore({ pgUrl: opts.pgUrl, schema: opts.schema });
  await schedules.init();
  const credentials = createCredentialsStore({ pgUrl: opts.pgUrl, schema: opts.schema });
  await credentials.init();

  // 1. Boot better-auth and run its migrations into the same schema.
  const { auth, pool: authPool } = createAuth({
    pgUrl: opts.pgUrl,
    schema: opts.schema,
    baseURL: opts.baseURL,
    secret: opts.authSecret,
    ...(opts.trustHost !== undefined ? { trustHost: opts.trustHost } : {}),
  });
  await runAuthMigrations(auth);

  const app = new Hono<{ Variables: AuthVariables }>();

  // /health — no auth, no rate-limit.
  app.get(HEALTH_PATH, (c) =>
    c.json({ status: "ok", version: opts.versionLabel ?? "0.1.0" }),
  );

  // /api/auth/* — handed off to better-auth's handler. Bypasses our auth
  // guard (better-auth manages its own routes).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // /api/bootstrap — first-run admin bootstrap. Self-disables once the
  // user table is non-empty. The router checks the armed condition on
  // every request, so mounting unconditionally is safe.
  app.route(BOOTSTRAP_PATH, createBootstrapRouter({
    pool: authPool,
    auth,
    authSecret: opts.authSecret,
    baseURL: opts.baseURL,
  }));

  // Print the bootstrap link to stderr if THODARE_BOOTSTRAP=1 AND the
  // user table is empty. One-time, at startup.
  await logBootstrapLinkIfArmed({
    pool: authPool,
    auth,
    authSecret: opts.authSecret,
    baseURL: opts.baseURL,
  });

  // Auth guard + rate limit on everything else (bootstrap is open by
  // design — its only gate is the signed token + empty-DB check).
  app.use("*", authGuard({ auth, openPaths: [HEALTH_PATH, BOOTSTRAP_PATH] }));
  app.use("*", tokenBucketRateLimit({
    perMin: opts.rateLimitPerMin ?? 60,
    openPaths: [HEALTH_PATH, BOOTSTRAP_PATH],
  }));

  // Build the runtime host BEFORE the worker starts.
  const runtimeHost = createRuntimeHost({
    wfkit: opts.wfkit,
    credentialStore: credentials,
    ...(masterKey ? { masterKey } : {}),
  });

  app.route("/api/workflows", createWorkflowsRouter({ store, wfkit: opts.wfkit, runtimeHost }));
  app.route("/api/connectors", createConnectorsRouter({ wfkit: opts.wfkit }));
  app.route("/api/runs", createRunsRouter({ wfkit: opts.wfkit, runtimeHost }));
  app.route("/api/schedules", createSchedulesRouter({ store: schedules, workflows: store }));
  app.route("/api/admin", createAdminRouter({ schedules, workflows: store, runtimeHost }));

  if (masterKey) {
    app.route("/api/credentials", createCredentialsRouter({ store: credentials, masterKey }));
  }

  const webhooks = createWebhooksController({ wfkit: opts.wfkit });
  app.route("/api/webhooks", webhooks.app);

  return {
    app,
    store,
    schedules,
    credentials,
    credentialsMasterKey: masterKey,
    webhooks,
    auth,
    authPool,
    async dispose() {
      await store.dispose();
      await schedules.dispose();
      await credentials.dispose();
      try { await authPool.end(); } catch {}
    },
  };
}
