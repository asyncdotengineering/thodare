/**
 * Wait tools — the heart of suspension/resumption (wfkit conv 08).
 *
 * Three shapes, ALL returning the same `PauseInfo` sentinel:
 *   - wait_duration:  relative pause (sleep N units)
 *   - wait_for_event: park until a named event arrives
 *   - human_approval: park until a token-keyed approval arrives, with
 *                     metadata.resumeUrl carrying the link to embed in
 *                     emails / UIs / Slack messages.
 *
 * Adapters interpret these:
 *   - In-memory executor: stops the run, persists snapshot, lets caller
 *                         resume(snapshot, payload).
 *   - openworkflow executor: maps to step.sleep / step.waitForSignal directly,
 *                            so the durable runtime owns the pause state.
 */

import { randomUUID } from "node:crypto";
import type { PauseInfo, Tool } from "../types.js";
import type { ToolRegistry } from "./registry.js";

function toMs(duration: number, unit: string): number {
  switch (unit) {
    case "ms":
    case "milliseconds":
      return duration;
    case "s":
    case "seconds":
      return duration * 1000;
    case "m":
    case "minutes":
      return duration * 60_000;
    case "h":
    case "hours":
      return duration * 3_600_000;
    case "d":
    case "days":
      return duration * 86_400_000;
    case "w":
    case "weeks":
      return duration * 7 * 86_400_000;
    default:
      throw new Error(`unsupported duration unit: ${unit}`);
  }
}

export const waitDurationTool: Tool = {
  id: "wait_duration",
  name: "Wait: Duration",
  description: "Pause execution for a fixed duration.",
  params: {
    duration: { type: "number", required: true, visibility: "user-or-llm" },
    unit: {
      type: "string",
      required: true,
      visibility: "user-or-llm",
      description: "'seconds' | 'minutes' | 'hours' | 'days' | 'weeks'",
    },
  },
  outputs: {
    resumedAt: { type: "string", description: "Wall-clock ISO timestamp the run resumed at." },
  },
  async execute(params): Promise<PauseInfo> {
    const ms = toMs(params.duration, params.unit);
    return {
      __paused: true,
      reason: "wait_duration",
      resumeAt: new Date(Date.now() + ms).toISOString(),
      resumeToken: randomUUID(),
      metadata: { requestedMs: ms },
    };
  },
};

export const waitForEventTool: Tool = {
  id: "wait_for_event",
  name: "Wait: For Event",
  description: "Pause until a named event arrives, optionally with a correlation key and timeout.",
  params: {
    eventName: { type: "string", required: true, visibility: "user-or-llm" },
    correlationKey: {
      type: "string",
      required: false,
      visibility: "user-or-llm",
      description: "Field on the event payload that identifies which run resumes.",
    },
    timeoutHours: { type: "number", required: false, visibility: "user-or-llm" },
  },
  outputs: {
    /** The event payload, if delivered. Null on timeout. */
    data: { type: "object" },
    timedOut: { type: "boolean" },
  },
  async execute(params): Promise<PauseInfo> {
    const out: PauseInfo = {
      __paused: true,
      reason: "wait_for_event",
      resumeOnEvent: params.eventName,
      resumeToken: randomUUID(),
      metadata: {},
    };
    if (params.correlationKey) out.correlationKey = params.correlationKey;
    if (params.timeoutHours) {
      out.resumeAt = new Date(Date.now() + params.timeoutHours * 3_600_000).toISOString();
    }
    return out;
  },
};

export const humanApprovalTool: Tool = {
  id: "human_approval",
  name: "Human Approval",
  description: "Pause until a human approves or rejects via a token URL.",
  params: {
    prompt: { type: "string", required: true, visibility: "user-or-llm" },
    /** Optional base URL for resume — the runner builds {base}/{token}. */
    resumeBaseUrl: { type: "string", required: false, visibility: "user-only" },
    /** Hard timeout — if missing, defaults to 7 days. */
    timeoutHours: { type: "number", required: false, visibility: "user-or-llm" },
  },
  outputs: {
    approved: { type: "boolean" },
    by: { type: "string" },
    note: { type: "string" },
  },
  async execute(params): Promise<PauseInfo> {
    const token = randomUUID();
    const timeout = params.timeoutHours ?? 24 * 7;
    const base = params.resumeBaseUrl ?? "https://app.example/api/runs/resume";
    return {
      __paused: true,
      reason: "human_approval",
      resumeOnEvent: `human_approval:${token}`,
      resumeToken: token,
      resumeAt: new Date(Date.now() + timeout * 3_600_000).toISOString(),
      metadata: {
        prompt: params.prompt,
        resumeUrl: `${base}/${token}`,
      },
    };
  },
};

export function registerWaitTools(reg: ToolRegistry): void {
  reg.register(waitDurationTool);
  reg.register(waitForEventTool);
  reg.register(humanApprovalTool);
}
