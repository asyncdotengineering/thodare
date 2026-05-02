/**
 * /api/workflows routes — CRUD + EditOp patch + run dispatch. Every
 * handler scopes by the active organization (resolved by the auth
 * middleware and exposed on `c.get("organizationId")`).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { WorkflowStore } from "../store/workflows.js";
import type { SerializedWorkflow, Wfkit } from "@thodare/engine";
import { EditOpSchema } from "@thodare/engine";
import type { RuntimeHost } from "../runtime-host.js";
import type { AuthVariables } from "../middleware/session.js";

const CreateBody = z.object({
  metadata: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

const UUID_RE = /^[0-9a-f-]{36}$/;

const PatchBody = z.object({
  ops: z.array(EditOpSchema),
});

const RunBody = z.object({
  input: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
});

export function createWorkflowsRouter(opts: {
  store: WorkflowStore;
  wfkit: Wfkit;
  runtimeHost: RuntimeHost;
}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post("/", async (c) => {
    const orgId = c.get("organizationId");
    let body: z.infer<typeof CreateBody>;
    try {
      const raw = await c.req.json();
      const parsed = CreateBody.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "invalid_body", issues: parsed.error.errors }, 400);
      }
      body = parsed.data;
    } catch {
      return c.json({ error: "invalid_body", message: "body must be JSON" }, 400);
    }
    const wf: SerializedWorkflow = {
      version: "1.0.0",
      ...(body.metadata ? { metadata: body.metadata } : {}),
      blocks: [],
      connections: [],
    };
    const row = await opts.store.create(orgId, wf);
    return c.json({ id: row.id, workflow: row.workflow, version: row.version }, 201);
  });

  app.get("/:id", async (c) => {
    const orgId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);
    const row = await opts.store.get(orgId, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ id: row.id, workflow: row.workflow, version: row.version });
  });

  app.post("/:id/operations", async (c) => {
    const orgId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);

    let body: z.infer<typeof PatchBody>;
    try {
      const raw = await c.req.json();
      const parsed = PatchBody.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "invalid_body", issues: parsed.error.errors }, 400);
      }
      body = parsed.data;
    } catch {
      return c.json({ error: "invalid_body", message: "body must be JSON" }, 400);
    }

    const row = await opts.store.get(orgId, id);
    if (!row) return c.json({ error: "not_found" }, 404);

    const ifMatch = c.req.header("if-match");
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;
    if (ifMatch && (Number.isNaN(expectedVersion) || expectedVersion! < 1)) {
      return c.json({ error: "invalid_if_match" }, 400);
    }

    const result = opts.wfkit.applyOps(row.workflow, body.ops);

    const updated = await opts.store.update(orgId, id, result.workflow, expectedVersion);
    if (updated === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if ("kind" in updated) {
      return c.json({ error: "version_mismatch", current: updated.current }, 412);
    }

    return c.json({
      ok: result.ok,
      workflow: result.workflow,
      version: updated.version,
      validation_errors: result.validation_errors,
      skipped_items: result.skipped_items,
      summary: result.summary,
    });
  });

  app.delete("/:id", async (c) => {
    const orgId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);
    const ok = await opts.store.remove(orgId, id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  app.post("/:id/run", async (c) => {
    const orgId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);
    const row = await opts.store.get(orgId, id);
    if (!row) return c.json({ error: "not_found" }, 404);

    let body: z.infer<typeof RunBody> = {};
    try {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = RunBody.safeParse(raw);
      if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.errors }, 400);
      body = parsed.data;
    } catch {
      // empty body is fine.
    }

    try {
      const result = await opts.runtimeHost.dispatch(
        row.workflow,
        body.input ?? {},
        {
          organizationId: orgId,
          ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        },
      );
      return c.json(result, 202);
    } catch (e: unknown) {
      return c.json({
        error: "dispatch_failed",
        message: e instanceof Error ? e.message : String(e),
      }, 500);
    }
  });

  return app;
}
