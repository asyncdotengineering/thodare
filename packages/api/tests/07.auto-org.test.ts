/**
 * C-1: auto-create personal organization on user signup.
 *
 * The databaseHook fires at user-create time and inserts an organization
 * + member row. By the time the session token comes back from
 * `/api/auth/sign-up/email`, the user already has a personal org and
 * (per the org plugin's setActiveOrganizationOnSessionCreate default)
 * the session has its activeOrganizationId set.
 */

import { afterEach, describe, expect, it } from "vitest";
import { newApiHarness, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

describe("auto-create personal org on signup", () => {
  it("a freshly-signed-up user has exactly one organization", async () => {
    h = await newApiHarness();
    // The harness already calls signUp during bootstrap. List orgs.
    const r = await h.fetch("/api/auth/organization/list", {
      method: "GET",
      headers: { origin: h.baseURL, cookie: await sessionCookie(h) },
    });
    expect(r.status).toBe(200);
    const orgs = (await r.json()) as Array<{ id: string; slug: string; name: string }>;
    expect(Array.isArray(orgs)).toBe(true);
    expect(orgs.length).toBe(1);
    expect(orgs[0]?.slug).toMatch(/^[a-z0-9-]+$/);
    expect(orgs[0]?.name).toContain("workspace");
  });

  it("the auto-created org is set as active on the user's session", async () => {
    h = await newApiHarness();
    // The API key in h.token is owned by the auto-created org; if the
    // session weren't active, key minting would have failed and the
    // harness would have thrown during bootstrap.
    expect(h.token).toMatch(/^thd_/);
    expect(h.organizationId).toBeTruthy();

    // Hit a protected route to confirm.
    const r = await h.fetch("/api/connectors", {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(r.status).toBe(200);
  });

  it("two users get two distinct personal orgs", async () => {
    h = await newApiHarness();
    const other = await h.createOtherTenant();
    expect(other.organizationId).not.toBe(h.organizationId);
  });

  it("API key from user A cannot read workflows from user B", async () => {
    h = await newApiHarness();
    const other = await h.createOtherTenant();
    // Each user has their own personal org. Cross-org reads → 404.
    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };

    const probe = await h.fetch(`/api/workflows/${created.id}`, {
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(probe.status).toBe(404);
  });
});

/**
 * Sign in to grab a fresh session cookie for org-listing. The harness's
 * stored cookie comes from sign-up; for this test we re-sign-in with
 * the same credentials to confirm the org is still findable.
 */
async function sessionCookie(h: ApiHarness): Promise<string> {
  const r = await h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: h.baseURL },
    body: JSON.stringify({ email: h.userEmail, password: "test-password-1234" }),
  });
  if (!r.ok) throw new Error(`sign-in failed in test: ${r.status}`);
  const setCookie = r.headers.get("set-cookie") ?? "";
  return setCookie.split(",").map((s) => s.split(";")[0]!.trim()).filter(Boolean).join("; ");
}
