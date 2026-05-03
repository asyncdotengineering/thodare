import { createRequire } from "node:module";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";
import { OpenWorkflow, Worker } from "@thodare/openworkflow";

// ── Shared (extracted) ──
import {
  CAPABILITIES,
  type OwWorkflowSpec,
  type OwWorkflowFunction,
  type OwWorkflowFunctionParams,
  type SharedStepHost,
  StepImpl,
  makeId,
  isoNow,
  notImplemented,
  mapOwRunStatus,
  mapOwStepStatus,
  mapRunStatusToOw,
  createLogger,
} from "@thodare/backend-openworkflow-shared";

// ── Backend contract types ──
import type {
  RunId,
  StepId,
  EventId,
  EventInput,
  Event,
  EventResult,
  EventListFilter,
  Run,
  RunListFilter,
  Step,
  Hook,
  HookListFilter,
  StreamChunk,
  StreamInfo,
  ThodareHandler,
  ThodareCtx,
  WorkflowSpec,
  RegisteredWorkflow,
  RunHandle,
  RunOpts,
  MessageId,
  ValidQueueName,
  QueuePayload,
  QueueOptions,
  HookId,
} from "@thodare/backend";
import { SPEC_VERSION_CURRENT } from "@thodare/backend";

// ── Options ──

export interface CreateBackendOpenworkflowSqliteOptions {
  path?: string;
  namespaceId?: string;
}

// ── SQLite database interface ──

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

function newSqliteDb(path: string): SqliteDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { DatabaseSync: NodeDatabase } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDb;
  };
  return new NodeDatabase(path);
}

// ── Events table management ──

function ensureEventsTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "events" (
      "id" TEXT PRIMARY KEY,
      "type" TEXT NOT NULL,
      "run_id" TEXT NOT NULL,
      "step_id" TEXT,
      "payload" TEXT NOT NULL,
      "correlation_id" TEXT,
      "organization_id" TEXT,
      "created_at" TEXT NOT NULL
    )
  `);
}

// ── Row converters ──

function sqliteRowToEvent(row: Record<string, unknown>): Event {
  const payloadRaw = row["payload"];
  const payload = typeof payloadRaw === "string"
    ? (JSON.parse(payloadRaw) as Event["payload"])
    : (payloadRaw as Event["payload"]);
  return {
    id: row["id"] as EventId,
    type: row["type"] as Event["type"],
    runId: row["run_id"] as string,
    stepId: (row["step_id"] as string) ?? undefined,
    payload,
    correlationId: (row["correlation_id"] as string) ?? undefined,
    organizationId: (row["organization_id"] as string) ?? undefined,
    createdAt: row["created_at"] as string,
  };
}

interface SqliteRunRow {
  id: string;
  workflow_name: string;
  namespace_id: string;
  input: string | null;
  output: string | null;
  error: string | null;
  status: string;
  started_at: string | null;
  created_at: string;
  finished_at: string | null;
}

interface SqliteStepRow {
  id: string;
  workflow_run_id: string;
  step_name: string;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string | null;
  created_at: string;
  finished_at: string | null;
}

function sqliteRunRowToRun(row: SqliteRunRow): Run {
  const status = mapOwRunStatus(row.status);
  const result: Run = {
    id: row.id as RunId,
    workflowName: row.workflow_name,
    organizationId: row.namespace_id,
    input: row.input !== null ? tryParse(row.input) : undefined,
    status,
    startedAt: row.started_at ?? row.created_at,
  };
  if (row.output !== null) {
    result.output = tryParse(row.output);
  }
  if (row.error !== null) {
    result.error = row.error;
  }
  if (status === "completed" && row.finished_at !== null) {
    result.completedAt = row.finished_at;
  }
  if (status === "failed" && row.finished_at !== null) {
    result.failedAt = row.finished_at;
  }
  return result;
}

function sqliteStepRowToStep(row: SqliteStepRow): Step {
  const status = mapOwStepStatus(row.status);
  const result: Step = {
    id: row.id as StepId,
    runId: row.workflow_run_id as RunId,
    name: row.step_name,
    status,
    startedAt: row.started_at ?? row.created_at,
  };
  if (row.output !== null) {
    result.output = tryParse(row.output);
  }
  if (row.error !== null) {
    result.error = row.error;
  }
  if (status === "completed" && row.finished_at !== null) {
    result.completedAt = row.finished_at;
  }
  if (status === "failed" && row.finished_at !== null) {
    result.failedAt = row.finished_at;
  }
  return result;
}

function tryParse(v: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

// ── Adapter ──

export class BackendOpenworkflowSqlite implements SharedStepHost {
  readonly id = "openworkflow-sqlite";
  readonly capabilities = CAPABILITIES;
  readonly specVersion = SPEC_VERSION_CURRENT;
  readonly mode = "embedded" as const;

  private readonly eventsDb: SqliteDb;
  private readonly namespaceId: string;
  private readonly backend: BackendSqlite;
  private readonly ow: OpenWorkflow;
  private readonly _dbPath: string;
  private worker: Worker | null = null;
  private started = false;
  private readonly specMap = new Map<
    string,
    { spec: OwWorkflowSpec }
  >();

  readonly events;
  readonly runs;
  readonly steps;
  readonly hooks;
  readonly streams;
  readonly queue;

  private constructor(
    dbPath: string,
    eventsDb: SqliteDb,
    namespaceId: string,
    backend: BackendSqlite,
    ow: OpenWorkflow,
  ) {
    this._dbPath = dbPath;
    this.eventsDb = eventsDb;
    this.namespaceId = namespaceId;
    this.backend = backend;
    this.ow = ow;

    ensureEventsTable(eventsDb);

    const s = this;

    this.events = {
      create: async (input: EventInput): Promise<EventResult> => {
        const eid = makeId();
        const createdAt = isoNow();
        const organizationId = input.organizationId ?? s.namespaceId;
        const payloadJson = JSON.stringify(input.payload);

        s.eventsDb.prepare(`
          INSERT INTO "events" (id, type, run_id, step_id, payload, correlation_id, organization_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eid,
          input.type,
          input.runId,
          input.stepId ?? null,
          payloadJson,
          input.correlationId ?? null,
          organizationId,
          createdAt,
        );

        const event: Event = {
          id: eid as EventId,
          type: input.type,
          runId: input.runId,
          payload: input.payload,
          createdAt,
        };
        if (input.stepId !== undefined) {
          (event as unknown as Record<string, unknown>)["stepId"] = input.stepId;
        }
        if (input.correlationId !== undefined) {
          (event as unknown as Record<string, unknown>)["correlationId"] = input.correlationId;
        }
        (event as unknown as Record<string, unknown>)["organizationId"] = organizationId;
        return { event };
      },

      get: async (eventId: EventId): Promise<Event | null> => {
        const row = s.eventsDb.prepare(
          `SELECT * FROM "events" WHERE organization_id = ? AND id = ? LIMIT 1`,
        ).get(s.namespaceId, eventId as string);
        return row ? sqliteRowToEvent(row) : null;
      },

      list: async (filter: EventListFilter): Promise<Event[]> => {
        let sql = `SELECT * FROM "events" WHERE organization_id = ?`;
        const params: unknown[] = [s.namespaceId];

        if (filter.runId !== undefined) {
          sql += ` AND run_id = ?`;
          params.push(filter.runId);
        }
        if (filter.type !== undefined) {
          sql += ` AND type = ?`;
          params.push(filter.type);
        }
        sql += ` ORDER BY created_at ASC`;
        sql += ` LIMIT ? OFFSET ?`;
        params.push(filter.limit ?? 100, filter.offset ?? 0);

        const rows = s.eventsDb.prepare(sql).all(...params);
        return rows.map(sqliteRowToEvent);
      },

      listByCorrelationId: async (
        correlationId: string,
      ): Promise<Event[]> => {
        const rows = s.eventsDb.prepare(
          `SELECT * FROM "events" WHERE organization_id = ? AND correlation_id = ? ORDER BY created_at ASC`,
        ).all(s.namespaceId, correlationId);
        return rows.map(sqliteRowToEvent);
      },
    };

    this.runs = {
      get: async (runId: RunId): Promise<Run | null> => {
        const owDb = newSqliteDb(s._dbPath);
        try {
          const row = owDb.prepare(
            `SELECT * FROM "workflow_runs" WHERE namespace_id = ? AND id = ? LIMIT 1`,
          ).get(s.namespaceId, runId as string) as SqliteRunRow | undefined;
          return row ? sqliteRunRowToRun(row) : null;
        } finally {
          owDb.close();
        }
      },

      list: async (filter: RunListFilter): Promise<Run[]> => {
        const owDb = newSqliteDb(s._dbPath);
        try {
          let sql = `SELECT * FROM "workflow_runs" WHERE namespace_id = ?`;
          const params: unknown[] = [s.namespaceId];

          if (filter.workflowName !== undefined) {
            sql += ` AND workflow_name = ?`;
            params.push(filter.workflowName);
          }
          if (filter.status !== undefined) {
            sql += ` AND status = ?`;
            params.push(mapRunStatusToOw(filter.status));
          }
          sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
          params.push(filter.limit ?? 100, filter.offset ?? 0);

          const rows = owDb.prepare(sql).all(...params) as Array<Record<string, unknown>>;
          return rows.map((r) =>
            sqliteRunRowToRun(r as unknown as SqliteRunRow),
          );
        } finally {
          owDb.close();
        }
      },
    };

    this.steps = {
      get: async (stepId: StepId): Promise<Step | null> => {
        const owDb = newSqliteDb(s._dbPath);
        try {
          const row = owDb.prepare(
            `SELECT * FROM "step_attempts" WHERE namespace_id = ? AND id = ? LIMIT 1`,
          ).get(s.namespaceId, stepId as string) as SqliteStepRow | undefined;
          return row ? sqliteStepRowToStep(row) : null;
        } finally {
          owDb.close();
        }
      },

      list: async (runId: RunId): Promise<Step[]> => {
        const owDb = newSqliteDb(s._dbPath);
        try {
          const rows = owDb.prepare(
            `SELECT * FROM "step_attempts" WHERE namespace_id = ? AND workflow_run_id = ? ORDER BY created_at ASC`,
          ).all(s.namespaceId, runId as string) as Array<Record<string, unknown>>;
          return rows.map((r) =>
            sqliteStepRowToStep(r as unknown as SqliteStepRow),
          );
        } finally {
          owDb.close();
        }
      },
    };

    this.hooks = {
      get: async (_hookId: HookId): Promise<Hook | null> => null,
      getByToken: async (_token: string): Promise<Hook | null> => null,
      list: async (_filter: HookListFilter): Promise<Hook[]> => [],
    };

    this.queue = async (
      _name: ValidQueueName,
      _payload: QueuePayload,
      _opts?: QueueOptions,
    ): Promise<{ messageId: MessageId | null }> => ({ messageId: null });

    this.streams = {
      write: async (
        _channel: string,
        _runId: RunId,
        _chunk: StreamChunk,
      ): Promise<void> => { /* no-op */ },
      close: async (_channel: string, _runId: RunId): Promise<void> => { /* no-op */ },
      get: async (
        _channel: string,
        _runId: RunId,
      ): Promise<StreamInfo | null> => null,
      list: async (_runId: RunId): Promise<StreamInfo[]> => [],
      getChunks: async (
        _channel: string,
        _runId: RunId,
        _since?: number,
      ): Promise<StreamChunk[]> => [],
      getInfo: async (
        _channel: string,
        _runId: RunId,
      ): Promise<StreamInfo | null> => null,
    };
  }

  static connect(
    opts?: CreateBackendOpenworkflowSqliteOptions,
  ): BackendOpenworkflowSqlite {
    const dbPath = opts?.path ?? ":memory:";
    const namespaceId = opts?.namespaceId ?? "default";

    const backend = BackendSqlite.connect(dbPath, {
      namespaceId,
    });

    const eventsDb = newSqliteDb(dbPath);

    const ow = new OpenWorkflow({ backend });

    return new BackendOpenworkflowSqlite(dbPath, eventsDb, namespaceId, backend, ow);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.worker = this.ow.newWorker({ concurrency: 4 });
    await this.worker.start();
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.worker) {
      try { await this.worker.stop(); } catch { /* best-effort */ }
      this.worker = null;
    }
    this.started = false;
    try { this.eventsDb.close(); } catch { /* best-effort */ }
    try { await this.backend.stop(); } catch { /* best-effort */ }
  }

  async defineWorkflow(
    spec: WorkflowSpec,
    handler: ThodareHandler,
  ): Promise<RegisteredWorkflow> {
    const adapter = this;

    const bridgeFn: OwWorkflowFunction = async (
      params: OwWorkflowFunctionParams,
    ) => {
      const runId = params.run.id;
      const step = new StepImpl(adapter, runId, params.step);

      const abortController = new AbortController();
      const ctx: ThodareCtx = {
        input: params.input,
        step,
        runId: runId as RunId,
        signal: abortController.signal,
        log: createLogger(),
      };

      try {
        const result = await handler(ctx);
        await adapter.insertEventRow(
          makeId(), "run_completed", runId, null,
          { type: "run_completed", runId, output: result, completedAt: isoNow() },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await adapter.insertEventRow(
          makeId(), "run_failed", runId, null,
          { type: "run_failed", runId, error: message, failedAt: isoNow() },
        );
        throw error;
      }
    };

    const owSpec: OwWorkflowSpec = {
      name: spec.name,
    };

    this.ow.implementWorkflow(owSpec, bridgeFn);
    this.specMap.set(spec.name, { spec: owSpec });

    return { name: spec.name, specVersion: SPEC_VERSION_CURRENT };
  }

  async runWorkflow(
    name: string,
    input: unknown,
    opts?: RunOpts,
  ): Promise<RunHandle> {
    const entry = this.specMap.get(name);
    if (!entry) {
      throw new Error(
        `Workflow "${name}" is not registered. Call defineWorkflow first.`,
      );
    }

    const handle = await this.ow.runWorkflow(entry.spec, input, {
      ...(opts?.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : {}),
    });

    const runId = handle.workflowRun.id;

    await this.insertEventRow(
      makeId(), "run_started", runId, null,
      { type: "run_started", runId, workflowName: name, input, startedAt: isoNow() },
    );

    return { runId: runId as RunId };
  }

  async signal(
    runId: RunId,
    signalName: string,
    payload?: unknown,
  ): Promise<void> {
    const namespacedSignal = `${runId as string}:${signalName}`;
    await this.ow.sendSignal({
      signal: namespacedSignal,
      ...(payload !== undefined ? { data: payload } as const : {}),
    } as Parameters<typeof this.ow.sendSignal>[0]);

    await this.insertEventRow(
      makeId(), "signal_delivered", runId as string, null,
      {
        type: "signal_delivered",
        runId: runId as string,
        signalName,
        payload,
        deliveredAt: isoNow(),
      },
    );
  }

  async cancel(runId: RunId): Promise<void> {
    await this.ow.cancelWorkflowRun(runId as string);
  }

  async resumeFromStep(_runId: RunId, _stepId: StepId): Promise<RunHandle> {
    return notImplemented("resumeFromStep");
  }

  async recover(_runId: RunId): Promise<RunHandle> {
    return notImplemented("recover");
  }

  async insertEventRow(
    id: string,
    type: string,
    runId: string,
    stepId: string | null,
    payload: object,
  ): Promise<void> {
    this.eventsDb.prepare(`
      INSERT INTO "events" (id, type, run_id, step_id, payload, organization_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      type,
      runId,
      stepId ?? null,
      JSON.stringify(payload),
      this.namespaceId,
      isoNow(),
    );
  }
}

export function createBackendOpenworkflowSqlite(
  opts?: CreateBackendOpenworkflowSqliteOptions,
): BackendOpenworkflowSqlite {
  return BackendOpenworkflowSqlite.connect(opts);
}
