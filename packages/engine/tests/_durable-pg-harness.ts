import { OpenWorkflow } from "@thodare/openworkflow";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { randomUUID } from "node:crypto";

/**
 * Postgres-backed test harness. Each harness gets its own schema so concurrent
 * tests don't collide and we don't have to drop/recreate a database. The
 * schema is dropped on dispose.
 *
 * Connection: defaults to the local DB created at the workspace root:
 *   createdb wfkit_durable_test
 * Override with WFKIT_DURABLE_PG_URL if you have a different setup.
 */

const DEFAULT_URL =
  process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test";

export interface PgDurableHarness {
  ow: OpenWorkflow;
  backend: BackendPostgres;
  schema: string;
  startWorker: (concurrency?: number) => Promise<void>;
  restartWorker: (concurrency?: number) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function newPgDurableHarness(
  url: string = DEFAULT_URL,
): Promise<PgDurableHarness> {
  // openworkflow requires a valid Postgres identifier for schema names. We
  // generate a per-harness schema like `wfkit_t_<short-uuid>`; uppercase
  // letters and dashes from randomUUID() get stripped.
  const schema = `wfkit_t_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const backend = await BackendPostgres.connect(url, { schema });
  const ow = new OpenWorkflow({ backend });

  let worker: { start(): Promise<void>; stop(): Promise<void> } | null = null;

  // Defer importing `postgres` until dispose-time so we only pay the cost on
  // the cleanup path. We open a side-channel client to drop the test schema.
  const dropSchema = async (): Promise<void> => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  return {
    ow,
    backend,
    schema,
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
      try { await dropSchema(); } catch (e) {
        // best-effort; schema cleanup failure shouldn't fail the test
        // eslint-disable-next-line no-console
        console.warn(`[pg-harness] failed to drop schema ${schema}:`, e);
      }
    },
  };
}
