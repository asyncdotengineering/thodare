/**
 * Fluent workflow builder — types end-to-end, JSON wire format underneath.
 *
 * What we pin:
 *   1. .build() emits a SerializedWorkflow that's structurally equivalent
 *      to the hand-written JSON it replaces.
 *   2. References from paramsFn (e.g. `enrich.body.name`) compile down to
 *      `{{enrich.body.name}}` template strings — the resolver expands them
 *      at run time, exactly as before.
 *   3. The trigger payload is accessed as `input.x` and emits as
 *      `{{trigger.x}}`.
 *   4. Two consecutive .step() calls produce a linear DAG with auto-wired
 *      connections (no manual edge declarations).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineConnector, defineWorkflow } from "../src/index.js";

const http = defineConnector({
  type: "http-test",
  params: z.object({
    url: z.string(),
    method: z.string().optional(),
    body: z.object({}).passthrough().optional(),
  }),
  outputs: z.object({
    status: z.number(),
    body: z.object({ name: z.string() }).passthrough(),
  }),
  async run({ url }) { return { status: 200, body: { name: "Alice" } }; },
});

const slack = defineConnector({
  type: "slack-test",
  params: z.object({ channel: z.string(), text: z.string() }),
  outputs: z.object({ ok: z.boolean(), ts: z.string() }),
  async run({ channel }) { return { ok: true, ts: `${Date.now()}` }; },
});

describe("workflow builder", () => {
  it("emits a SerializedWorkflow with auto-wired linear DAG and template refs", () => {
    const wf = defineWorkflow("dx-lead")
      .input(z.object({ email: z.string() }))
      .step("enrich", http, ({ input }) => ({
        url: "https://api.example.com/enrich",
        method: "POST",
        body: { email: input.email },
      }))
      .step("notify", slack, ({ input, enrich }) => ({
        channel: "#sales",
        text: `Lead ${enrich.body.name} (${input.email})`,
      }))
      .build();

    expect(wf.metadata?.name).toBe("dx-lead");
    // Two real steps + the implicit trigger.
    expect(wf.blocks.map((b) => b.id)).toEqual(["__trigger__", "enrich", "notify"]);
    expect(wf.connections).toEqual([
      { source: "__trigger__", target: "enrich" },
      { source: "enrich", target: "notify" },
    ]);

    // The body field on enrich captures `input.email` as a template ref.
    const enrich = wf.blocks.find((b) => b.id === "enrich")!;
    expect(enrich.params).toMatchObject({
      url: "https://api.example.com/enrich",
      method: "POST",
      body: { email: "{{trigger.email}}" },
    });

    // notify.text interpolates two refs into a backtick template string.
    const notify = wf.blocks.find((b) => b.id === "notify")!;
    expect(notify.params["text"]).toBe("Lead {{enrich.body.name}} ({{trigger.email}})");
    expect(notify.params["channel"]).toBe("#sales");
  });

  it("a workflow with zero steps is still valid (just the implicit trigger)", () => {
    const wf = defineWorkflow("empty").build();
    expect(wf.blocks).toHaveLength(1);
    expect(wf.blocks[0]!.id).toBe("__trigger__");
    expect(wf.connections).toHaveLength(0);
  });

  it("ref proxies stringify cleanly when used in JSON.stringify (downstream serialization-safe)", () => {
    const wf = defineWorkflow("ser")
      .input(z.object({ user: z.object({ id: z.string() }) }))
      .step("step1", http, ({ input }) => ({
        url: "x",
        body: { who: input.user.id },
      }))
      .build();
    const json = JSON.stringify(wf);
    expect(json).toContain('"who":"{{trigger.user.id}}"');
  });
});
