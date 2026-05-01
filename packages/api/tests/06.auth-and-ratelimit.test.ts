/**
 * Auth + rate-limit + cross-tenant isolation contract.
 *
 *   - /health bypasses BOTH auth and rate-limit.
 *   - Missing / malformed Authorization → 401.
 *   - Unknown / revoked API key → 401.
 *   - Valid API key → request proceeds (org resolved from the key).
 *   - Rate-limit is per (organizationId, principal). Two tenants have
 *     independent buckets — one cannot starve the other.
 *   - 429 carries `retryAfterMs ∈ (0, 60_000]`.
 *   - A workflow owned by tenant A is invisible to tenant B (404, not 401).
 */

import { afterEach, describe, expect, it } from "vitest";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

describe("auth (better-auth + apiKey)", () => {
  it("/health bypasses auth — no token required", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
  });

  it("missing Authorization header → 401 on protected routes", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("malformed Authorization (no Bearer prefix) → 401", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { authorization: h.token, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  it("unknown API key → 401", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { ...withAuth("thd_completely_fake_key_does_not_exist"), "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  it("valid API key → request proceeds (201 from workflows.create)", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(201);
  });

  it("API key carried via x-api-key header is accepted (not just Bearer)", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { "x-api-key": h.token, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(201);
  });
});

describe("rate-limit (per-(org, principal), token-bucket)", () => {
  it("/health bypasses rate-limit", async () => {
    h = await newApiHarness({ rateLimitPerMin: 2 });
    for (let i = 0; i < 10; i++) {
      const r = await h.fetch("/health");
      expect(r.status).toBe(200);
    }
  });

  it("(N+1)-th request from one principal in a minute → 429 with retryAfterMs", async () => {
    h = await newApiHarness({ rateLimitPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
        headers: withAuth(h.token),
      });
      codes.push(r.status);
      if (i === 3) {
        expect(r.status).toBe(429);
        const body = (await r.json()) as { error: string; retryAfterMs: number };
        expect(body.error).toBe("rate_limited");
        expect(body.retryAfterMs).toBeGreaterThan(0);
        expect(body.retryAfterMs).toBeLessThanOrEqual(60_000);
      }
    }
    expect(codes.slice(0, 3).every((c) => c === 404)).toBe(true);
    expect(codes[3]).toBe(429);
  });

  it("buckets are per-(org, principal) — one tenant cannot starve another", async () => {
    h = await newApiHarness({ rateLimitPerMin: 2 });
    const other = await h.createOtherTenant();

    for (let i = 0; i < 2; i++) {
      const r = await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
        headers: withAuth(h.token),
      });
      expect(r.status).toBe(404);
    }
    const aThrottled = await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
      headers: withAuth(h.token),
    });
    expect(aThrottled.status).toBe(429);

    for (let i = 0; i < 2; i++) {
      const r = await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
        headers: withAuth(other.token),
      });
      expect(r.status).toBe(404);
    }
  });

  it("continuous refill — short wait restores capacity proportionally", async () => {
    h = await newApiHarness({ rateLimitPerMin: 60 });
    for (let i = 0; i < 60; i++) {
      await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
        headers: withAuth(h.token),
      });
    }
    const throttled = await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
      headers: withAuth(h.token),
    });
    expect(throttled.status).toBe(429);
    await new Promise((r) => setTimeout(r, 2_100));
    const recovered = await h.fetch("/api/workflows/00000000-0000-0000-0000-000000000000", {
      headers: withAuth(h.token),
    });
    expect(recovered.status).toBe(404);
  });
});

describe("organization scoping (cross-tenant isolation)", () => {
  it("a workflow created by tenant A is invisible to tenant B (404, not 401)", async () => {
    h = await newApiHarness();
    const other = await h.createOtherTenant();

    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };

    const probe = await h.fetch(`/api/workflows/${created.id}`, {
      headers: withAuth(other.token),
    });
    expect(probe.status).toBe(404);

    const del = await h.fetch(`/api/workflows/${created.id}`, {
      method: "DELETE",
      headers: withAuth(other.token),
    });
    expect(del.status).toBe(404);

    const ownProbe = await h.fetch(`/api/workflows/${created.id}`, {
      headers: withAuth(h.token),
    });
    expect(ownProbe.status).toBe(200);
  });
});
