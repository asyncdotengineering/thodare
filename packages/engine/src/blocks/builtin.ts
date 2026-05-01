/**
 * Reference Block facades:
 *   - trigger_webhook (entrypoint)
 *   - http, slack, transform (compute)
 *   - wait_duration, wait_for_event, human_approval (declarative waits)
 *
 * Each wait block declares `kind: 'wait'`. The durable executor recognizes
 * this and uses step.sleep / step.waitForSignal directly instead of running
 * the tool inside step.run.
 */

import type { Block } from "../types.js";
import type { BlockRegistry } from "./registry.js";

export const triggerWebhookBlock: Block = {
  type: "trigger_webhook",
  name: "Webhook Trigger",
  description: "Workflow entrypoint. Output is the webhook payload.",
  category: "trigger",
  kind: "trigger",
  subBlocks: [{ id: "path", title: "Path", type: "short-input" }],
  outputs: { body: { type: "object" }, headers: { type: "object" } },
  tools: { access: [], config: { tool: () => "__trigger__" } },
};

export const httpBlock: Block = {
  type: "http",
  name: "HTTP Request",
  description: "Call any HTTP endpoint.",
  category: "tools",
  kind: "compute",
  subBlocks: [
    { id: "url", title: "URL", type: "short-input", required: true },
    {
      id: "method",
      title: "Method",
      type: "dropdown",
      options: [
        { id: "GET", label: "GET" },
        { id: "POST", label: "POST" },
        { id: "PUT", label: "PUT" },
        { id: "DELETE", label: "DELETE" },
        { id: "PATCH", label: "PATCH" },
      ],
    },
    { id: "headers", title: "Headers", type: "json" },
    { id: "body", title: "Body", type: "json" },
  ],
  outputs: {
    status: { type: "number" },
    body: { type: "object" },
    headers: { type: "object" },
  },
  tools: { access: ["http_request"], config: { tool: () => "http_request" } },
};

export const slackBlock: Block = {
  type: "slack",
  name: "Slack",
  description: "Send messages to Slack.",
  category: "tools",
  kind: "compute",
  subBlocks: [
    {
      id: "operation",
      title: "Operation",
      type: "dropdown",
      required: true,
      options: [{ id: "send", label: "Send Message" }],
    },
    { id: "channel", title: "Channel", type: "short-input", required: true },
    { id: "text", title: "Message", type: "long-input", required: true },
    { id: "threadTs", title: "Thread Timestamp", type: "short-input" },
  ],
  outputs: {
    ok: { type: "boolean" },
    ts: { type: "string" },
    channel: { type: "string" },
  },
  tools: {
    access: ["slack_send_message"],
    config: {
      tool: (p) => {
        const op = p.operation ?? "send";
        if (op === "send") return "slack_send_message";
        throw new Error(`Unknown slack operation: ${op}`);
      },
      params: (p) => ({ channel: p.channel, text: p.text, threadTs: p.threadTs }),
    },
  },
};

export const transformBlock: Block = {
  type: "transform",
  name: "Transform",
  description: "Shape data into a new object using a JSON template with {{block.field}} references.",
  category: "logic",
  kind: "compute",
  subBlocks: [{ id: "template", title: "Template", type: "json", required: true }],
  outputs: { result: { type: "object" } },
  tools: { access: ["transform_template"], config: { tool: () => "transform_template" } },
};

/* ─────────────  Wait blocks (kind: 'wait')  ───────────── */

export const waitDurationBlock: Block = {
  type: "wait_duration",
  name: "Wait: Duration",
  description: "Durably pause for a fixed duration.",
  category: "wait",
  kind: "wait",
  subBlocks: [
    { id: "duration", title: "Duration", type: "short-input", required: true },
    { id: "unit", title: "Unit", type: "short-input", required: true },
  ],
  outputs: { resumedAt: { type: "string" } },
  tools: { access: ["wait_duration"], config: { tool: () => "wait_duration" } },
};

export const waitForEventBlock: Block = {
  type: "wait_for_event",
  name: "Wait: For Event",
  description: "Park the run until a named event arrives.",
  category: "wait",
  kind: "wait",
  subBlocks: [
    { id: "eventName", title: "Event Name", type: "short-input", required: true },
    { id: "correlationKey", title: "Correlation Key", type: "short-input" },
    { id: "timeoutHours", title: "Timeout (hours)", type: "short-input" },
  ],
  outputs: { data: { type: "object" }, timedOut: { type: "boolean" } },
  tools: { access: ["wait_for_event"], config: { tool: () => "wait_for_event" } },
};

export const humanApprovalBlock: Block = {
  type: "human_approval",
  name: "Human Approval",
  description: "Pause until a human approves or rejects.",
  category: "wait",
  kind: "wait",
  subBlocks: [
    { id: "prompt", title: "Prompt", type: "long-input", required: true },
    { id: "timeoutHours", title: "Timeout (hours)", type: "short-input" },
  ],
  outputs: {
    approved: { type: "boolean" },
    by: { type: "string" },
    note: { type: "string" },
  },
  tools: { access: ["human_approval"], config: { tool: () => "human_approval" } },
};

export function registerBuiltinBlocks(reg: BlockRegistry): void {
  reg.register(triggerWebhookBlock);
  reg.register(httpBlock);
  reg.register(slackBlock);
  reg.register(transformBlock);
  reg.register(waitDurationBlock);
  reg.register(waitForEventBlock);
  reg.register(humanApprovalBlock);
}
