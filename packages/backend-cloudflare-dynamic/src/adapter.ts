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
    definition TEXT NOT NULL,
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

    this.streams = {
      write: async (
        _channel: string,
        _runId: RunId,
        _chunk: StreamChunk,
      ): Promise<void> => {
        notImplemented("streams.write");
      },
      close: async (_channel: string, _runId: RunId): Promise<void> => {
        notImplemented("streams.close");
      },
      get: async (
        _channel: string,
        _runId: RunId,
      ): Promise<StreamInfo | null> => {
        notImplemented("streams.get");
      },
      list: async (_runId: RunId): Promise<StreamInfo[]> => {
        notImplemented("streams.list");
      },
      getChunks: async (
        _channel: string,
        _runId: RunId,
        _since?: number,
      ): Promise<StreamChunk[]> => {
        notImplemented("streams.getChunks");
      },
      getInfo: async (
        _channel: string,
        _runId: RunId,
      ): Promise<StreamInfo | null> => {
        notImplemented("streams.getInfo");
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

    // v1 alpha stores only metadata. The handler is not wired — the runtime
    // walker bundle (Phase 4.x) will interpret the workflow JSON on each run.
    const definition = JSON.stringify({
      name: spec.name,
      version,
      handlerRegistered: false,
    });

    await this.env.THODARE_DB
      .prepare(
        `INSERT OR REPLACE INTO workflows
         (organization_id, id, name, version, spec_version, definition, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        this.orgId,
        spec.name,
        spec.name,
        version,
        SPEC_VERSION_CURRENT,
        definition,
        createdAt,
      )
      .run();

    return { name: spec.name, specVersion: SPEC_VERSION_CURRENT };
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
        `SELECT id, name, version FROM workflows
         WHERE organization_id = ?1 AND id = ?2
         ORDER BY version DESC LIMIT 1`,
      )
      .bind(this.orgId, name)
      .first<{ id: string; name: string; version: number }>();

    if (!row) {
      throw new Error(
        `backend-cloudflare-dynamic: workflow "${name}" not found. Call defineWorkflow first.`,
      );
    }

    const runId = makeId();
    const startedAt = isoNow();

    // Insert as "running" — D1 insert + CF create are not transactional, so
    // a "pending" intermediate state would be observable forever if the
    // status update after create() failed. Inserting as running matches
    // the post-create reality if create() succeeds.
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
      // Best-effort failure persistence. If this update itself throws we
      // rethrow the original create() error — the run row will read as
      // "running" with no completion event, which is observable as a stuck
      // run by callers and recoverable by recover() (Phase 4.x).
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
    // Per dynamic-workflows binding.ts:152-154, get(id) does NOT envelope
    // metadata — call the underlying binding directly to avoid pointless
    // round-tripping and misleading wrap.
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
