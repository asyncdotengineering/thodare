// MessageId is branded — callers cannot fabricate it.
declare const MessageIdBrand: unique symbol;
export type MessageId = string & {
  readonly [MessageIdBrand]: typeof MessageIdBrand;
};

export type ValidQueueName = string;
export type QueuePrefix = string;

export interface QueuePayload {
  runId?: string;
  runInput?: unknown;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

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

export interface Queue {
  readonly mode: "push" | "pull" | "embedded";

  queue(
    name: ValidQueueName,
    payload: QueuePayload,
    opts?: QueueOptions,
  ): Promise<{ messageId: MessageId | null }>;

  createQueueHandler(
    prefix: QueuePrefix,
    handler: QueueHandler,
  ): (req: Request) => Promise<Response>;

  // Optional — only "pull" mode adapters implement this.
  // The contract is enforced at runtime; here we gate statically.
  next?(prefix: QueuePrefix): Promise<QueueDelivery | null>;

  getDeploymentId?(): Promise<string>;
}
