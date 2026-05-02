import type { BackendCapabilities } from "./capabilities.js";
import type { SpecVersion } from "./spec-version.js";
import type { Storage } from "./storage.js";
import type { Queue } from "./queue.js";
import type { Streamer } from "./streamer.js";
import type { RunId, StepId } from "./ids.js";

// ── Workflow spec ──

export interface WorkflowSpec {
  name: string;
  version?: number;
}

export interface RegisteredWorkflow {
  name: string;
  specVersion: SpecVersion;
}

// ── Handler ──

export type ThodareHandler = (ctx: ThodareCtx) => Promise<unknown>;

// ── Context ──

export interface ThodareCtx {
  input: unknown;
  step: ThodareStep;
  runId: RunId;
  signal: AbortSignal;
  log: ThodareLogger;
}

// ── Step ──

export interface SleepUntilLocalTimeOpts {
  timezone: string;
  hour: number;
  minute?: number;
  earliestDate?: Date;
  skipWeekends?: boolean;
}

export interface ThodareStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(
    name: string,
    duration: string | number | Date,
  ): Promise<void>;
  sleepUntilLocalTime(
    name: string,
    opts: SleepUntilLocalTimeOpts,
  ): Promise<void>;
  waitForSignal<T>(opts: {
    name: string;
    signalName: string;
    timeoutMs?: number;
  }): Promise<T>;
  getWriter<T>(channel?: string): WritableStreamDefaultWriter<T>;
}

// ── Logger ──

export interface ThodareLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ── Run opts ──

export interface RunOpts {
  idempotencyKey?: string;
  awaitFirstBlockResult?: {
    blockId: string;
    timeoutMs?: number;
  };
  specVersion?: SpecVersion;
}

// ── Run handle ──

export interface RunHandle {
  runId: RunId;
  firstBlockResult?: {
    blockId: string;
    output: unknown;
  };
}

// ── Backend ──

// The mode-independent backend surface — id, capabilities, lifecycle,
// and the workflow-control verbs. Composed with Storage, Streamer,
// and a discriminated Queue variant to form ThodareBackend.
export interface BackendCore {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  readonly specVersion?: SpecVersion;

  start?(): Promise<void>;
  close?(): Promise<void>;

  defineWorkflow(
    spec: WorkflowSpec,
    handler: ThodareHandler,
  ): Promise<RegisteredWorkflow>;

  runWorkflow(
    name: string,
    input: unknown,
    opts?: RunOpts,
  ): Promise<RunHandle>;

  signal(
    runId: RunId,
    signalName: string,
    payload?: unknown,
  ): Promise<void>;

  cancel(runId: RunId): Promise<void>;

  resumeFromStep(
    runId: RunId,
    stepId: StepId,
  ): Promise<RunHandle>;

  recover(runId: RunId): Promise<RunHandle>;

  getEncryptionKeyForRun?(
    runId: RunId,
    ctx?: Record<string, unknown>,
  ): Promise<Uint8Array | undefined>;

  resolveLatestDeploymentId?(): Promise<string>;
}

// `Queue` is a discriminated union (QueuePush | QueuePull | QueueEmbedded);
// `mode` narrows the queue surface. TS distributes the intersection over
// the union so `backend.mode === "push"` narrows the entire backend.
export type ThodareBackend = BackendCore & Storage & Streamer & Queue;
