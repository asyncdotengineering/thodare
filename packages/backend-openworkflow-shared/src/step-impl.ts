import type { ThodareStep, SleepUntilLocalTimeOpts } from "@thodare/backend";
import type { OwStepApi, StepWaitTimeout } from "./derived-types.js";
import { makeId, isoNow, resolveSleepDuration } from "./helpers.js";

// ── SharedStepHost ──
//
// Minimal interface the shared StepImpl needs from the adapter.
// Each adapter (PG, SQLite) implements `insertEventRow` with its own
// DB-specific logic; StepImpl only calls through this contract.
//
// Per Rule 3: signal namespacing (${runId}:${signalName}) lives here
// so both adapters use the same logic byte-for-byte.

export interface SharedStepHost {
  insertEventRow(
    id: string,
    type: string,
    runId: string,
    stepId: string | null,
    payload: object,
  ): Promise<void>;
}

// ── StepImpl ──

export class StepImpl implements ThodareStep {
  private readonly host: SharedStepHost;
  private readonly runId: string;
  private readonly owStep: OwStepApi;

  constructor(
    host: SharedStepHost,
    runId: string,
    owStep: OwStepApi,
  ) {
    this.host = host;
    this.runId = runId;
    this.owStep = owStep;
  }

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const stepId = makeId();
    await this.host.insertEventRow(
      makeId(), "step_started", this.runId, stepId,
      { type: "step_started", runId: this.runId, stepId, name, startedAt: isoNow() },
    );

    try {
      const result = await this.owStep.run({ name }, fn);
      await this.host.insertEventRow(
        makeId(), "step_completed", this.runId, stepId,
        { type: "step_completed", runId: this.runId, stepId, name, output: result, completedAt: isoNow() },
      );
      return result as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.host.insertEventRow(
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
    await this.host.insertEventRow(
      makeId(), "step_started", this.runId, stepId,
      { type: "step_started", runId: this.runId, stepId, name, startedAt: isoNow() },
    );

    try {
      // DurationString is a branded string; at runtime it's a plain string.
      await this.owStep.sleep(name, durStr as string as Parameters<OwStepApi["sleep"]>[1]);
      await this.host.insertEventRow(
        makeId(), "step_completed", this.runId, stepId,
        { type: "step_completed", runId: this.runId, stepId, name, completedAt: isoNow() },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.host.insertEventRow(
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
