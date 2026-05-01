/**
 * /api/workflows/:id/run — dispatch
 * /api/runs/:runId — describe
 * /api/runs/:runId/logs — paginated step attempts
 * /api/runs/:runId/cancel — cancel
 */

import { Hono } from "hono";
import type { Wfkit } from "@thodare/engine";
import type { RuntimeHost } from "../runtime-host.js";

const UUID_RE = /^[0-9a-f-]{36}$/;

export function createRunsRouter(opts: {
  wfkit: Wfkit;
  runtimeHost: RuntimeHost;
}): Hono {
  const app = new Hono();

  app.get("/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "not_found" }, 404);
    try {
      const handle = opts.runtimeHost.runtime.getHandle(runId);
      const desc = await handle.describe();
      return c.json(desc);
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
  });

  app.get("/:runId/logs", async (c) => {
    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "not_found" }, 404);
    const after = c.req.query("after");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    try {
      const result = await opts.wfkit.backend.listStepAttempts({
        workflowRunId: runId,
        limit,
        ...(after ? { after } : {}),
      });
      return c.json(result);
    } catch (e: unknown) {
      return c.json({
        error: "logs_failed",
        message: e instanceof Error ? e.message : String(e),
      }, 500);
    }
  });

  app.post("/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "not_found" }, 404);
    try {
      const handle = opts.runtimeHost.runtime.getHandle(runId);
      await handle.cancel();
      return c.body(null, 204);
    } catch (e: unknown) {
      return c.json({ error: "cancel_failed", message: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return app;
}
