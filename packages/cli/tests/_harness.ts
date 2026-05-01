/**
 * Test harness — wires real `@thodare/api` (booted on a per-test schema)
 * with an in-memory credentials store and the CLI's `runCli`.
 *
 * Tests run end-to-end through the CLI surface: argv → parseArgv →
 * command → fetch → real Postgres-backed API. No internal mocks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import postgres from "postgres";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { createWfkit, type Wfkit } from "@thodare/engine";
import { createControlPlaneApi, type ControlPlaneApi } from "@thodare/api";
import { runCli } from "../src/run.js";
import { createCredentialsStore, type CredentialsStore } from "../src/credentials.js";
import type { CliDeps } from "../src/deps.js";

const PG_URL = process.env["WFKIT_DURABLE_PG_URL"] ?? "postgresql://localhost:5432/wfkit_durable_test";

export interface CliHarness {
  api: ControlPlaneApi;
  baseURL: string;
  wfkit: Wfkit;
  credentials: CredentialsStore;
  credentialsPath: string;
  /** Capture stdout/stderr written by the CLI. */
  stdout: () => string;
  stderr: () => string;
  /** Drain captured streams. */
  reset: () => void;
  /** Fixed list of replies the CLI's prompt() should return, in order. */
  setPromptResponses: (replies: string[]) => void;
  /** Run `thodare <argv>` against the harness. */
  run: (argv: string[]) => Promise<number>;
  dispose: () => Promise<void>;
}

const tmpDirs: string[] = [];

export async function newCliHarness(): Promise<CliHarness> {
  const schema = `cli_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const tmp = mkdtempSync(join(tmpdir(), "thd-cli-"));
  tmpDirs.push(tmp);
  const credentialsPath = join(tmp, "credentials.json");

  const baseURL = "http://test";

  const backend = await BackendPostgres.connect(PG_URL, { schema });
  const wfkit = await createWfkit({ backend });

  const api = await createControlPlaneApi({
    pgUrl: PG_URL,
    schema,
    wfkit,
    baseURL,
    authSecret: "test-secret-thodare-control-plane-not-for-prod-use",
    rateLimitPerMin: 10000,
  });
  await wfkit.start();

  // Capture buffers.
  let stdoutBuf = "";
  let stderrBuf = "";
  const stdout = new Writable({ write(chunk, _enc, cb) { stdoutBuf += chunk.toString(); cb(); } });
  const stderr = new Writable({ write(chunk, _enc, cb) { stderrBuf += chunk.toString(); cb(); } });

  // Prompt queue.
  let replies: string[] = [];
  const prompt: CliDeps["prompt"] = async () => {
    const r = replies.shift();
    if (r === undefined) throw new Error("harness: prompt called with no queued reply");
    return r;
  };

  const credentials = createCredentialsStore({ path: credentialsPath });

  // Route CLI's fetch into the in-process Hono app. Both URLs we use start
  // with `baseURL`; replace with a Request the Hono fetch handler accepts.
  const cliFetch: typeof fetch = async (input, init) => {
    const reqUrl = typeof input === "string" ? input : (input as Request).url;
    if (!reqUrl.startsWith(baseURL)) {
      throw new Error(`harness: unexpected fetch to ${reqUrl}`);
    }
    return api.app.fetch(new Request(reqUrl, init as RequestInit));
  };

  const deps: CliDeps = {
    fetch: cliFetch,
    prompt,
    credentials,
    stdout,
    stderr,
    defaultApi: baseURL,
    now: () => new Date("2026-05-02T00:00:00Z"),
  };

  return {
    api,
    baseURL,
    wfkit,
    credentials,
    credentialsPath,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    reset: () => {
      stdoutBuf = "";
      stderrBuf = "";
    },
    setPromptResponses: (r) => { replies = [...r]; },
    run: (argv) => runCli(argv, deps),
    dispose: async () => {
      try { await api.dispose(); } catch {}
      try { await wfkit.stop(); } catch {}
      try {
        const sql = postgres(PG_URL, { max: 1 });
        try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await sql.end({ timeout: 5 }); }
      } catch {}
    },
  };
}

export function cleanupTmp(): void {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
}
