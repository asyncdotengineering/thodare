import { z } from "zod";

// ── Event schemas (discriminated union) ──

export const EventTypeSchema = z.enum([
  "run_started",
  "run_completed",
  "run_failed",
  "step_started",
  "step_completed",
  "step_failed",
  "signal_delivered",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const RunStartedEventSchema = z.object({
  type: z.literal("run_started"),
  runId: z.string(),
  workflowName: z.string(),
  input: z.unknown(),
  startedAt: z.string(),
});
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;

export const RunCompletedEventSchema = z.object({
  type: z.literal("run_completed"),
  runId: z.string(),
  output: z.unknown(),
  completedAt: z.string(),
});
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;

export const RunFailedEventSchema = z.object({
  type: z.literal("run_failed"),
  runId: z.string(),
  error: z.string(),
  failedAt: z.string(),
});
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;

export const StepStartedEventSchema = z.object({
  type: z.literal("step_started"),
  runId: z.string(),
  stepId: z.string(),
  name: z.string(),
  startedAt: z.string(),
});
export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;

export const StepCompletedEventSchema = z.object({
  type: z.literal("step_completed"),
  runId: z.string(),
  stepId: z.string(),
  name: z.string(),
  output: z.unknown(),
  completedAt: z.string(),
});
export type StepCompletedEvent = z.infer<typeof StepCompletedEventSchema>;

export const StepFailedEventSchema = z.object({
  type: z.literal("step_failed"),
  runId: z.string(),
  stepId: z.string(),
  name: z.string(),
  error: z.string(),
  failedAt: z.string(),
});
export type StepFailedEvent = z.infer<typeof StepFailedEventSchema>;

export const SignalDeliveredEventSchema = z.object({
  type: z.literal("signal_delivered"),
  runId: z.string(),
  signalName: z.string(),
  payload: z.unknown().optional(),
  deliveredAt: z.string(),
});
export type SignalDeliveredEvent = z.infer<typeof SignalDeliveredEventSchema>;

export const EventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  StepStartedEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  SignalDeliveredEventSchema,
]);
export type EventPayload = z.infer<typeof EventSchema>;

// ── Queue payload ──

export const QueuePayloadSchema = z.object({
  runId: z.string().optional(),
  runInput: z.unknown().optional(),
  correlationId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type QueuePayload = z.infer<typeof QueuePayloadSchema>;

// ── Run options ──

export const RunOptsSchema = z.object({
  idempotencyKey: z.string().optional(),
  awaitFirstBlockResult: z
    .object({
      blockId: z.string(),
      timeoutMs: z.number().positive().int().optional(),
    })
    .optional(),
  specVersion: z.number().optional(),
});
export type RunOptsShape = z.infer<typeof RunOptsSchema>;

// ── Run handle ──

export const RunHandleSchema = z.object({
  runId: z.string(),
  firstBlockResult: z
    .object({
      blockId: z.string(),
      output: z.unknown(),
    })
    .optional(),
});
export type RunHandleShape = z.infer<typeof RunHandleSchema>;
