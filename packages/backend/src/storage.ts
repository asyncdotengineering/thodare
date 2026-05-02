import type { EventId, RunId, StepId, HookId } from "./ids.js";
import type { EventPayload } from "./schemas.js";

// ── Event ──

export interface EventInput {
  type: EventPayload["type"];
  runId: string;
  stepId?: string;
  payload: EventPayload;
  correlationId?: string;
  organizationId?: string;
}

export interface Event {
  id: EventId;
  type: EventPayload["type"];
  runId: string;
  stepId?: string;
  payload: EventPayload;
  correlationId?: string;
  organizationId?: string;
  createdAt: string;
}

export interface EventResult {
  event: Event;
  events?: Event[];
}

export interface EventListFilter {
  runId?: string;
  type?: EventPayload["type"];
  limit?: number;
  offset?: number;
}

// ── Materialized views (read-only) ──

export interface Run {
  id: RunId;
  workflowName: string;
  organizationId: string;
  input: unknown;
  output?: unknown;
  error?: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
}

export interface RunListFilter {
  workflowName?: string;
  status?: Run["status"];
  limit?: number;
  offset?: number;
}

export interface Step {
  id: StepId;
  runId: RunId;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
}

export interface Hook {
  id: HookId;
  runId: RunId;
  token: string;
  type: string;
  status: "waiting" | "delivered" | "expired";
  createdAt: string;
  deliveredAt?: string;
  expiredAt?: string;
}

export interface HookListFilter {
  runId?: string;
  type?: string;
  status?: Hook["status"];
  limit?: number;
  offset?: number;
}

// ── Storage interface ──

export interface Storage {
  events: {
    create(event: EventInput): Promise<EventResult>;
    get(eventId: EventId): Promise<Event | null>;
    list(filter: EventListFilter): Promise<Event[]>;
    listByCorrelationId(correlationId: string): Promise<Event[]>;
  };
  runs: {
    get(runId: RunId): Promise<Run | null>;
    list(filter: RunListFilter): Promise<Run[]>;
  };
  steps: {
    get(stepId: StepId): Promise<Step | null>;
    list(runId: RunId): Promise<Step[]>;
  };
  hooks: {
    get(hookId: HookId): Promise<Hook | null>;
    getByToken(token: string): Promise<Hook | null>;
    list(filter: HookListFilter): Promise<Hook[]>;
  };
}
