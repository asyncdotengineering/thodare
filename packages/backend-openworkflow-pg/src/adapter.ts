import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
import { OpenWorkflow, Worker } from "@thodare/openworkflow";

// ── Derived types (from public OpenWorkflow surface, not internal.ts) ──
// OpenWorkflow.implementWorkflow reveals WorkflowSpec, WorkflowFunction.
type _OwImplFn = OpenWorkflow["implementWorkflow"];
type _OwImplParams = Parameters<_OwImplFn>;
type OwWorkflowSpec = _OwImplParams[0];
type OwWorkflowFunction = _OwImplParams[1];
// WorkflowFunctionParams and StepApi derived from WorkflowFunction.
type OwWorkflowFunctionParams = Parameters<OwWorkflowFunction>[0];
type OwStepApi = OwWorkflowFunctionParams["step"];
// StepWaitTimeout extracted from StepApi.waitForSignal options.
type _WaitForSignalOpts = Parameters<OwStepApi["waitForSignal"]>[0];
type StepWaitTimeout = NonNullable<_WaitForSignalOpts["timeout"]>;
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

// ── Events DDL ──

function eventsDDL(schemaName: string): string {
  return `
    CREATE TABLE IF NOT EXISTS "${schemaName}"."events" (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT,
      payload JSONB NOT NULL,
      correlation_id TEXT,
      organization_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

// ── Options ──

export interface CreateBackendOpenworkflowPgOptions {
  pgUrl: string;
  schema?: string;
  namespaceId?: string;
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

// ── Row types ──

interface OwWorkflowRunRow {
  id: string;
  workflowName: string;
  namespaceId: string;
  input: unknown;
  output: unknown;
  error: unknown;
  status: string;
  startedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface OwStepAttemptRow {
  id: string;
  workflowRunId: string;
  stepName: string;
  status: string;
  output: unknown;
  error: unknown;
  startedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// ── Row converters ──

function toEvent(row: Record<string, unknown>): Event {
  return {
    id: row["id"] as EventId,
    type: row["type"] as Event["type"],
    runId: row["runId"] as string,
    stepId: (row["stepId"] as string) ?? undefined,
    payload: row["payload"] as Event["payload"],
    correlationId: (row["correlationId"] as string) ?? undefined,
    organizationId: (row["organizationId"] as string) ?? undefined,
    createdAt: row["createdAt"] as string,
  };
}

function owRowToRun(row: OwWorkflowRunRow): Run {
  const status = mapOwRunStatus(row.status);
  const result: Run = {
    id: row.id as RunId,
    workflowName: row.workflowName,
    organizationId: row.namespaceId,
    input: row.input,
    status,
    startedAt: row.startedAt ?? row.createdAt,
  };
  if (row.output !== null && row.output !== undefined) {
    result.output = row.output;
  }
  const errMsg = resolveErrorMessage(row.error);
  if (errMsg !== undefined) {
    result.error = errMsg;
  }
  if (status === "completed" && row.finishedAt !== null) {
    result.completedAt = row.finishedAt;
  }
  if (status === "failed" && row.finishedAt !== null) {
    result.failedAt = row.finishedAt;
  }
  return result;
}

function owStepRowToStep(row: OwStepAttemptRow): Step {
  const status = mapOwStepStatus(row.status);
  const result: Step = {
    id: row.id as StepId,
    runId: row.workflowRunId as RunId,
    name: row.stepName,
    status,
    startedAt: row.startedAt ?? row.createdAt,
  };
  if (row.output !== null && row.output !== undefined) {
    result.output = row.output;
  }
  if (row.error !== null && row.error !== undefined) {
    const errMsg = resolveErrorMessage(row.error);
    if (errMsg !== undefined) {
      result.error = errMsg;
    }
  }
  if (status === "completed" && row.finishedAt !== null) {
    result.completedAt = row.finishedAt;
  }
  if (status === "failed" && row.finishedAt !== null) {
    result.failedAt = row.finishedAt;
  }
  return result;
}

function resolveErrorMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>)["message"] === "string"
  ) {
    return (error as Record<string, unknown>)["message"] as string;
  }
  return JSON.stringify(error);
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

// ── ThodareStep (wraps openworkflow StepApi + writes events) ──

class StepImpl implements ThodareStep {
  private readonly adapter: BackendOpenworkflowPg;
  private readonly runId: string;
  private readonly owStep: OwStepApi;

  constructor(
    adapter: BackendOpenworkflowPg,
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
    const stepId = makeId();
    await this.adapter.insertEventRow(
      makeId(), "step_started", this.runId, stepId,
      { type: "step_started", runId: this.runId, stepId, name, startedAt: isoNow() },
    );

    try {
      // DurationString is a branded string; at runtime it's a plain string.
      await this.owStep.sleep(name, durStr as string as Parameters<OwStepApi["sleep"]>[1]);
      await this.adapter.insertEventRow(
        makeId(), "step_completed", this.runId, stepId,
        { type: "step_completed", runId: this.runId, stepId, name, completedAt: isoNow() },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.adapter.insertEventRow(
        makeId(), "step_failed", this.runId, stepId,
        { type: "step_failed", runId: this.runId, stepId, name, error: message, failedAt: isoNow() },
      );
      throw error;
    }
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
    const namespacedSignal = `${this.runId}:${opts.signalName}`;
    const timeout: StepWaitTimeout | undefined = opts.timeoutMs;
    const result = await this.owStep.waitForSignal<T>({
      name: opts.name,
      signal: namespacedSignal,
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

// ── Logger stub ──

function createLogger(): ThodareLogger {
  const noopFn = () => {};
  return { debug: noopFn, info: noopFn, warn: noopFn, error: noopFn };
}

// ── SQL helpers (module-level for field init ordering) ──

type SqlClient = ReturnType<typeof postgres>;

function eventsIdent(
  sql: SqlClient,
  schemaName: string,
): ReturnType<SqlClient> {
  return sql`${sql(schemaName)}.${sql("events")}`;
}

function runsIdent(
  sql: SqlClient,
  schemaName: string,
): ReturnType<SqlClient> {
  return sql`${sql(schemaName)}.${sql("workflow_runs")}`;
}

function stepsIdent(
  sql: SqlClient,
  schemaName: string,
): ReturnType<SqlClient> {
  return sql`${sql(schemaName)}.${sql("step_attempts")}`;
}

async function insertEventRow(
  sql: SqlClient,
  schemaName: string,
  id: string,
  type: string,
  runId: string,
  stepId: string | null,
  payload: unknown,
  organizationId: string | null,
): Promise<void> {
  const table = eventsIdent(sql, schemaName);
  await sql`
    INSERT INTO ${table}
      (id, type, run_id, step_id, payload, organization_id, created_at)
    VALUES (${id}, ${type}, ${runId}, ${stepId ?? null}, ${sql.json(payload as Parameters<typeof sql.json>[0])}, ${organizationId}, NOW())
  `;
}

// ── Adapter ──

export class BackendOpenworkflowPg {
  readonly id = "openworkflow-pg";
  readonly capabilities = CAPABILITIES;
  readonly specVersion = SPEC_VERSION_CURRENT;
  readonly mode = "embedded" as const;

  private readonly sql: SqlClient;
  private readonly schemaName: string;
  private readonly namespaceId: string;
  private readonly backend: BackendPostgres;
  private readonly ow: OpenWorkflow;
  private worker: Worker | null = null;
  private started = false;
  private readonly specMap = new Map<
    string,
    { spec: OwWorkflowSpec }
  >();

  // Storage/Streamer/Queue — initialized in constructor body.
  readonly events;
  readonly runs;
  readonly steps;
  readonly hooks;
  readonly streams;
  readonly queue;

  private constructor(
    sql: SqlClient,
    schemaName: string,
    namespaceId: string,
    backend: BackendPostgres,
    ow: OpenWorkflow,
  ) {
    this.sql = sql;
    this.schemaName = schemaName;
    this.namespaceId = namespaceId;
    this.backend = backend;
    this.ow = ow;

    const s = this;

    // ── Events ──
    this.events = {
      create: async (input: EventInput): Promise<EventResult> => {
        const eid = makeId();
        const createdAt = isoNow();
        const organizationId = input.organizationId ?? s.namespaceId;
        const table = eventsIdent(s.sql, s.schemaName);

        const [row] = await s.sql<Array<Record<string, unknown>>>`
          INSERT INTO ${table}
            (id, type, run_id, step_id, payload, correlation_id, organization_id, created_at)
          VALUES (
            ${eid},
            ${input.type},
            ${input.runId},
            ${input.stepId ?? null},
            ${s.sql.json(input.payload as Parameters<typeof s.sql.json>[0])},
            ${input.correlationId ?? null},
            ${organizationId},
            ${createdAt}
          )
          RETURNING *
        `;

        if (row === undefined || row === null) {
          const evt: Event = {
            id: eid as EventId,
            type: input.type,
            runId: input.runId,
            payload: input.payload,
            createdAt,
          };
          if (input.stepId !== undefined) {
            (evt as unknown as Record<string, unknown>)["stepId"] = input.stepId;
          }
          if (input.correlationId !== undefined) {
            (evt as unknown as Record<string, unknown>)["correlationId"] = input.correlationId;
          }
          (evt as unknown as Record<string, unknown>)["organizationId"] = organizationId;
          return { event: evt };
        }

        return { event: toEvent(row) };
      },

      get: async (eventId: EventId): Promise<Event | null> => {
        const table = eventsIdent(s.sql, s.schemaName);
        const [row] = await s.sql<Array<Record<string, unknown>>>`
          SELECT * FROM ${table}
          WHERE organization_id = ${s.namespaceId} AND id = ${eventId as string}
          LIMIT 1
        `;
        return row ? toEvent(row) : null;
      },

      list: async (filter: EventListFilter): Promise<Event[]> => {
        const table = eventsIdent(s.sql, s.schemaName);
        let q = s.sql`SELECT * FROM ${table} WHERE organization_id = ${s.namespaceId}`;

        if (filter.runId !== undefined) {
          q = s.sql`${q} AND run_id = ${filter.runId}`;
        }
        if (filter.type !== undefined) {
          q = s.sql`${q} AND type = ${filter.type}`;
        }
        q = s.sql`${q} ORDER BY created_at ASC`;

        const limit = filter.limit ?? 100;
        const offset = filter.offset ?? 0;
        q = s.sql`${q} LIMIT ${limit} OFFSET ${offset}`;

        const rows = await q;
        if (!Array.isArray(rows)) return [];
        return rows.map(toEvent);
      },

      listByCorrelationId: async (correlationId: string): Promise<Event[]> => {
        const table = eventsIdent(s.sql, s.schemaName);
        const rows = await s.sql`
          SELECT * FROM ${table}
          WHERE organization_id = ${s.namespaceId}
          AND correlation_id = ${correlationId}
          ORDER BY created_at ASC
        `;
        if (!Array.isArray(rows)) return [];
        return rows.map(toEvent);
      },
    };

    // ── Runs ──
    this.runs = {
      get: async (runId: RunId): Promise<Run | null> => {
        const table = runsIdent(s.sql, s.schemaName);
        const [row] = await s.sql`
          SELECT * FROM ${table}
          WHERE namespace_id = ${s.namespaceId} AND id = ${runId as string}
          LIMIT 1
        `;
        return row ? owRowToRun(row as OwWorkflowRunRow) : null;
      },

      list: async (filter: RunListFilter): Promise<Run[]> => {
        const table = runsIdent(s.sql, s.schemaName);
        let q = s.sql`SELECT * FROM ${table} WHERE namespace_id = ${s.namespaceId}`;

        if (filter.workflowName !== undefined) {
          q = s.sql`${q} AND workflow_name = ${filter.workflowName}`;
        }
        if (filter.status !== undefined) {
          q = s.sql`${q} AND status = ${mapRunStatusToOw(filter.status)}`;
        }
        q = s.sql`${q} ORDER BY created_at DESC`;

        const limit = filter.limit ?? 100;
        const offset = filter.offset ?? 0;
        q = s.sql`${q} LIMIT ${limit} OFFSET ${offset}`;

        const rows = await q;
        if (!Array.isArray(rows)) return [];
        return rows.map((r) => owRowToRun(r as OwWorkflowRunRow));
      },
    };

    // ── Steps ──
    this.steps = {
      get: async (stepId: StepId): Promise<Step | null> => {
        const table = stepsIdent(s.sql, s.schemaName);
        const [row] = await s.sql`
          SELECT * FROM ${table}
          WHERE namespace_id = ${s.namespaceId} AND id = ${stepId as string}
          LIMIT 1
        `;
        return row ? owStepRowToStep(row as OwStepAttemptRow) : null;
      },

      list: async (runId: RunId): Promise<Step[]> => {
        const table = stepsIdent(s.sql, s.schemaName);
        const rows = await s.sql`
          SELECT * FROM ${table}
          WHERE namespace_id = ${s.namespaceId}
          AND workflow_run_id = ${runId as string}
          ORDER BY created_at ASC
        `;
        if (!Array.isArray(rows)) return [];
        return rows.map((r) => owStepRowToStep(r as OwStepAttemptRow));
      },
    };

    // ── Hooks ──
    this.hooks = {
      get: async (_hookId: HookId): Promise<Hook | null> => null,
      getByToken: async (_token: string): Promise<Hook | null> => null,
      list: async (_filter: HookListFilter): Promise<Hook[]> => [],
    };

    // ── Queue ──
    this.queue = async (
      _name: ValidQueueName,
      _payload: QueuePayload,
      _opts?: QueueOptions,
    ): Promise<{ messageId: MessageId | null }> => ({ messageId: null });

    // ── Streams ──
    this.streams = {
      write: async (
        _channel: string,
        _runId: RunId,
        _chunk: StreamChunk,
      ): Promise<void> => { /* no-op */ },
      close: async (_channel: string, _runId: RunId): Promise<void> => { /* no-op */ },
      get: async (_channel: string, _runId: RunId): Promise<StreamInfo | null> => null,
      list: async (_runId: RunId): Promise<StreamInfo[]> => [],
      getChunks: async (
        _channel: string,
        _runId: RunId,
        _since?: number,
      ): Promise<StreamChunk[]> => [],
      getInfo: async (_channel: string, _runId: RunId): Promise<StreamInfo | null> => null,
    };
  }

  static async connect(
    opts: CreateBackendOpenworkflowPgOptions,
  ): Promise<BackendOpenworkflowPg> {
    const schemaName = opts.schema ?? "openworkflow";

    const namespaceId = opts.namespaceId ?? "default";

    const backend = await BackendPostgres.connect(opts.pgUrl, {
      schema: schemaName,
      namespaceId,
    });

    const sql = postgres(opts.pgUrl, {
      max: 1,
      transform: { column: { from: postgres.toCamel } },
    });

    await sql.unsafe(eventsDDL(schemaName));

    const ow = new OpenWorkflow({ backend });

    return new BackendOpenworkflowPg(sql, schemaName, namespaceId, backend, ow);
  }

  // ── Lifecycle ──

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
    try { await this.backend.stop(); } catch { /* best-effort */ }
    try { await this.sql.end({ timeout: 5 }); } catch { /* best-effort */ }
  }

  // ── Workflow verbs ──

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
        await insertEventRow(
          adapter.sql, adapter.schemaName,
          makeId(), "run_completed", runId, null,
          { type: "run_completed", runId, output: result, completedAt: isoNow() },
          adapter.namespaceId,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await insertEventRow(
          adapter.sql, adapter.schemaName,
          makeId(), "run_failed", runId, null,
          { type: "run_failed", runId, error: message, failedAt: isoNow() },
          adapter.namespaceId,
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

    await insertEventRow(
      this.sql, this.schemaName,
      makeId(), "run_started", runId, null,
      { type: "run_started", runId, workflowName: name, input: input as Record<string, unknown>["input"], startedAt: isoNow() } as Record<string, unknown>,
      this.namespaceId,
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

    await insertEventRow(
      this.sql, this.schemaName,
      makeId(), "signal_delivered", runId as string, null,
      {
        type: "signal_delivered",
        runId: runId as string,
        signalName,
        payload,
        deliveredAt: isoNow(),
      },
      this.namespaceId,
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

  /**
   * Write an event to the events table. Public for use by StepImpl.
   */
  async insertEventRow(
    id: string,
    type: string,
    runId: string,
    stepId: string | null,
    payload: unknown,
  ): Promise<void> {
    return insertEventRow(this.sql, this.schemaName, id, type, runId, stepId, payload, this.namespaceId);
  }
}

export async function createBackendOpenworkflowPg(
  opts: CreateBackendOpenworkflowPgOptions,
): Promise<BackendOpenworkflowPg> {
  return BackendOpenworkflowPg.connect(opts);
}
