/**
 * /api/credentials routes — CRUD for the credential primitive.
 *
 * Every handler scopes by the active organization (resolved by the auth
 * middleware and exposed on `c.get("organizationId")`).
 *
 * Secrets are encrypted at rest; NO route returns the plaintext secret.
 * Only `getDecrypted` (store-level, internal) has access, and no HTTP
 * handler calls it.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { CredentialStore } from "../store/credentials.js";
import type { AuthVariables } from "../middleware/session.js";

const UUID_RE = /^[0-9a-f-]{36}$/;

const SecretSchema = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
  scopes: z.array(z.string()).optional(),
  secret: SecretSchema,
});

export function createCredentialsRouter(opts: {
  store: CredentialStore;
  masterKey: Uint8Array;
}): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/", async (c) => {
    const orgId = c.get("organizationId");
    const type = c.req.query("type") ?? undefined;
    const rows = await opts.store.list(orgId, type ? { type } : undefined);
    return c.json(rows);
  });

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
    const row = await opts.store.create(orgId, {
      type: body.type,
      displayName: body.displayName,
      ...(body.properties ? { properties: body.properties } : {}),
      ...(body.scopes ? { scopes: body.scopes } : {}),
      secret: body.secret,
    }, opts.masterKey);
    return c.json(row, 201);
  });

  app.post("/:id/test", async (c) => {
    return c.json({ error: "not_implemented", message: "Credential testing lands in Phase 5b." }, 501);
  });

  app.delete("/:id", async (c) => {
    const orgId = c.get("organizationId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "not_found" }, 404);
    const ok = await opts.store.remove(orgId, id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
