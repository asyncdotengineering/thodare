/**
 * `thodare token`, `env`, `whoami`, `logout`. All read the credentials
 * file written by `login`; we go through `login` once per test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { newCliHarness, type CliHarness } from "./_harness.js";

let h: CliHarness;
afterEach(async () => { await h?.dispose(); });

async function bootstrappedHarness(email = "dee@thodare.test"): Promise<CliHarness> {
  const harness = await newCliHarness();
  harness.setPromptResponses(["y"]);
  await harness.run(["login", "--api", harness.baseURL, "--email", email, "--password", "abc12345"]);
  harness.reset();
  return harness;
}

describe("thodare token / env / whoami / logout", () => {
  it("token prints the api key on stdout and exits 0", async () => {
    h = await bootstrappedHarness();
    const code = await h.run(["token", "--api", h.baseURL]);
    expect(code).toBe(0);
    expect(h.stdout().trim()).toMatch(/^thd_[A-Za-z0-9]+$/);
  });

  it("token without credentials exits 1 with a useful stderr message", async () => {
    h = await newCliHarness();
    const code = await h.run(["token", "--api", h.baseURL]);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("no credentials");
    expect(h.stderr()).toContain("thodare login");
  });

  it("env --shell sh prints sh exports", async () => {
    h = await bootstrappedHarness();
    const code = await h.run(["env", "--api", h.baseURL]);
    expect(code).toBe(0);
    const out = h.stdout();
    expect(out).toContain("export THODARE_API_KEY=");
    expect(out).toContain(`export THODARE_API=${h.baseURL}`);
  });

  it("env --shell fish prints fish exports", async () => {
    h = await bootstrappedHarness();
    const code = await h.run(["env", "--api", h.baseURL, "--shell", "fish"]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain("set -x THODARE_API_KEY");
    expect(h.stdout()).toContain(`set -x THODARE_API ${h.baseURL}`);
  });

  it("env --shell powershell prints PowerShell exports", async () => {
    h = await bootstrappedHarness();
    const code = await h.run(["env", "--api", h.baseURL, "--shell", "powershell"]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain("$Env:THODARE_API_KEY");
    expect(h.stdout()).toContain("$Env:THODARE_API");
  });

  it("whoami prints email + org slug + api", async () => {
    h = await bootstrappedHarness("eve@thodare.test");
    const code = await h.run(["whoami", "--api", h.baseURL]);
    expect(code).toBe(0);
    const out = h.stdout();
    expect(out).toContain("eve@thodare.test");
    expect(out).toContain("org:");
    expect(out).toContain(`api: ${h.baseURL}`);
  });

  it("logout removes credentials for the active api", async () => {
    h = await bootstrappedHarness();
    expect(await h.credentials.get(h.baseURL)).not.toBeNull();
    const code = await h.run(["logout", "--api", h.baseURL]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain("Removed credentials");
    expect(await h.credentials.get(h.baseURL)).toBeNull();
  });

  it("logout exits 1 when no credentials existed", async () => {
    h = await newCliHarness();
    const code = await h.run(["logout", "--api", h.baseURL]);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("No credentials found");
  });
});
