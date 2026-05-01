/**
 * Credentials store — atomic file writes, multi-API isolation,
 * POSIX 0o600 perms.
 */

import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialsStore } from "../src/credentials.js";

let tmp: string;
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const session = (key: string) => ({
  userId: "u1",
  userEmail: "you@x",
  organizationId: "o1",
  organizationSlug: "org-1",
  apiKey: key,
  apiKeyId: "k1",
  createdAt: "2026-05-02T00:00:00Z",
});

describe("credentials store", () => {
  it("returns null + empty file when no credentials exist", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const cs = createCredentialsStore({ path: join(tmp, "creds.json") });
    expect(await cs.get("http://api")).toBeNull();
    expect(await cs.read()).toEqual({ default: "", sessions: {} });
  });

  it("writes 0o600 on POSIX (no-op on Windows)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const path = join(tmp, "creds.json");
    const cs = createCredentialsStore({ path });
    await cs.put("http://api", session("thd_xx"));
    if (platform() !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("multi-api isolation: writing to api-A doesn't disturb api-B", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const cs = createCredentialsStore({ path: join(tmp, "creds.json") });
    await cs.put("http://a", session("thd_a"));
    await cs.put("http://b", session("thd_b"));
    expect((await cs.get("http://a"))?.apiKey).toBe("thd_a");
    expect((await cs.get("http://b"))?.apiKey).toBe("thd_b");
  });

  it("default is set to the first api put", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const cs = createCredentialsStore({ path: join(tmp, "creds.json") });
    await cs.put("http://a", session("thd_a"));
    await cs.put("http://b", session("thd_b"));
    expect((await cs.read()).default).toBe("http://a");
  });

  it("removes a session and returns true if it existed", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const cs = createCredentialsStore({ path: join(tmp, "creds.json") });
    await cs.put("http://a", session("thd_a"));
    await cs.put("http://b", session("thd_b"));
    expect(await cs.remove("http://a")).toBe(true);
    expect(await cs.get("http://a")).toBeNull();
    expect((await cs.get("http://b"))?.apiKey).toBe("thd_b");
  });

  it("deletes the file when the last session is removed", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const path = join(tmp, "creds.json");
    const cs = createCredentialsStore({ path });
    await cs.put("http://a", session("thd_a"));
    await cs.remove("http://a");
    expect(existsSync(path)).toBe(false);
  });

  it("remove returns false when no entry existed", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cred-"));
    const cs = createCredentialsStore({ path: join(tmp, "creds.json") });
    expect(await cs.remove("http://nope")).toBe(false);
  });
});
