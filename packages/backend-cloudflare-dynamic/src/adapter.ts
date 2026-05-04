import { SPEC_VERSION_CURRENT } from "@thodare/backend";
import type {
  BackendCore,
  ThodareHandler,
  WorkflowSpec,
  RegisteredWorkflow,
  RunHandle,
  RunOpts,
  RunId,
  StepId,
  StreamChunk,
  StreamInfo,
  MessageId,
  ValidQueueName,
  QueuePayload,
  QueueOptions,
  EventPayload,
} from "@thodare/backend";

import { CAPABILITIES } from "./capabilities.js";
import { D1Storage } from "./d1-storage.js";
import type { CFEnv } from "./types.js";
import type { LogSession } from "./log-session.js";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";

function makeId(): string {
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function notImplemented(method: string): never {
  throw new Error(`${method}: not_implemented`);
}

export interface CreateBackendCloudflareDynamicOptions {
  env: CFEnv;
  organizationId: string;
}

const WORKFLOWS_DDL = `
  CREATE TABLE IF NOT EXISTS workflows (
    organization_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    spec_version INTEGER NOT NULL,
    definition TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, id, version)
  )
`;

export class BackendCloudflareDynamic implements BackendCore {
  readonly id = "cloudflare-dynamic";
  readonly capabilities = CAPABILITIES;
  readonly specVersion = SPEC_VERSION_CURRENT;
  readonly mode = "embedded" as const;

  private readonly env: CFEnv;
  private readonly orgId: string;
  readonly storage: D1Storage;

  readonly events;
  readonly runs;
  readonly steps;
  readonly hooks;
  readonly streams;
  readonly queue;

  constructor(options: CreateBackendCloudflareDynamicOptions) {
    this.env = options.env;
    this.orgId = options.organizationId;
    this.storage = new D1Storage(options.env.THODARE_DB, this.orgId);

    this.events = this.storage.events;
    this.runs = this.storage.runs;
    this.steps = this.storage.steps;
    this.hooks = this.storage.hooks;

    const logSessionDo = options.env.LOG_SESSION;

    this.streams = {
      write: async (
        channel: string,
        runId: RunId,
        chunk: StreamChunk,
      ): Promise<void> => {
        const id = logSessionDo.idFromName(runId as string);
        const stub = logSessionDo.get(id);
        await (stub as unknown as LogSession).push(channel, chunk);
      },

      close: async (channel: string, runId: RunId): Promise<void> => {
        const id = logSessionDo.idFromName(runId as string);
        const stub = logSessionDo.get(id);
        await (stub as unknown as LogSession).closeChannel(channel);
      },

      get: async (
        channel: string,
        runId: RunId,
      ): Promise<StreamInfo | null> => {
        const id = logSessionDo.idFromName(runId as string);
        const stub = logSessionDo.get(id);
        return (stub as unknown as LogSession).getInfo(channel, runId);
      },

      list: async (runId: RunId): Promise<StreamInfo[]> => {
        const id = logSessionDo.idFromName(runId as string);
        const stub = logSessionDo.get(id);
        return (stub as unknown as LogSession).list(runId);
      },

      getChunks: async (
        channel: string,
        runId: RunId,
        since?: number,
      ): Promise<StreamChunk[]> => {
        const id = logSessionDo.idFromName(runId as string);
        const stub = logSessionDo.get(id);
        return (stub as unknown as LogSession).getChunks(channel, since);
      },

      getInfo: async (
        channel: string,
        runId: RunId,
      ): Promise<StreamInfo | null> => {
        const id = logSessionDo.idFromName(runId as string);
        const stub = logSessionDo.get(id);
        return (stub as unknown as LogSession).getInfo(channel, runId);
      },
    };

    this.queue = async (
      _name: ValidQueueName,
      _payload: QueuePayload,
      _opts?: QueueOptions,
    ): Promise<{ messageId: MessageId | null }> => {
      // Embedded mode: CF Workflows handles its own scheduling.
      return { messageId: null };
    };
  }

  async start(): Promise<void> {
    await this.env.THODARE_DB.prepare(WORKFLOWS_DDL).run();
    await this.storage.applyDDL();
  }

  async close(): Promise<void> {
    // Nothing to tear down — CF Workflows owns its lifecycle; D1 binding
    // is owned by the Worker runtime.
  }

  async defineWorkflow(
    spec: WorkflowSpec,
    _handler: ThodareHandler,
  ): Promise<RegisteredWorkflow> {
    const version = spec.version ?? 1;
    const createdAt = isoNow();

    // v1 alpha: defineWorkflow registers name+version only. Use
    // setWorkflowDefinition(...) to attach the SerializedWorkflow JSON
    // before runWorkflow. INSERT OR IGNORE preserves any existing
    // definition — re-calling defineWorkflow on an already-registered
    // (org, name, version) is a no-op rather than clobbering definition.
    await this.env.THODARE_DB
      .prepare(
        `INSERT OR IGNORE INTO workflows
         (organization_id, id, name, version, spec_version, definition, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        this.orgId,
        spec.name,
        spec.name,
        version,
        SPEC_VERSION_CURRENT,
        null,
        createdAt,
      )
      .run();

    return { name: spec.name, specVersion: SPEC_VERSION_CURRENT };
  }

  /**
   * CF-specific extension: attach the SerializedWorkflow JSON to a registered
   * workflow. Required before runWorkflow can dispatch — the dispatcher's
   * loadRunner reads this column and the walker interprets it.
   *
   * Other ThodareBackend adapters (PG/SQLite) execute via openworkflow's
   * runtime walker which holds the handler in-process; CF dispatch runs in
   * a serverless isolate so the JSON must be persisted in D1.
   */
  async setWorkflowDefinition(
    name: string,
    version: number,
    serializedWorkflow: unknown,
  ): Promise<void> {
    if (
      typeof serializedWorkflow !== "object" ||
      serializedWorkflow === null ||
      !("blocks" in serializedWorkflow) ||
      !Array.isArray(
        (serializedWorkflow as Record<string, unknown>)["blocks"],
      ) ||
      !("connections" in serializedWorkflow) ||
      !Array.isArray(
        (serializedWorkflow as Record<string, unknown>)["connections"],
      )
    ) {
      throw new TypeError(
        "setWorkflowDefinition: serializedWorkflow must be a non-null object with `blocks` and `connections` arrays",
      );
    }

    const result = await this.env.THODARE_DB
      .prepare(
        `UPDATE workflows SET definition = ?1
         WHERE organization_id = ?2 AND id = ?3 AND version = ?4`,
      )
      .bind(
        JSON.stringify(serializedWorkflow),
        this.orgId,
        name,
        version,
      )
      .run();

    if (result.meta.changes === 0) {
      // changes=0 can mean either "row not found" or "row matched but value
      // unchanged" depending on the SQLite/D1 build. Disambiguate with an
      // explicit existence check before throwing.
      const existing = await this.env.THODARE_DB
        .prepare(
          `SELECT 1 FROM workflows
           WHERE organization_id = ?1 AND id = ?2 AND version = ?3 LIMIT 1`,
        )
        .bind(this.orgId, name, version)
        .first<{ "1": number }>();

      if (!existing) {
        throw new Error(
          `setWorkflowDefinition: workflow "${name}" v${version} not registered — call defineWorkflow first`,
        );
      }
    }
  }

  async runWorkflow(
    name: string,
    input: unknown,
    opts?: RunOpts,
  ): Promise<RunHandle> {
    const idempotencyKey = opts?.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      const existing = await this.storage.findRunByIdempotencyKey(
        name,
        idempotencyKey,
      );
      if (existing) {
        return { runId: existing.id };
      }
    }

    const row = await this.env.THODARE_DB
      .prepare(
        `SELECT id, name, version, definition FROM workflows
         WHERE organization_id = ?1 AND id = ?2
         ORDER BY version DESC LIMIT 1`,
      )
      .bind(this.orgId, name)
      .first<{ id: string; name: string; version: number; definition: string | null }>();

    if (!row) {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${name}" not found. Call defineWorkflow first.`,
      );
    }

    if (row.definition === null) {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${name}" v${row.version} has no SerializedWorkflow attached. Call setWorkflowDefinition() before runWorkflow.`,
      );
    }

    const runId = makeId();
    const startedAt = isoNow();

    await this.storage.insertRun({
      id: runId,
      workflowName: name,
      organizationId: this.orgId,
      specVersion: SPEC_VERSION_CURRENT,
      idempotencyKey,
      input,
      status: "running",
      startedAt,
    });

    const runBinding = wrapWorkflowBinding(
      {
        workflowId: row.id,
        organizationId: this.orgId,
        workflowVersion: String(row.version),
        runId,
      },
      { bindingName: "WORKFLOWS" },
    );

    try {
      await runBinding.create({
        id: runId,
        params: input,
      } as WorkflowInstanceCreateOptions<unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.storage.updateRunStatus(runId, "failed", {
          error: message,
          failedAt: isoNow(),
        });
      } catch {
        /* swallow — original error takes precedence */
      }
      throw error;
    }

    await this.events.create({
      type: "run_started",
      runId,
      payload: {
        type: "run_started",
        runId,
        workflowName: name,
        input,
        startedAt,
      } as EventPayload,
      organizationId: this.orgId,
    });

    return { runId: runId as RunId };
  }

  async signal(
    runId: RunId,
    signalName: string,
    payload?: unknown,
  ): Promise<void> {
    try {
      const instance = await this.env.WORKFLOWS.get(runId as string);
      await instance.sendEvent({
        type: signalName,
        payload,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`signal(${runId}, ${signalName}): ${message}`);
    }

    await this.events.create({
      type: "signal_delivered",
      runId: runId as string,
      payload: {
        type: "signal_delivered",
        runId: runId as string,
        signalName,
        payload,
        deliveredAt: isoNow(),
      } as EventPayload,
      organizationId: this.orgId,
    });
  }

  async cancel(runId: RunId): Promise<void> {
    try {
      const instance = await this.env.WORKFLOWS.get(runId as string);
      await instance.terminate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cancel(${runId}): ${message}`);
    }
  }

  async resumeFromStep(_runId: RunId, _stepId: StepId): Promise<RunHandle> {
    return notImplemented("resumeFromStep");
  }

  async recover(_runId: RunId): Promise<RunHandle> {
    return notImplemented("recover");
  }
}

export async function createBackendCloudflareDynamic(
  options: CreateBackendCloudflareDynamicOptions,
): Promise<BackendCloudflareDynamic> {
  const backend = new BackendCloudflareDynamic(options);
  await backend.start();
  return backend;
}
