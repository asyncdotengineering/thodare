import postgres from "postgres";
import { BackendPostgres } from "@thodare/openworkflow/postgres";
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
  resolveErrorMessage,
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

export class BackendOpenworkflowPg implements SharedStepHost {
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
    // Restart the worker if already started, so newly registered
    // workflows (via defineWorkflow) are visible to the worker.
    if (this.worker) {
      try { await this.worker.stop(); } catch { /* best-effort */ }
      this.worker = null;
    }
    this.worker = this.ow.newWorker({ concurrency: 4 });
    await this.worker.start();
  }

  async close(): Promise<void> {
    if (this.worker) {
      try { await this.worker.stop(); } catch { /* best-effort */ }
      this.worker = null;
    }
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
        await adapter.insertEventRow(
          makeId(), "run_completed", runId, null,
          { type: "run_completed", runId, output: result, completedAt: isoNow() },
        );
        return result;
      } catch (error) {
        // SleepSignal is upstream control flow for parking the worker, not a
        // genuine run failure. Let it propagate to the worker without
        // emitting run_failed. Ref: packages/openworkflow/worker/execution.ts:60
        if (error instanceof Error && error.name === "SleepSignal") {
          throw error;
        }
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

  /**
   * Write an event to the events table. Public for use by StepImpl
   * (via the SharedStepHost contract).
   */
  async insertEventRow(
    id: string,
    type: string,
    runId: string,
    stepId: string | null,
    payload: object,
  ): Promise<void> {
    return insertEventRow(this.sql, this.schemaName, id, type, runId, stepId, payload, this.namespaceId);
  }
}

export async function createBackendOpenworkflowPg(
  opts: CreateBackendOpenworkflowPgOptions,
): Promise<BackendOpenworkflowPg> {
  return BackendOpenworkflowPg.connect(opts);
}
