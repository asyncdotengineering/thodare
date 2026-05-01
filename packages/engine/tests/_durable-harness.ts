import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenWorkflow } from "@thodare/openworkflow";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";

/**
 * Test harness for the durable runtime. Each test gets its own SQLite file.
 * IMPORTANT: openworkflow's `newWorker()` SNAPSHOTS the registry; define your
 * workflows BEFORE calling `startWorker()`.
 */
export interface DurableHarness {
  ow: OpenWorkflow;
  backend: BackendSqlite;
  startWorker: (concurrency?: number) => Promise<void>;
  restartWorker: (concurrency?: number) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function newDurableHarness(): Promise<DurableHarness> {
  const dir = mkdtempSync(join(tmpdir(), "wfkit-d-"));
  const dbPath = join(dir, "ow.sqlite");
  const backend = BackendSqlite.connect(dbPath);
  const ow = new OpenWorkflow({ backend });
  let worker: { start(): Promise<void>; stop(): Promise<void> } | null = null;

  return {
    ow,
    backend,
    startWorker: async (concurrency = 4) => {
      if (worker) throw new Error("worker already started");
      worker = ow.newWorker({ concurrency });
      await worker.start();
    },
    restartWorker: async (concurrency = 4) => {
      if (worker) {
        try { await worker.stop(); } catch {}
      }
      worker = ow.newWorker({ concurrency });
      await worker.start();
    },
    dispose: async () => {
      try { if (worker) await worker.stop(); } catch {}
      try { await backend.stop(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
