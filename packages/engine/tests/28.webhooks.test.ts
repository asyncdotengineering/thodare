/**
 * createWebhookRouter — typed inbound-webhook → workflow dispatch.
 *
 * Acceptance checks (from rfcs/three-additions/issues/03-...):
 *   1. .register({ path, method, spec, fromRequest, idempotencyKey }) — registry API.
 *   2. Path matching: exact, :param extraction, method-aware.
 *   3. .handle({...}) returns:
 *      - 202 { runId } on match + valid input
 *      - 404 { error: "no_route" } on no match
 *      - 400 { error: "validation_failed", issues } on Zod input fail
 *      - idempotencyKey passes through to runSpec.
 *   4. Multi-route coexistence.
 *   5. HTTP-server-agnostic — works with a fabricated request object.
 */

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { BackendSqlite } from "@thodare/openworkflow/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWebhookRouter,
  createWfkit,
  defineConnector,
  defineWorkflowSpec,
  type Wfkit,
} from "../src/index.js";

let wfkit: Wfkit | null = null;
let tmpDir = "";

async function newWfkit(): Promise<Wfkit> {
  tmpDir = mkdtempSync(join(tmpdir(), "wfkit-wh-"));
  const backend = BackendSqlite.connect(join(tmpDir, "ow.sqlite"));
  const kit = await createWfkit({ backend });
  wfkit = kit;
  return kit;
}

afterEach(async () => {
  if (wfkit) await wfkit.stop();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  wfkit = null;
});

const echo = defineConnector({
  type: "wh-echo",
  params: z.object({ msg: z.string() }),
  outputs: z.object({ msg: z.string() }),
  async run({ msg }) { return { msg }; },
});

describe("createWebhookRouter", () => {
  it("matches exact paths and dispatches a runSpec, returning 202 + runId", async () => {
    const Spec = defineWorkflowSpec({
      name: "wh-leads", version: "1",
      input: z.object({ email: z.string() }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(Spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: `lead:${input.email}` })),
    );
    await kit.start();

    const router = createWebhookRouter({ wfkit: kit });
    router.register({
      path: "/leads",
      method: "POST",
      spec: Spec,
      fromRequest: (req) => ({ email: (req.body as { email: string }).email }),
    });

    const r = await router.handle({
      method: "POST",
      path: "/leads",
      headers: {},
      body: { email: "alice@example.com" },
    });
    expect(r.status).toBe(202);
    expect(typeof (r.body as { runId: string }).runId).toBe("string");
    expect((r.body as { runId: string }).runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("extracts :params from the path and exposes them to fromRequest", async () => {
    const Spec = defineWorkflowSpec({
      name: "wh-param", version: "1",
      input: z.object({ tenant: z.string(), eventId: z.string() }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(Spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: `${input.tenant}:${input.eventId}` })),
    );
    await kit.start();

    const router = createWebhookRouter({ wfkit: kit });
    let captured: Record<string, string> | null = null;
    router.register({
      path: "/tenants/:tenant/events/:eventId",
      method: "POST",
      spec: Spec,
      fromRequest: (req) => {
        captured = req.params;
        return { tenant: req.params.tenant!, eventId: req.params.eventId! };
      },
    });

    const r = await router.handle({
      method: "POST",
      path: "/tenants/acme/events/evt-42",
      headers: {},
      body: {},
    });
    expect(r.status).toBe(202);
    expect(captured).toEqual({ tenant: "acme", eventId: "evt-42" });
  });

  it("returns 404 when no route matches", async () => {
    const kit = await newWfkit();
    await kit.start();
    const router = createWebhookRouter({ wfkit: kit });
    const r = await router.handle({ method: "POST", path: "/nope", headers: {}, body: {} });
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe("no_route");
  });

  it("is method-aware — same path, different method, no match", async () => {
    const Spec = defineWorkflowSpec({
      name: "wh-method", version: "1",
      input: z.object({}),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(Spec, (b) =>
      b.step("e", echo, () => ({ msg: "ok" })),
    );
    await kit.start();
    const router = createWebhookRouter({ wfkit: kit });
    router.register({ path: "/leads", method: "POST", spec: Spec, fromRequest: () => ({}) });

    const ok = await router.handle({ method: "POST", path: "/leads", headers: {}, body: {} });
    expect(ok.status).toBe(202);

    const wrong = await router.handle({ method: "GET", path: "/leads", headers: {}, body: {} });
    expect(wrong.status).toBe(404);
  });

  it("returns 400 when input fails the spec's Zod schema validation", async () => {
    const Spec = defineWorkflowSpec({
      name: "wh-invalid", version: "1",
      input: z.object({ email: z.string().email() }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(Spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: input.email })),
    );
    await kit.start();
    const router = createWebhookRouter({ wfkit: kit });
    router.register({
      path: "/leads", method: "POST", spec: Spec,
      fromRequest: (req) => ({ email: (req.body as { email: string }).email }),
    });
    const r = await router.handle({
      method: "POST",
      path: "/leads",
      headers: {},
      body: { email: "not-an-email" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("validation_failed");
    expect(Array.isArray((r.body as { issues: unknown[] }).issues)).toBe(true);
  });

  it("idempotencyKey derived from the request is passed through to runSpec — duplicate deliveries dedupe", async () => {
    const Spec = defineWorkflowSpec({
      name: "wh-idempo", version: "1",
      input: z.object({ id: z.string() }),
    });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(Spec, (b) =>
      b.step("e", echo, ({ input }) => ({ msg: input.id })),
    );
    await kit.start();
    const router = createWebhookRouter({ wfkit: kit });
    router.register({
      path: "/events", method: "POST", spec: Spec,
      fromRequest: (req) => ({ id: (req.body as { id: string }).id }),
      idempotencyKey: (req) => `evt:${(req.body as { id: string }).id}`,
    });
    const r1 = await router.handle({ method: "POST", path: "/events", headers: {}, body: { id: "x" } });
    const r2 = await router.handle({ method: "POST", path: "/events", headers: {}, body: { id: "x" } });
    // Both succeed; openworkflow dedupes via the idempotency key (same runId).
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect((r1.body as any).runId).toBe((r2.body as any).runId);
  });

  it("multi-route coexistence — different paths and specs both work", async () => {
    const A = defineWorkflowSpec({ name: "wh-a", version: "1", input: z.object({}) });
    const B = defineWorkflowSpec({ name: "wh-b", version: "1", input: z.object({}) });
    const kit = await newWfkit();
    kit.register(echo);
    kit.workflowFromSpec(A, (b) => b.step("e", echo, () => ({ msg: "a" })));
    kit.workflowFromSpec(B, (b) => b.step("e", echo, () => ({ msg: "b" })));
    await kit.start();
    const router = createWebhookRouter({ wfkit: kit });
    router.register({ path: "/a", method: "POST", spec: A, fromRequest: () => ({}) });
    router.register({ path: "/b", method: "POST", spec: B, fromRequest: () => ({}) });
    const ra = await router.handle({ method: "POST", path: "/a", headers: {}, body: {} });
    const rb = await router.handle({ method: "POST", path: "/b", headers: {}, body: {} });
    expect(ra.status).toBe(202);
    expect(rb.status).toBe(202);
    expect((ra.body as any).runId).not.toBe((rb.body as any).runId);
  });
});
