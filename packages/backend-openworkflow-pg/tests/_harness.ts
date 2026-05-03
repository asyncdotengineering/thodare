import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { BackendOpenworkflowPg } from "../src/adapter.js";
import type { ThodareBackend } from "@thodare/backend";

const PG_URL =
  process.env["WFKIT_DURABLE_PG_URL"] ??
  "postgresql://localhost:5432/wfkit_durable_test";

export interface Harness {
  backend: ThodareBackend;
  schema: string;
  dispose: () => Promise<void>;
}

export async function newHarness(): Promise<Harness> {
  const schema = `boa_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  const adapter = await BackendOpenworkflowPg.connect({
    pgUrl: PG_URL,
    schema,
  });

  return {
    backend: adapter,
    schema,
    dispose: async () => {
      try {
        await adapter.close();
      } catch {
        /* best-effort */
      }
      try {
        const pg = postgres(PG_URL, { max: 1 });
        await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pg.end({ timeout: 5 });
      } catch {
        /* best-effort */
      }
    },
  };
}
