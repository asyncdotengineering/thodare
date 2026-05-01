import { describe, it, expect, afterEach } from "vitest";
import { buildDurableWorkflow, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";
import { newPgDurableHarness, type PgDurableHarness } from "./_durable-pg-harness.js";

let h: PgDurableHarness;
afterEach(async () => { await h.dispose(); });

/**
 * Drip-campaign-shaped flow on Postgres.
 *   trigger → welcome → wait 1s → tip1 → wait 1s → tip2 → wait_for_event → final
 *
 * Verifies (on a real PG-backed runtime):
 *   - wait_duration ⇒ step.sleep persists in workflow_runs and is honored
 *     across the worker pool.
 *   - wait_for_event ⇒ step.waitForSignal lands in the workflow_signals table
 *     and resumes the run when an emitter fires.
 *   - Each "send_email" tool fires exactly once — replays don't double-send.
 */
describe("Postgres backend: drip-campaign multi-pause flow", () => {
  it("welcome → 2× timer → 2× email → event-wait → final, all durable on PG", async () => {
    h = await newPgDurableHarness();
    const { tools, blocks } = freshRegistries();

    const emails: Array<{ template: string; to: string; extra?: any }> = [];
    const sendEmailTool = (template: string) => ({
      id: `send_email_${template}`,
      name: `Send Email: ${template}`,
      description: "test",
      params: {
        to: { type: "string" as const, required: true, visibility: "user-or-llm" as const },
        extra: { type: "object" as const, required: false, visibility: "user-or-llm" as const },
      },
      outputs: { sent: { type: "boolean" as const } },
      async execute(p: { to: string; extra?: any }) {
        emails.push({ template, to: p.to, extra: p.extra });
        return { sent: true, template, to: p.to };
      },
    });
    const sendEmailBlock = (template: string) => ({
      type: `email_${template}`,
      name: `Email: ${template}`,
      description: "test",
      category: "tools" as const,
      kind: "compute" as const,
      subBlocks: [
        { id: "to", title: "To", type: "short-input" as const, required: true },
        { id: "extra", title: "Extra", type: "json" as const },
      ],
      outputs: { sent: { type: "boolean" as const } },
      tools: { access: [`send_email_${template}`], config: { tool: () => `send_email_${template}` } },
    });
    for (const t of ["welcome", "tip1", "tip2", "final"]) {
      tools.register(sendEmailTool(t));
      blocks.register(sendEmailBlock(t));
    }

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      metadata: { name: `wf-pg-drip-${h.schema}` },
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: {} },
        { id: "welcome", type: "email_welcome", enabled: true, params: { to: "{{trigger.email}}" } },
        { id: "wait1", type: "wait_duration", enabled: true, params: { duration: 1, unit: "seconds" } },
        { id: "tip1", type: "email_tip1", enabled: true, params: { to: "{{trigger.email}}" } },
        { id: "wait2", type: "wait_duration", enabled: true, params: { duration: 1, unit: "seconds" } },
        { id: "tip2", type: "email_tip2", enabled: true, params: { to: "{{trigger.email}}" } },
        { id: "convert", type: "wait_for_event", enabled: true, params: { eventName: "subscription.created" } },
        {
          id: "final",
          type: "email_final",
          enabled: true,
          params: { to: "{{trigger.email}}", extra: { plan: "{{convert.data.plan}}" } },
        },
      ],
      connections: [
        { source: "trg", target: "welcome" },
        { source: "welcome", target: "wait1" },
        { source: "wait1", target: "tip1" },
        { source: "tip1", target: "wait2" },
        { source: "wait2", target: "tip2" },
        { source: "tip2", target: "convert" },
        { source: "convert", target: "final" },
      ],
    };

    const compiled = buildDurableWorkflow({
      ow: h.ow, backend: h.backend,
      blockRegistry: blocks,
      toolRegistry: tools,
      workflow: wf,
    });
    const signaller = h.ow.defineWorkflow(
      { name: `pg_drip_signaller_${h.schema}` },
      async ({ step }) => {
        await step.sendSignal({
          name: "emit",
          signal: "subscription.created",
          data: { plan: "pro" },
        });
        return { sent: true };
      },
    );

    await h.startWorker();

    const handle = await compiled.run({ email: "alice@example.com" });

    // Wait until the workflow has reached the convert step.
    await waitFor(() => emails.filter((e) => e.template === "tip2").length === 1, 10000);
    await (await signaller.run({})).result();

    const out = (await handle.result()) as { outputs: Record<string, any> };
    expect(out.outputs["final"].sent).toBe(true);
    expect(emails.map((e) => e.template)).toEqual(["welcome", "tip1", "tip2", "final"]);
    expect(emails[3]!.extra).toEqual({ plan: "pro" });
  });
});

async function waitFor(p: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (p()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timeout");
}
