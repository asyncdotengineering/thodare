import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";
import { OpenWorkflow, Worker } from "@thodare/openworkflow";
import type {
  WorkflowSpec as OwWorkflowSpec,
  StepApi as OwStepApi,
  WorkflowFunction as OwWorkflowFunction,
  WorkflowFunctionParams as OwWorkflowFunctionParams,
  StepWaitTimeout,
} from "@thodare/openworkflow/internal";
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
  ThodareStep,
  ThodareLogger,
  SleepUntilLocalTimeOpts,
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
import type { BackendCapabilities } from "@thodare/backend";
import { SPEC_VERSION_CURRENT } from "@thodare/backend";

// ── Capabilities ──

const CAPABILITIES: BackendCapabilities = {
  maxStepDurationMs: 1_800_000,
  maxRunDurationMs: Number.MAX_SAFE_INTEGER,
  signalPrecision: "exact",
  exactlyOnceSteps: true,
  serverless: false,
  pricingModel: "self-host",

  supportsLiveSubscription: false,
  supportsStepIOInspection: true,
  supportsResumeFromStep: false,
  supportsRecover: false,
  liveSubscriptionLatencyMs: 0,

  supportsRemovedTombstone: false,

  supportsContainerBlocks: false,
  supportsDynamicSchemas: false,
  supportsAwaitFirstBlockResult: false,
};

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

// ── Helpers ──

function makeId(): string {
  return randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function notImplemented(method: string): never {
  throw new Error(`${method}: not_implemented`);
}

function resolveSleepDuration(
  duration: string | number | Date,
): string {
  if (typeof duration === "string") return duration;
  if (typeof duration === "number") return `${duration}ms`;
  const ms = duration.getTime() - Date.now();
  if (ms <= 0) return "0ms";
  return `${ms}ms`;
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

function mapOwRunStatus(s: string): Run["status"] {
  if (s === "pending") return "pending";
  if (s === "running" || s === "sleeping") return "running";
  if (s === "completed" || s === "succeeded") return "completed";
  if (s === "failed") return "failed";
  if (s === "canceled") return "canceled";
  return "pending";
}

function mapOwStepStatus(s: string): Step["status"] {
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  return "pending";
}

function mapRunStatusToOw(s: Run["status"]): string {
  if (s === "pending") return "pending";
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "canceled") return "canceled";
  return "pending";
}

// ── ThodareStep ──

class StepImpl implements ThodareStep {
  private readonly adapter: BackendOpenworkflowSqlite;
  private readonly runId: string;
  private readonly owStep: OwStepApi;

  constructor(
    adapter: BackendOpenworkflowSqlite,
    runId: string,
    owStep: OwStepApi,
  ) {
    this.adapter = adapter;
    this.runId = runId;
    this.owStep = owStep;
  }

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const stepId = makeId();
    await this.adapter.insertEventRow(
      makeId(), "step_started", this.runId, stepId,
      { type: "step_started", runId: this.runId, stepId, name, startedAt: isoNow() },
    );
    try {
      const result = await this.owStep.run({ name }, fn);
      await this.adapter.insertEventRow(
        makeId(), "step_completed", this.runId, stepId,
        { type: "step_completed", runId: this.runId, stepId, name, output: result, completedAt: isoNow() },
      );
      return result as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.adapter.insertEventRow(
        makeId(), "step_failed", this.runId, stepId,
        { type: "step_failed", runId: this.runId, stepId, name, error: message, failedAt: isoNow() },
      );
      throw error;
    }
  }

  async sleep(
    name: string,
    duration: string | number | Date,
  ): Promise<void> {
    const durStr = resolveSleepDuration(duration);
    await this.owStep.sleep(name, durStr as string as Parameters<OwStepApi["sleep"]>[1]);
  }

  async sleepUntilLocalTime(
    name: string,
    opts: SleepUntilLocalTimeOpts,
  ): Promise<void> {
    const now = new Date();
    const target = new Date(now);
    target.setHours(opts.hour, opts.minute ?? 0, 0, 0);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    const ms = target.getTime() - now.getTime();
    await this.sleep(name, ms);
  }

  async waitForSignal<T>(opts: {
    name: string;
    signalName: string;
    timeoutMs?: number;
  }): Promise<T> {
    const timeout: StepWaitTimeout | undefined = opts.timeoutMs;
    const result = await this.owStep.waitForSignal<T>({
      name: opts.name,
      signal: opts.signalName,
      ...(timeout !== undefined ? { timeout } : {}),
    });
    return (result?.data ?? undefined) as T;
  }

  getWriter<T>(_channel?: string): WritableStreamDefaultWriter<T> {
    const chunks: T[] = [];
    return new WritableStream<T>({
      write(chunk) {
        chunks.push(chunk);
      },
    }).getWriter();
  }
}

function createLogger(): ThodareLogger {
  const noopFn = () => {};
  return { debug: noopFn, info: noopFn, warn: noopFn, error: noopFn };
}

// ── Adapter ──

export class BackendOpenworkflowSqlite {
  readonly id = "openworkflow-sqlite";
  readonly capabilities = CAPABILITIES;
  readonly specVersion = SPEC_VERSION_CURRENT;
  readonly mode = "embedded" as const;

  private readonly eventsDb: SqliteDb;
  private readonly backend: BackendSqlite;
  private readonly ow: OpenWorkflow;
  private readonly _dbPath: string;
  private worker: Worker | null = null;
  private started = false;
  private readonly specMap = new Map<
    string,
    { spec: OwWorkflowSpec<unknown, unknown, unknown> }
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
    backend: BackendSqlite,
    ow: OpenWorkflow,
  ) {
    this._dbPath = dbPath;
    this.eventsDb = eventsDb;
    this.backend = backend;
    this.ow = ow;

    ensureEventsTable(eventsDb);

    const s = this;

    this.events = {
      create: async (input: EventInput): Promise<EventResult> => {
        const eid = makeId();
        const createdAt = isoNow();
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
          input.organizationId ?? null,
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
        if (input.organizationId !== undefined) {
          (event as unknown as Record<string, unknown>)["organizationId"] = input.organizationId;
        }
        return { event };
      },

      get: async (eventId: EventId): Promise<Event | null> => {
        const row = s.eventsDb.prepare(
          `SELECT * FROM "events" WHERE id = ? LIMIT 1`,
        ).get(eventId as string);
        return row ? sqliteRowToEvent(row) : null;
      },

      list: async (filter: EventListFilter): Promise<Event[]> => {
        let sql = `SELECT * FROM "events" WHERE 1=1`;
        const params: unknown[] = [];

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
          `SELECT * FROM "events" WHERE correlation_id = ? ORDER BY created_at ASC`,
        ).all(correlationId);
        return rows.map(sqliteRowToEvent);
      },
    };

    this.runs = {
      get: async (runId: RunId): Promise<Run | null> => {
        // Read from openworkflow's SQLite DB via a second connection
        const owDb = newSqliteDb(s._dbPath);
        try {
          const row = owDb.prepare(
            `SELECT * FROM "workflow_runs" WHERE id = ? LIMIT 1`,
          ).get(runId as string) as SqliteRunRow | undefined;
          return row ? sqliteRunRowToRun(row) : null;
        } finally {
          owDb.close();
        }
      },

      list: async (filter: RunListFilter): Promise<Run[]> => {
        const owDb = newSqliteDb(s._dbPath);
        try {
          let sql = `SELECT * FROM "workflow_runs" WHERE 1=1`;
          const params: unknown[] = [];

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
            `SELECT * FROM "step_attempts" WHERE id = ? LIMIT 1`,
          ).get(stepId as string) as SqliteStepRow | undefined;
          return row ? sqliteStepRowToStep(row) : null;
        } finally {
          owDb.close();
        }
      },

      list: async (runId: RunId): Promise<Step[]> => {
        const owDb = newSqliteDb(s._dbPath);
        try {
          const rows = owDb.prepare(
            `SELECT * FROM "step_attempts" WHERE workflow_run_id = ? ORDER BY created_at ASC`,
          ).all(runId as string) as Array<Record<string, unknown>>;
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

    const backend = BackendSqlite.connect(dbPath, {
      ...(opts?.namespaceId !== undefined
        ? { namespaceId: opts.namespaceId }
        : {}),
    });

    const eventsDb = newSqliteDb(dbPath);

    const ow = new OpenWorkflow({ backend });

    return new BackendOpenworkflowSqlite(dbPath, eventsDb, backend, ow);
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

    const bridgeFn: OwWorkflowFunction<unknown, unknown> = async (
      params: OwWorkflowFunctionParams<unknown>,
    ) => {
      const runId = params.run.id;
      const step = new StepImpl(adapter, runId, params.step);

      const ctx: ThodareCtx = {
        input: params.input,
        step,
        runId: runId as RunId,
        signal: new AbortSignal(),
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

    const owSpec: OwWorkflowSpec<unknown, unknown, unknown> = {
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
    await this.ow.sendSignal({
      signal: signalName,
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
    payload: unknown,
  ): Promise<void> {
    this.eventsDb.prepare(`
      INSERT INTO "events" (id, type, run_id, step_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      type,
      runId,
      stepId ?? null,
      JSON.stringify(payload),
      isoNow(),
    );
  }
}

export function createBackendOpenworkflowSqlite(
  opts?: CreateBackendOpenworkflowSqliteOptions,
): BackendOpenworkflowSqlite {
  return BackendOpenworkflowSqlite.connect(opts);
}
