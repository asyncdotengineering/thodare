/**
 * `thodare login` against the real harness API: full sign-up → org →
 * key flow, plus the sign-in re-login path.
 */

import { afterEach, describe, expect, it } from "vitest";
import { newCliHarness, type CliHarness } from "./_harness.js";

let h: CliHarness;
afterEach(async () => { await h?.dispose(); });

describe("thodare login", () => {
  it("signs up a new user, auto-creates an org, mints a key, saves credentials", async () => {
    h = await newCliHarness();
    h.setPromptResponses(["y"]); // confirm sign-up after sign-in 401
    const code = await h.run([
      "login",
      "--api", h.baseURL,
      "--email", "alice@thodare.test",
      "--password", "abc12345",
    ]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain("Signed up as alice@thodare.test");
    expect(h.stdout()).toMatch(/API key: thd_[A-Za-z0-9]+/);

    const session = await h.credentials.get(h.baseURL);
    expect(session).not.toBeNull();
    expect(session!.userEmail).toBe("alice@thodare.test");
    expect(session!.apiKey).toMatch(/^thd_/);
    expect(session!.organizationId).toBeTruthy();
  });

  it("the minted API key works on /api/workflows", async () => {
    h = await newCliHarness();
    h.setPromptResponses(["y"]);
    await h.run([
      "login",
      "--api", h.baseURL,
      "--email", "bob@thodare.test",
      "--password", "abc12345",
    ]);
    const session = (await h.credentials.get(h.baseURL))!;
    const r = await h.api.app.fetch(new Request(`${h.baseURL}/api/workflows`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.apiKey}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(r.status).toBe(201);
  });

  it("re-login with the same email signs in (does NOT sign up again)", async () => {
    h = await newCliHarness();
    h.setPromptResponses(["y"]);
    await h.run([
      "login", "--api", h.baseURL,
      "--email", "carol@thodare.test", "--password", "abc12345",
    ]);
    const firstKey = (await h.credentials.get(h.baseURL))!.apiKey;
    h.reset();

    // Second login. No prompt should be needed (sign-in succeeds).
    const code = await h.run([
      "login", "--api", h.baseURL,
      "--email", "carol@thodare.test", "--password", "abc12345",
      "--non-interactive",
    ]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain("Signed in as carol@thodare.test");
    const secondKey = (await h.credentials.get(h.baseURL))!.apiKey;
    expect(secondKey).not.toBe(firstKey); // each login mints a fresh key
  });

  it("--non-interactive without all required flags exits 1", async () => {
    h = await newCliHarness();
    const code = await h.run(["login", "--api", h.baseURL, "--non-interactive"]);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("--email and --password are required");
  });
});
