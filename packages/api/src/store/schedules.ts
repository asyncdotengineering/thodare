/**
 * Postgres schedule store, scoped by `organization_id`. Holds
 * cron-scheduled workflow triggers.
 *
 *   id              text PK              -- "sch_<rand>"
 *   organization_id text NOT NULL        -- scopes every row
 *   workflow_id     uuid NOT NULL        -- foreign-key-shape; not enforced
 *   cron            text NOT NULL        -- 5-field minute-resolution cron
 *   payload         jsonb NULL
 *   end_at          timestamptz NULL
 *   last_fired_at   timestamptz NULL     -- atomic claim marker
 *   created_at      timestamptz NOT NULL DEFAULT now()
 *
 * Multi-process tickers: `claimDue(cutoffIso)` uses
 * `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction, sets
 * `last_fired_at = cutoff` for the rows it claims, and returns them.
 * Concurrent tickers see different rows or skip rows already locked,
 * so a schedule fires exactly once per cutoff regardless of how many
 * tickers race.
 */

import postgres, { type Sql } from "postgres";
import { newScheduleId } from "@thodare/engine";

const SAFE_SCHEMA = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export interface ScheduleRow {
  id: string;
  organizationId: string;
  workflowId: string;
  cron: string;
  payload?: unknown;
  endAt?: string;
  lastFiredAt?: string;
}

export interface ScheduleStore {
  init: () => Promise<void>;
  create: (
    organizationId: string,
    input: { id?: string; workflowId: string; cron: string; payload?: unknown; endAt?: string },
  ) => Promise<ScheduleRow>;
  list: (organizationId: string) => Promise<ScheduleRow[]>;
  remove: (organizationId: string, id: string) => Promise<boolean>;
  /** Tick reads ALL schedules across all orgs for dispatch. */
  listAll: () => Promise<ScheduleRow[]>;
  /**
   * Atomic per-(scheduleId, cutoff) claim. Returns true iff THIS caller
   * is the first to claim the given cutoff for this schedule. Concurrent
   * tickers (same process or different processes) hitting the same
   * `(scheduleId, cutoffIso)` get exactly one `true` and the rest `false`.
   *
   * Uses `SELECT … FOR UPDATE` inside a tiny transaction. The lock is
   * held only across the SELECT + UPDATE — dispatch happens outside.
   */
  tryClaim: (scheduleId: string, cutoffIso: string) => Promise<boolean>;
  dispose: () => Promise<void>;
}

export function createScheduleStore(opts: { pgUrl: string; schema: string }): ScheduleStore {
  if (!SAFE_SCHEMA.test(opts.schema)) {
    throw new Error(`unsafe schema name: ${opts.schema}`);
  }
  const sql: Sql = postgres(opts.pgUrl, { max: 4 });
  const q = (s: string) => `"${opts.schema}".${s}`;

  const fromRow = (r: {
    id: string;
    organization_id: string;
    workflow_id: string;
    cron: string;
    payload: string | null;
    end_at: string | null;
    last_fired_at?: string | null;
  }): ScheduleRow => {
    const out: ScheduleRow = {
      id: r.id,
      organizationId: r.organization_id,
      workflowId: r.workflow_id,
      cron: r.cron,
    };
    if (r.payload !== null) out.payload = JSON.parse(r.payload);
    if (r.end_at !== null) out.endAt = r.end_at;
    if (r.last_fired_at) out.lastFiredAt = r.last_fired_at;
    return out;
  };

  return {
    async init() {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${q("schedules")} (
          id              text PRIMARY KEY,
          organization_id text NOT NULL,
          workflow_id     uuid NOT NULL,
          cron            text NOT NULL,
          payload         jsonb NULL,
          end_at          timestamptz NULL,
          last_fired_at   timestamptz NULL,
          created_at      timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Migration for existing deployments: add the column if missing.
      await sql.unsafe(
        `ALTER TABLE ${q("schedules")} ADD COLUMN IF NOT EXISTS last_fired_at timestamptz NULL`,
      );
      await sql.unsafe(
        `CREATE INDEX IF NOT EXISTS schedules_org_id_idx ON ${q("schedules")} (organization_id)`,
      );
      await sql.unsafe(
        `CREATE INDEX IF NOT EXISTS schedules_last_fired_at_idx ON ${q("schedules")} (last_fired_at NULLS FIRST)`,
      );
    },

    async create(organizationId, input) {
      const id = input.id ?? newScheduleId();
      await sql.unsafe(
        `INSERT INTO ${q("schedules")} (id, organization_id, workflow_id, cron, payload, end_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          id,
          organizationId,
          input.workflowId,
          input.cron,
          input.payload === undefined ? null : JSON.stringify(input.payload),
          input.endAt ?? null,
        ],
      );
      return {
        id,
        organizationId,
        workflowId: input.workflowId,
        cron: input.cron,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
      };
    },

    async list(organizationId) {
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, workflow_id, cron, payload, end_at, last_fired_at FROM ${q("schedules")} WHERE organization_id = $1 ORDER BY created_at`,
        [organizationId],
      )) as Array<{ id: string; organization_id: string; workflow_id: string; cron: string; payload: string | null; end_at: string | null; last_fired_at: string | null }>;
      return rows.map(fromRow);
    },

    async remove(organizationId, id) {
      const r = (await sql.unsafe(
        `DELETE FROM ${q("schedules")} WHERE id = $1 AND organization_id = $2 RETURNING id`,
        [id, organizationId],
      )) as Array<{ id: string }>;
      return r.length > 0;
    },

    async listAll() {
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, workflow_id, cron, payload, end_at, last_fired_at FROM ${q("schedules")} ORDER BY created_at`,
      )) as Array<{ id: string; organization_id: string; workflow_id: string; cron: string; payload: string | null; end_at: string | null; last_fired_at: string | null }>;
      return rows.map(fromRow);
    },

    async tryClaim(scheduleId, cutoffIso) {
      // Atomic claim: lock the row, check whether `last_fired_at` is
      // already at or past `cutoffIso`, and if not, advance it. The
      // lock is held for the duration of this transaction — typically
      // sub-millisecond — and serializes only against other tickers
      // racing on the same row.
      //
      // Returns true only on the caller that successfully advanced
      // `last_fired_at`. All other concurrent callers (same cutoff,
      // same scheduleId) get false.
      try {
        return await sql.begin(async (tx) => {
          const rows = (await tx.unsafe(
            `SELECT last_fired_at FROM ${q("schedules")} WHERE id = $1 FOR UPDATE`,
            [scheduleId],
          )) as Array<{ last_fired_at: string | null }>;
          if (rows.length === 0) return false;

          const lastFired = rows[0]!.last_fired_at;
          if (lastFired !== null && new Date(lastFired).getTime() >= new Date(cutoffIso).getTime()) {
            // Someone already fired this cutoff (or a later one).
            return false;
          }

          await tx.unsafe(
            `UPDATE ${q("schedules")} SET last_fired_at = $1 WHERE id = $2`,
            [cutoffIso, scheduleId],
          );
          return true;
        });
      } catch {
        return false;
      }
    },

    async dispose() {
      try { await sql.end({ timeout: 5 }); } catch {}
    },
  };
}
