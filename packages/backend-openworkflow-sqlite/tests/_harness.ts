import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendOpenworkflowSqlite } from "../src/adapter.js";
import type { ThodareBackend } from "@thodare/backend";

export interface Harness {
  backend: ThodareBackend;
  dispose: () => Promise<void>;
}

export async function newHarness(): Promise<Harness> {
  // Use a temp directory for file-based SQLite so that multiple connections
  // (events, openworkflow, and read) all access the same database.
  const dir = mkdtempSync(join(tmpdir(), "boa-sqlite-"));
  const dbPath = join(dir, "thodare.db");

  const adapter = BackendOpenworkflowSqlite.connect({
    path: dbPath,
  });

  return {
    backend: adapter,
    dispose: async () => {
      try {
        await adapter.close();
      } catch {
        /* best-effort */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
