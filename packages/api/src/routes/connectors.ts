/**
 * /api/connectors — catalog of registered blocks for LLM consumption.
 *
 * The LLM uses this in two ways:
 *   1. /api/connectors → small list, included in the system prompt.
 *   2. /api/connectors/:type → fetched on demand for the few connectors
 *      the LLM plans to use in a given workflow (the "two-pass
 *      discovery" pattern).
 *
 * Hidden params are STRIPPED from the response. The LLM must never learn
 * that hidden params exist, or it'll emit them in patches and get them
 * silently filtered (which isn't catastrophic — applyOps strips them —
 * but it pollutes the LLM's reasoning).
 */

import { Hono } from "hono";
import type { Wfkit } from "@thodare/engine";

export function createConnectorsRouter(opts: { wfkit: Wfkit }): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({ data: opts.wfkit.catalog() });
  });

  app.get("/:type", (c) => {
    const type = c.req.param("type");
    const block = opts.wfkit.connector(type);
    if (!block) return c.json({ error: "not_found" }, 404);
    // defineConnector already excludes hidden params from subBlocks; this is
    // the LLM-facing surface, so we trust the upstream layer.
    return c.json(block);
  });

  return app;
}
