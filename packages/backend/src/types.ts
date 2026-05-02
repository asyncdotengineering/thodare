import type { BackendCapabilities } from "./capabilities.js";
import type { SpecVersion } from "./spec-version.js";
import type { Storage } from "./storage.js";
import type { Queue } from "./queue.js";
import type { Streamer } from "./streamer.js";

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
  runId: string;
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
  runId: string;
  firstBlockResult?: {
    blockId: string;
    output: unknown;
  };
}

// ── Backend ──

export interface ThodareBackend extends Storage, Queue, Streamer {
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
    runId: string,
    signalName: string,
    payload?: unknown,
  ): Promise<void>;

  cancel(runId: string): Promise<void>;

  resumeFromStep(
    runId: string,
    stepId: string,
  ): Promise<RunHandle>;

  recover(runId: string): Promise<RunHandle>;

  getEncryptionKeyForRun?(
    runId: string,
    ctx?: Record<string, unknown>,
  ): Promise<Uint8Array | undefined>;

  getDeploymentId?(): Promise<string>;

  resolveLatestDeploymentId?(): Promise<string>;
}
