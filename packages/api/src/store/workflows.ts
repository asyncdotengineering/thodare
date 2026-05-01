/**
 * Postgres-backed workflow store, scoped by `organization_id`.
 *
 * Every read and write requires an organization id; cross-org reads are
 * structurally impossible (queries always include `organization_id = $`).
 *
 * Schema (per-API-instance, lives in `${schema}.workflows`):
 *
 *   id              uuid PK
 *   organization_id text NOT NULL                    -- scopes every row
 *   workflow        jsonb NOT NULL
 *   version         int  NOT NULL DEFAULT 1
 *   created_at      timestamptz NOT NULL DEFAULT now()
 *   updated_at      timestamptz NOT NULL DEFAULT now()
 *   deleted_at      timestamptz NULL                  -- soft-delete; rows kept for audit
 */

import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import type { SerializedWorkflow } from "@thodare/engine";

export interface WorkflowRow {
  id: string;
  organizationId: string;
  workflow: SerializedWorkflow;
  version: number;
}

export type UpdateResult =
  | WorkflowRow
  | { kind: "version_mismatch"; current: number }
  | null;

export interface WorkflowStore {
  init: () => Promise<void>;
  create: (organizationId: string, workflow: SerializedWorkflow) => Promise<WorkflowRow>;
  get: (organizationId: string, id: string) => Promise<WorkflowRow | null>;
  /** Replace the workflow JSON; returns the new version. Optional `expectedVersion` enforces optimistic concurrency. */
  update: (
    organizationId: string,
    id: string,
    workflow: SerializedWorkflow,
    expectedVersion?: number,
  ) => Promise<UpdateResult>;
  remove: (organizationId: string, id: string) => Promise<boolean>;
  /**
   * Get a workflow without an org check — used by webhook ingestion and the
   * scheduler dispatcher, both of which already proved the org via a
   * separate gate (registered webhook route / claimed schedule row). Do NOT
   * expose this to user-driven HTTP routes.
   */
  getInternalUnscoped: (id: string) => Promise<WorkflowRow | null>;
  dispose: () => Promise<void>;
}

const SAFE_SCHEMA = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function createWorkflowStore(opts: {
  pgUrl: string;
  schema: string;
}): WorkflowStore {
  if (!SAFE_SCHEMA.test(opts.schema)) {
    throw new Error(`unsafe schema name: ${opts.schema}`);
  }
  const sql: Sql = postgres(opts.pgUrl, { max: 4 });
  const q = (s: string) => `"${opts.schema}".${s}`;

  return {
    async init() {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${q("workflows")} (
          id              uuid PRIMARY KEY,
          organization_id text NOT NULL,
          workflow        jsonb NOT NULL,
          version         integer NOT NULL DEFAULT 1,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          deleted_at      timestamptz NULL
        )
      `);
      await sql.unsafe(
        `CREATE INDEX IF NOT EXISTS workflows_org_id_idx ON ${q("workflows")} (organization_id) WHERE deleted_at IS NULL`,
      );
    },

    async create(organizationId, workflow) {
      const id = randomUUID();
      await sql.unsafe(
        `INSERT INTO ${q("workflows")} (id, organization_id, workflow, version) VALUES ($1, $2, $3::jsonb, 1)`,
        [id, organizationId, JSON.stringify(workflow)],
      );
      return { id, organizationId, workflow, version: 1 };
    },

    async get(organizationId, id) {
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, workflow, version FROM ${q("workflows")} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [id, organizationId],
      )) as Array<{ id: string; organization_id: string; workflow: string; version: number }>;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        organizationId: row.organization_id,
        workflow: JSON.parse(row.workflow) as SerializedWorkflow,
        version: row.version,
      };
    },

    async update(organizationId, id, workflow, expectedVersion) {
      return await sql.begin(async (tx) => {
        const cur = (await tx.unsafe(
          `SELECT version FROM ${q("workflows")} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [id, organizationId],
        )) as Array<{ version: number }>;
        if (!cur[0]) return null;
        if (expectedVersion !== undefined && cur[0].version !== expectedVersion) {
          return { kind: "version_mismatch", current: cur[0].version } as const;
        }
        const next = cur[0].version + 1;
        await tx.unsafe(
          `UPDATE ${q("workflows")} SET workflow = $3::jsonb, version = $4, updated_at = now() WHERE id = $1 AND organization_id = $2`,
          [id, organizationId, JSON.stringify(workflow), next],
        );
        return { id, organizationId, workflow, version: next };
      });
    },

    async remove(organizationId, id) {
      const r = (await sql.unsafe(
        `UPDATE ${q("workflows")} SET deleted_at = now() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING id`,
        [id, organizationId],
      )) as Array<{ id: string }>;
      return r.length > 0;
    },

    async getInternalUnscoped(id) {
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, workflow, version FROM ${q("workflows")} WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      )) as Array<{ id: string; organization_id: string; workflow: string; version: number }>;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        organizationId: row.organization_id,
        workflow: JSON.parse(row.workflow) as SerializedWorkflow,
        version: row.version,
      };
    },

    async dispose() {
      try { await sql.end({ timeout: 5 }); } catch {}
    },
  };
}
