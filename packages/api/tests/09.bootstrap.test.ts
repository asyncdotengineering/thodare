/**
 * C-3: First-run admin bootstrap.
 *
 * The bootstrap mechanism solves the cold-start paradox: a fresh DB
 * has no users, every protected route 401s, and the only way in is
 * a finicky Origin-headered curl chain. With THODARE_BOOTSTRAP=1
 * AND an empty user table, hitting /api/bootstrap?token=<signed>
 * once mints the first admin.
 *
 * Tests boot the API directly (skipping the harness's signup-during-
 * bootstrap step) so we can observe the empty-DB → bootstrap → no
 * longer empty transition.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { createWfkit } from "@thodare/engine";
import { createControlPlaneApi, type ControlPlaneApi } from "../src/index.js";
import { computeBootstrapToken } from "../src/bootstrap.js";

const PG_URL = process.env["WFKIT_DURABLE_PG_URL"] ?? "postgresql://localhost:5432/wfkit_durable_test";
const AUTH_SECRET = "test-secret-thodare-control-plane-not-for-prod-use";
const BASE_URL = "http://test";

interface MiniHarness {
  api: ControlPlaneApi;
  schema: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  dispose: () => Promise<void>;
}

async function bootApi(opts: { bootstrapEnv?: "1" | "" } = {}): Promise<MiniHarness> {
  const schema = `cpa_bs_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const tmp = mkdtempSync(join(tmpdir(), "bs-"));
  const prevEnv = process.env["THODARE_BOOTSTRAP"];
  process.env["THODARE_BOOTSTRAP"] = opts.bootstrapEnv ?? "";
  try {
    const backend = await BackendPostgres.connect(PG_URL, { schema });
    const wfkit = await createWfkit({ backend });
    const api = await createControlPlaneApi({
      pgUrl: PG_URL,
      schema,
      wfkit,
      baseURL: BASE_URL,
      authSecret: AUTH_SECRET,
      rateLimitPerMin: 1000,
    });
    await wfkit.start();
    return {
      api,
      schema,
      fetch: (path, init) => api.app.fetch(new Request(`${BASE_URL}${path}`, init)),
      dispose: async () => {
        try { await api.dispose(); } catch {}
        try { await wfkit.stop(); } catch {}
        try {
          const sql = postgres(PG_URL, { max: 1 });
          try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
          finally { await sql.end({ timeout: 5 }); }
        } catch {}
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
        if (prevEnv === undefined) delete process.env["THODARE_BOOTSTRAP"];
        else process.env["THODARE_BOOTSTRAP"] = prevEnv;
      },
    };
  } catch (e) {
    if (prevEnv === undefined) delete process.env["THODARE_BOOTSTRAP"];
    else process.env["THODARE_BOOTSTRAP"] = prevEnv;
    throw e;
  }
}

let h: MiniHarness;
afterEach(async () => { await h?.dispose(); });

describe("first-run admin bootstrap", () => {
  it("with THODARE_BOOTSTRAP=1 + empty DB: signed link mints admin + returns credentials", async () => {
    h = await bootApi({ bootstrapEnv: "1" });
    const token = computeBootstrapToken(AUTH_SECRET);
    const r = await h.fetch(`/api/bootstrap?token=${token}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      email: string;
      password: string;
      apiKey: string;
      apiKeyPrefix: string;
      organizationId: string;
      organizationSlug: string;
    };
    expect(body.ok).toBe(true);
    expect(body.email).toMatch(/^admin-[a-f0-9]{16}@bootstrap\.thodare\.local$/);
    expect(body.password.length).toBeGreaterThanOrEqual(20);
    expect(body.apiKey).toMatch(/^thd_/);
    expect(body.organizationId).toBeTruthy();
    expect(body.organizationSlug).toBeTruthy();
  });

  it("the minted admin API key works on /api/connectors", async () => {
    h = await bootApi({ bootstrapEnv: "1" });
    const token = computeBootstrapToken(AUTH_SECRET);
    const bs = (await (await h.fetch(`/api/bootstrap?token=${token}`)).json()) as {
      apiKey: string;
    };
    const r = await h.fetch("/api/connectors", {
      headers: { authorization: `Bearer ${bs.apiKey}` },
    });
    expect(r.status).toBe(200);
  });

  it("self-disables: a second call with the same token returns 404 (DB no longer empty)", async () => {
    h = await bootApi({ bootstrapEnv: "1" });
    const token = computeBootstrapToken(AUTH_SECRET);
    const r1 = await h.fetch(`/api/bootstrap?token=${token}`);
    expect(r1.status).toBe(200);

    const r2 = await h.fetch(`/api/bootstrap?token=${token}`);
    expect(r2.status).toBe(404);
  });

  it("wrong token → 401 (correct token format, wrong content)", async () => {
    h = await bootApi({ bootstrapEnv: "1" });
    // Same length as the real token (sha256 hex = 64 chars), but wrong.
    const wrong = "0".repeat(64);
    const r = await h.fetch(`/api/bootstrap?token=${wrong}`);
    expect(r.status).toBe(401);
  });

  it("missing token → 401", async () => {
    h = await bootApi({ bootstrapEnv: "1" });
    const r = await h.fetch(`/api/bootstrap`);
    expect(r.status).toBe(401);
  });

  it("without THODARE_BOOTSTRAP=1: empty DB still 404s the bootstrap route", async () => {
    h = await bootApi({ bootstrapEnv: "" });
    const token = computeBootstrapToken(AUTH_SECRET);
    const r = await h.fetch(`/api/bootstrap?token=${token}`);
    expect(r.status).toBe(404);
  });
});
