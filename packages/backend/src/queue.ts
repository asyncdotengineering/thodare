// Single canonical QueuePayload shape: the Zod schema in `schemas.ts`
// is the source of truth; this type alias is its inferred shape.
import type { QueuePayload } from "./schemas.js";
export type { QueuePayload } from "./schemas.js";

declare const MessageIdBrand: unique symbol;
export type MessageId = string & {
  readonly [MessageIdBrand]: typeof MessageIdBrand;
};

export type ValidQueueName = string;
export type QueuePrefix = string;

export interface QueueOptions {
  delayMs?: number;
  priority?: number;
  correlationId?: string;
}

export interface QueueDelivery {
  messageId: MessageId;
  payload: QueuePayload;
  attemptCount: number;
  receivedAt: string;
}

export type QueueHandler = (
  payload: QueuePayload,
  ctx: { messageId: MessageId; attemptCount: number },
) => Promise<void>;

// Common surface every queue mode shares.
interface QueueCore {
  queue(
    name: ValidQueueName,
    payload: QueuePayload,
    opts?: QueueOptions,
  ): Promise<{ messageId: MessageId | null }>;

  getDeploymentId?(): Promise<string>;
}

// Push: substrate POSTs deliveries to a well-known route. Vercel queues,
// graphile-worker, in-process.
export interface QueuePush extends QueueCore {
  readonly mode: "push";
  createQueueHandler(
    prefix: QueuePrefix,
    handler: QueueHandler,
  ): (req: Request) => Promise<Response>;
}

// Pull: runtime drives a fetch loop. SQS, Kafka, NATS JetStream.
export interface QueuePull extends QueueCore {
  readonly mode: "pull";
  next(prefix: QueuePrefix): Promise<QueueDelivery | null>;
}

// Embedded: in-process dispatch, no HTTP loopback.
export interface QueueEmbedded extends QueueCore {
  readonly mode: "embedded";
}

// Discriminated union — the `mode` literal narrows at use sites.
export type Queue = QueuePush | QueuePull | QueueEmbedded;
