/**
 * Three reference compute tools (http, slack, transform). Carry the same
 * `visibility` flag treatment as wfkit so the LLM cannot smuggle credentials
 * into the workflow JSON.
 */

import type { Tool } from "../types.js";
import type { ToolRegistry } from "./registry.js";

export const httpRequestTool: Tool = {
  id: "http_request",
  name: "HTTP Request",
  description: "Make an arbitrary HTTP request. Returns parsed JSON or text.",
  params: {
    url: { type: "string", required: true, visibility: "user-or-llm" },
    method: { type: "string", required: false, visibility: "user-or-llm", description: "GET|POST|PUT|DELETE|PATCH" },
    headers: { type: "object", required: false, visibility: "user-or-llm" },
    body: { type: "object", required: false, visibility: "user-or-llm" },
  },
  outputs: {
    status: { type: "number" },
    body: { type: "object", description: "Parsed JSON if response is JSON, otherwise raw text" },
    headers: { type: "object" },
  },
  async execute(params, ctx) {
    const method = (params.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    let body: string | undefined;
    if (params.body != null && method !== "GET" && method !== "HEAD") {
      headers["content-type"] ??= "application/json";
      body = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    }
    ctx.log("info", "http_request", { method, url: params.url });
    const res = await fetch(params.url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    let parsed: any = text;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    return {
      status: res.status,
      body: parsed,
      headers: Object.fromEntries(res.headers.entries()),
    };
  },
};

export const slackSendMessageTool: Tool = {
  id: "slack_send_message",
  name: "Slack: Send Message",
  description: "Post a message to a Slack channel.",
  params: {
    channel: { type: "string", required: true, visibility: "user-or-llm" },
    text: { type: "string", required: true, visibility: "user-or-llm" },
    threadTs: { type: "string", required: false, visibility: "user-or-llm" },
    accessToken: { type: "string", required: true, visibility: "hidden" },
  },
  outputs: {
    ok: { type: "boolean" },
    ts: { type: "string" },
    channel: { type: "string" },
  },
  async execute(params, ctx) {
    const token = params.accessToken ?? ctx.env["SLACK_BOT_TOKEN"];
    if (!token) throw new Error("Missing Slack token");
    ctx.log("info", "slack_send_message", { channel: params.channel });
    return {
      ok: true,
      ts: `${Date.now() / 1000}`,
      channel: params.channel,
      _mock: true,
      _text: params.text,
    };
  },
};

export const transformTool: Tool = {
  id: "transform_template",
  name: "Transform: Template",
  description: "Build an object from a JSON template. Variables are resolved before this runs.",
  params: {
    template: { type: "object", required: true, visibility: "user-or-llm" },
  },
  outputs: { result: { type: "object" } },
  async execute(params) {
    return { result: params.template };
  },
};

export function registerBuiltinTools(reg: ToolRegistry): void {
  reg.register(httpRequestTool);
  reg.register(slackSendMessageTool);
  reg.register(transformTool);
}
