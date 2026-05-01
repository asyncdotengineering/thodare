import { describe, it, expect } from "vitest";
import { execute, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";

const baseWf = (extra: SerializedWorkflow["blocks"][number]): SerializedWorkflow => ({
  version: "1.0.0",
  blocks: [
    { id: "trg", type: "trigger_webhook", enabled: true, params: { path: "/x" } },
    extra,
  ],
  connections: [{ source: "trg", target: extra.id }],
});

describe("wait tool sentinels", () => {
  it("wait_duration produces a time-based sentinel with resumeAt in the future", async () => {
    const { tools, blocks } = freshRegistries();
    const wf = baseWf({
      id: "wait",
      type: "wait_duration",
      enabled: true,
      params: { duration: 30, unit: "seconds" },
    });
    const r = await execute({ workflow: wf, toolRegistry: tools, blockRegistry: blocks });
    expect(r.paused).toBe(true);
    const p = r.snapshot!.pause;
    expect(p.reason).toBe("wait_duration");
    expect(p.resumeOnEvent).toBeUndefined();
    expect(p.resumeAt).toBeDefined();
    expect(new Date(p.resumeAt!).getTime()).toBeGreaterThan(Date.now());
    expect(p.resumeToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("wait_for_event produces an event-based sentinel with optional timeout", async () => {
    const { tools, blocks } = freshRegistries();
    const wf = baseWf({
      id: "wait",
      type: "wait_for_event",
      enabled: true,
      params: {
        eventName: "subscription.created",
        correlationKey: "{{trigger.userId}}",
        timeoutHours: 2,
      },
    });
    const r = await execute({
      workflow: wf,
      toolRegistry: tools,
      blockRegistry: blocks,
      trigger: { userId: "u-42" },
    });
    expect(r.paused).toBe(true);
    const p = r.snapshot!.pause;
    expect(p.reason).toBe("wait_for_event");
    expect(p.resumeOnEvent).toBe("subscription.created");
    expect(p.correlationKey).toBe("u-42");
    expect(p.resumeAt).toBeDefined(); // timeout
  });

  it("human_approval emits a token-keyed signal name and a resumeUrl in metadata", async () => {
    const { tools, blocks } = freshRegistries();
    const wf = baseWf({
      id: "approve",
      type: "human_approval",
      enabled: true,
      params: { prompt: "Approve $50k discount?", timeoutHours: 24 },
    });
    const r = await execute({ workflow: wf, toolRegistry: tools, blockRegistry: blocks });
    expect(r.paused).toBe(true);
    const p = r.snapshot!.pause;
    expect(p.reason).toBe("human_approval");
    expect(p.resumeOnEvent).toMatch(/^human_approval:[0-9a-f-]+$/);
    expect(p.metadata?.["resumeUrl"]).toMatch(/^https?:\/\/.+\/[0-9a-f-]+$/);
    expect(p.metadata?.["prompt"]).toBe("Approve $50k discount?");
  });
});
