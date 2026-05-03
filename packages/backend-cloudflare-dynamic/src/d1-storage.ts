import type {
  Storage,
  EventInput,
  EventResult,
  Event,
  EventListFilter,
  Run,
  RunListFilter,
  Step,
  Hook,
  HookListFilter,
  RunId,
  StepId,
  EventId,
  HookId,
} from "@thodare/backend";

function makeId(): string {
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

// ── DDL (idempotent) ──

const EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    run_id TEXT NOT NULL,
    step_id TEXT,
    payload TEXT NOT NULL,
    correlation_id TEXT,
    organization_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;

const RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    spec_version INTEGER NOT NULL,
    idempotency_key TEXT,
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failed_at TEXT,
    UNIQUE (organization_id, workflow_name, idempotency_key)
  )
`;

const STEPS_DDL = `
  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    input TEXT,
    output TEXT,
    error TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    failed_at TEXT
  )
`;

const HOOKS_DDL = `
  CREATE TABLE IF NOT EXISTS hooks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    expired_at TEXT
  )
`;

// ── Row converters ──

function rowToEvent(row: Record<string, unknown>): Event {
  const payloadRaw = row["payload"];
  const jsonPayload =
    typeof payloadRaw === "string"
      ? (JSON.parse(payloadRaw) as Record<string, unknown>)
      : (payloadRaw as Record<string, unknown>);
  const r = {
    id: row["id"] as EventId,
    type: row["type"] as Event["type"],
    runId: row["run_id"] as string,
    payload: jsonPayload as Event["payload"],
    createdAt: row["created_at"] as string,
  } as unknown as Record<string, unknown>;
  if (row["step_id"] !== null && row["step_id"] !== undefined) {
    r["stepId"] = row["step_id"];
  }
  if (row["correlation_id"] !== null && row["correlation_id"] !== undefined) {
    r["correlationId"] = row["correlation_id"];
  }
  if (row["organization_id"] !== null && row["organization_id"] !== undefined) {
    r["organizationId"] = row["organization_id"];
  }
  return r as unknown as Event;
}

function rowToRun(row: Record<string, unknown>): Run {
  const result: Run = {
    id: row["id"] as RunId,
    workflowName: row["workflow_name"] as string,
    organizationId: row["organization_id"] as string,
    input: tryParseJson(row["input"] as string),
    status: row["status"] as Run["status"],
    startedAt: row["started_at"] as string,
  };
  if (row["output"] !== null && row["output"] !== undefined) {
    result.output = tryParseJson(row["output"] as string);
  }
  if (row["error"] !== null && row["error"] !== undefined) {
    result.error = row["error"] as string;
  }
  if (row["completed_at"] !== null && row["completed_at"] !== undefined) {
    result.completedAt = row["completed_at"] as string;
  }
  if (row["failed_at"] !== null && row["failed_at"] !== undefined) {
    result.failedAt = row["failed_at"] as string;
  }
  return result;
}

function rowToStep(row: Record<string, unknown>): Step {
  const result: Step = {
    id: row["id"] as StepId,
    runId: row["run_id"] as RunId,
    name: row["name"] as string,
    status: row["status"] as Step["status"],
    startedAt: row["started_at"] as string,
  };
  if (row["input"] !== null && row["input"] !== undefined) {
    result.input = tryParseJson(row["input"] as string);
  }
  if (row["output"] !== null && row["output"] !== undefined) {
    result.output = tryParseJson(row["output"] as string);
  }
  if (row["error"] !== null && row["error"] !== undefined) {
    result.error = row["error"] as string;
  }
  if (row["completed_at"] !== null && row["completed_at"] !== undefined) {
    result.completedAt = row["completed_at"] as string;
  }
  if (row["failed_at"] !== null && row["failed_at"] !== undefined) {
    result.failedAt = row["failed_at"] as string;
  }
  return result;
}

function tryParseJson(v: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

// ── D1Storage class ──

export class D1Storage implements Storage {
  private readonly db: D1Database;
  private readonly orgId: string;

  readonly events;
  readonly runs;
  readonly steps;
  readonly hooks;

  constructor(db: D1Database, organizationId: string) {
    this.db = db;
    this.orgId = organizationId;

    const s = this;

    // ── Events ──
    this.events = {
      create: async (input: EventInput): Promise<EventResult> => {
        const eid = makeId();
        const createdAt = isoNow();
        const organizationId = input.organizationId ?? s.orgId;
        const payloadJson = JSON.stringify(input.payload);

        const stmt = s.db
          .prepare(
            `INSERT INTO events (id, type, run_id, step_id, payload, correlation_id, organization_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          )
          .bind(
            eid,
            input.type,
            input.runId,
            input.stepId ?? null,
            payloadJson,
            input.correlationId ?? null,
            organizationId,
            createdAt,
          );

        await stmt.run();

        const event: Event = {
          id: eid as EventId,
          type: input.type,
          runId: input.runId,
          payload: input.payload,
          createdAt,
        };
        const eventObj = event as unknown as Record<string, unknown>;
        if (input.stepId !== undefined) {
          eventObj["stepId"] = input.stepId;
        }
        if (input.correlationId !== undefined) {
          eventObj["correlationId"] = input.correlationId;
        }
        eventObj["organizationId"] = organizationId;
        return { event };
      },

      get: async (eventId: EventId): Promise<Event | null> => {
        const result = await s.db
          .prepare(
            `SELECT * FROM events WHERE organization_id = ?1 AND id = ?2 LIMIT 1`,
          )
          .bind(s.orgId, eventId as string)
          .first<Record<string, unknown>>();

        return result ? rowToEvent(result) : null;
      },

      list: async (filter: EventListFilter): Promise<Event[]> => {
        let sql = `SELECT * FROM events WHERE organization_id = ?1`;
        const params: unknown[] = [s.orgId];
        let paramIdx = 2;

        if (filter.runId !== undefined) {
          sql += ` AND run_id = ?${paramIdx}`;
          params.push(filter.runId);
          paramIdx++;
        }
        if (filter.type !== undefined) {
          sql += ` AND type = ?${paramIdx}`;
          params.push(filter.type);
          paramIdx++;
        }
        sql += ` ORDER BY created_at ASC`;
        sql += ` LIMIT ?${paramIdx} OFFSET ?${paramIdx + 1}`;
        params.push(filter.limit ?? 100, filter.offset ?? 0);

        const stmt = s.db.prepare(sql).bind(...params);
        const result = await stmt.all<Record<string, unknown>>();

        if (!result.results) return [];
        return result.results.map(rowToEvent);
      },

      listByCorrelationId: async (
        correlationId: string,
      ): Promise<Event[]> => {
        const result = await s.db
          .prepare(
            `SELECT * FROM events
             WHERE organization_id = ?1 AND correlation_id = ?2
             ORDER BY created_at ASC`,
          )
          .bind(s.orgId, correlationId)
          .all<Record<string, unknown>>();

        if (!result.results) return [];
        return result.results.map(rowToEvent);
      },
    };

    // ── Runs ──
    this.runs = {
      get: async (runId: RunId): Promise<Run | null> => {
        const result = await s.db
          .prepare(
            `SELECT * FROM runs WHERE organization_id = ?1 AND id = ?2 LIMIT 1`,
          )
          .bind(s.orgId, runId as string)
          .first<Record<string, unknown>>();

        return result ? rowToRun(result) : null;
      },

      list: async (filter: RunListFilter): Promise<Run[]> => {
        let sql = `SELECT * FROM runs WHERE organization_id = ?1`;
        const params: unknown[] = [s.orgId];
        let paramIdx = 2;

        if (filter.workflowName !== undefined) {
          sql += ` AND workflow_name = ?${paramIdx}`;
          params.push(filter.workflowName);
          paramIdx++;
        }
        if (filter.status !== undefined) {
          sql += ` AND status = ?${paramIdx}`;
          params.push(filter.status);
          paramIdx++;
        }
        sql += ` ORDER BY started_at DESC`;
        sql += ` LIMIT ?${paramIdx} OFFSET ?${paramIdx + 1}`;
        params.push(filter.limit ?? 100, filter.offset ?? 0);

        const stmt = s.db.prepare(sql).bind(...params);
        const result = await stmt.all<Record<string, unknown>>();

        if (!result.results) return [];
        return result.results.map(rowToRun);
      },
    };

    // ── Steps ──
    this.steps = {
      get: async (stepId: StepId): Promise<Step | null> => {
        const result = await s.db
          .prepare(
            `SELECT * FROM steps WHERE organization_id = ?1 AND id = ?2 LIMIT 1`,
          )
          .bind(s.orgId, stepId as string)
          .first<Record<string, unknown>>();

        return result ? rowToStep(result) : null;
      },

      list: async (runId: RunId): Promise<Step[]> => {
        const result = await s.db
          .prepare(
            `SELECT * FROM steps
             WHERE organization_id = ?1 AND run_id = ?2
             ORDER BY started_at ASC`,
          )
          .bind(s.orgId, runId as string)
          .all<Record<string, unknown>>();

        if (!result.results) return [];
        return result.results.map(rowToStep);
      },
    };

    // ── Hooks (stubbed for v1 alpha; column exists for forward-compat) ──
    this.hooks = {
      get: async (_hookId: HookId): Promise<Hook | null> => {
        return null;
      },

      getByToken: async (_token: string): Promise<Hook | null> => {
        return null;
      },

      list: async (_filter: HookListFilter): Promise<Hook[]> => {
        return [];
      },
    };
  }

  async applyDDL(): Promise<void> {
    for (const ddl of [EVENTS_DDL, RUNS_DDL, STEPS_DDL, HOOKS_DDL]) {
      await this.db.prepare(ddl).run();
    }
  }

  async insertRun(row: {
    id: string;
    workflowName: string;
    organizationId: string;
    specVersion: number;
    idempotencyKey: string | null;
    input: unknown;
    status: Run["status"];
    startedAt: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runs (id, workflow_name, organization_id, spec_version, idempotency_key, input, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        row.id,
        row.workflowName,
        row.organizationId,
        row.specVersion,
        row.idempotencyKey,
        JSON.stringify(row.input),
        row.status,
        row.startedAt,
      )
      .run();
  }

  async findRunByIdempotencyKey(
    workflowName: string,
    idempotencyKey: string,
  ): Promise<Run | null> {
    const result = await this.db
      .prepare(
        `SELECT * FROM runs
         WHERE organization_id = ?1 AND workflow_name = ?2 AND idempotency_key = ?3
         LIMIT 1`,
      )
      .bind(this.orgId, workflowName, idempotencyKey)
      .first<Record<string, unknown>>();
    return result ? rowToRun(result) : null;
  }

  async updateRunStatus(
    id: string,
    status: Run["status"],
    opts?: { output?: unknown; error?: string; completedAt?: string; failedAt?: string },
  ): Promise<void> {
    const setClauses: string[] = ["status = ?1"];
    const params: unknown[] = [status];
    let paramIdx = 2;

    if (opts?.output !== undefined) {
      setClauses.push(`output = ?${paramIdx}`);
      params.push(JSON.stringify(opts.output));
      paramIdx++;
    }
    if (opts?.error !== undefined) {
      setClauses.push(`error = ?${paramIdx}`);
      params.push(opts.error);
      paramIdx++;
    }
    if (opts?.completedAt !== undefined) {
      setClauses.push(`completed_at = ?${paramIdx}`);
      params.push(opts.completedAt);
      paramIdx++;
    }
    if (opts?.failedAt !== undefined) {
      setClauses.push(`failed_at = ?${paramIdx}`);
      params.push(opts.failedAt);
      paramIdx++;
    }

    params.push(id);
    const sql = `UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?${paramIdx}`;
    await this.db.prepare(sql).bind(...params).run();
  }

  getDb(): D1Database {
    return this.db;
  }
}
