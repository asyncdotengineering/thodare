/**
 * /api/schedules     — CRUD on cron-scheduled triggers, scoped by org.
 * /api/admin/tick    — manual dispatcher tick (for tests + manual ops).
 *
 * The tick reads schedules from ALL organizations (the dispatcher is a
 * cross-tenant background actor); it dispatches each schedule into the
 * runtime using the workflow's stored organization for downstream auth.
 */

import { Hono } from "hono";
import { z } from "zod";
import { dispatchOnce, parseCron, type ScheduleStore as KitScheduleStore } from "@thodare/engine";
import type { ScheduleStore } from "../store/schedules.js";
import type { WorkflowStore } from "../store/workflows.js";
import type { RuntimeHost } from "../runtime-host.js";
import type { AuthVariables } from "../middleware/session.js";

const CreateBody = z.object({
  id: z.string().optional(),
  workflowId: z.string().regex(/^[0-9a-f-]{36}$/),
  cron: z.string().min(1),
  payload: z.unknown().optional(),
  endAt: z.string().optional(),
});

export function createSchedulesRouter(opts: { store: ScheduleStore; workflows: WorkflowStore }): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post("/", async (c) => {
    const orgId = c.get("organizationId");
    let body: z.infer<typeof CreateBody>;
    try {
      const raw = await c.req.json();
      const parsed = CreateBody.safeParse(raw);
      if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.errors }, 400);
      body = parsed.data;
    } catch {
      return c.json({ error: "invalid_body", message: "body must be JSON" }, 400);
    }
    try { parseCron(body.cron); }
    catch (e: unknown) {
      return c.json({ error: "invalid_cron", message: e instanceof Error ? e.message : String(e) }, 400);
    }
    // Confirm the workflow belongs to this org BEFORE registering a schedule
    // for it. Cross-org binding via schedule is structurally rejected.
    const wf = await opts.workflows.get(orgId, body.workflowId);
    if (!wf) return c.json({ error: "workflow_not_found" }, 404);
    const row = await opts.store.create(orgId, {
      workflowId: body.workflowId,
      cron: body.cron,
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
    });
    return c.json(row, 201);
  });

  app.get("/", async (c) => {
    const orgId = c.get("organizationId");
    const rows = await opts.store.list(orgId);
    return c.json({ data: rows });
  });

  app.delete("/:id", async (c) => {
    const orgId = c.get("organizationId");
    const id = c.req.param("id");
    const ok = await opts.store.remove(orgId, id);
    return ok ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  return app;
}

/** /api/admin — manual dispatcher tick. */
export function createAdminRouter(opts: {
  schedules: ScheduleStore;
  workflows: WorkflowStore;
  runtimeHost: RuntimeHost;
}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post("/tick", async (c) => {
    const fired: Array<{ scheduleId: string; runId: string }> = [];
    const failed: Array<{ scheduleId: string; error: string }> = [];

    // Cross-tenant: tick reads ALL schedules. Workflow lookup is by id;
    // the workflows table carries organization_id so audit trails remain
    // attributable.
    const ourSchedules = await opts.schedules.listAll();
    // Per-(schedule, cutoff) claim is persisted via Postgres row locks
    // (SELECT … FOR UPDATE on the schedules row + last_fired_at advance).
    // Two parallel /tick requests claim disjoint cutoffs and never
    // double-fire — see ScheduleStore.tryClaim.
    const kitStore: KitScheduleStore = {
      async list() {
        return ourSchedules.map((s) => ({
          id: s.id,
          cron: s.cron,
          workflowName: s.workflowId,
          payload: s.payload,
          ...(s.endAt ? { endAt: s.endAt } : {}),
        }));
      },
      tryClaim: opts.schedules.tryClaim,
    };

    const result = await dispatchOnce(
      {
        store: kitStore,
        runWorkflow: async (workflowId, input, runOpts) => {
          const row = await opts.workflows.getInternalUnscoped(workflowId);
          if (!row) throw new Error(`workflow ${workflowId} not found`);
          const handle = await opts.runtimeHost.runtime.run(
            {
              workflow: row.workflow,
              input,
              organizationId: row.organizationId,
            },
            runOpts,
          );
          return { workflowRun: { id: handle.id } };
        },
      },
      new Date(),
    );
    for (const f of result.fired) fired.push(f);
    for (const f of result.failed) failed.push(f);

    return c.json({
      fired,
      failed,
      skippedAlreadyFired: result.skippedAlreadyFired,
      skippedNotMatching: result.skippedNotMatching,
      skippedExpired: result.skippedExpired,
    });
  });

  return app;
}
