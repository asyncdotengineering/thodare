/**
 * `runCli` dispatch — version, help, unknown commands.
 *
 * Doesn't need the API harness; uses an in-memory credentials store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import { createCredentialsStore } from "../src/credentials.js";
import type { CliDeps } from "../src/deps.js";

let tmp: string;
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function makeDeps(): CliDeps & { _stdout: () => string; _stderr: () => string } {
  let outBuf = "";
  let errBuf = "";
  const stdout = new Writable({ write(chunk, _e, cb) { outBuf += chunk.toString(); cb(); } });
  const stderr = new Writable({ write(chunk, _e, cb) { errBuf += chunk.toString(); cb(); } });
  tmp = mkdtempSync(join(tmpdir(), "cli-run-"));
  return {
    fetch: async () => { throw new Error("not used"); },
    prompt: async () => { throw new Error("not used"); },
    credentials: createCredentialsStore({ path: join(tmp, "c.json") }),
    stdout,
    stderr,
    defaultApi: "http://test",
    now: () => new Date(),
    _stdout: () => outBuf,
    _stderr: () => errBuf,
  };
}

describe("runCli dispatch", () => {
  it("--version prints version and returns 0", async () => {
    const d = makeDeps();
    const code = await runCli(["--version"], d);
    expect(code).toBe(0);
    expect(d._stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help prints help and returns 0", async () => {
    const d = makeDeps();
    const code = await runCli(["--help"], d);
    expect(code).toBe(0);
    expect(d._stdout()).toContain("USAGE");
    expect(d._stdout()).toContain("login");
  });

  it("no args prints help and returns 1", async () => {
    const d = makeDeps();
    const code = await runCli([], d);
    expect(code).toBe(1);
    expect(d._stdout()).toContain("USAGE");
  });

  it("unknown command returns 1 with a useful stderr message", async () => {
    const d = makeDeps();
    const code = await runCli(["nope"], d);
    expect(code).toBe(1);
    expect(d._stderr()).toContain('unknown command "nope"');
  });
});
