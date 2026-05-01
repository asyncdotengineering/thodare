/**
 * `thodare key {create,list,revoke}` against the real API.
 */

import { afterEach, describe, expect, it } from "vitest";
import { newCliHarness, type CliHarness } from "./_harness.js";

let h: CliHarness;
afterEach(async () => { await h?.dispose(); });

async function loggedIn(email = "frank@thodare.test"): Promise<CliHarness> {
  const harness = await newCliHarness();
  harness.setPromptResponses(["y"]);
  await harness.run(["login", "--api", harness.baseURL, "--email", email, "--password", "abc12345"]);
  harness.reset();
  return harness;
}

describe("thodare key", () => {
  it("create mints a key and prints it on stdout", async () => {
    h = await loggedIn();
    const code = await h.run(["key", "create", "--api", h.baseURL, "--name", "ci"]);
    expect(code).toBe(0);
    const out = h.stdout();
    expect(out).toMatch(/thd_[A-Za-z0-9]+/);
  });

  it("created key works on a subsequent /api/workflows call", async () => {
    h = await loggedIn();
    await h.run(["key", "create", "--api", h.baseURL, "--name", "deploy"]);
    const out = h.stdout();
    const newKey = out.match(/thd_[A-Za-z0-9]+/)?.[0];
    expect(newKey).toBeTruthy();
    const r = await h.api.app.fetch(new Request(`${h.baseURL}/api/workflows`, {
      method: "POST",
      headers: { authorization: `Bearer ${newKey}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(r.status).toBe(201);
  });

  it("list returns at least the login-issued key", async () => {
    h = await loggedIn();
    const code = await h.run(["key", "list", "--api", h.baseURL]);
    expect(code).toBe(0);
    expect(h.stdout()).not.toBe("");
  });

  it("revoke removes a key by id; subsequent use returns 401", async () => {
    h = await loggedIn();
    // Capture the new key's id from the JSON-mode output of `create`
    // (stdout in tests is not a TTY → JSON).
    await h.run(["key", "create", "--api", h.baseURL, "--name", "to-revoke"]);
    const createOut = h.stdout();
    const created = JSON.parse(createOut.trim()) as { id: string; key: string; name: string };
    expect(created.id).toBeTruthy();
    h.reset();

    const code = await h.run(["key", "revoke", created.id, "--api", h.baseURL]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain(`Revoked ${created.id}`);

    // The revoked key should no longer authenticate against the API.
    const r = await h.api.app.fetch(new Request(`${h.baseURL}/api/workflows`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(r.status).toBe(401);
  });

  it("revoke without an id exits 1", async () => {
    h = await loggedIn();
    const code = await h.run(["key", "revoke", "--api", h.baseURL]);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("missing <key-id>");
  });
});
