/**
 * C-1 acceptance: createControlPlaneApi factory + Hono app + Postgres
 * workflow store + workflows CRUD.
 */

import { afterEach, describe, expect, it } from "vitest";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

describe("createControlPlaneApi + workflows CRUD", () => {
  it("boots and serves /health without auth", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  });

  it("POST /api/workflows creates an empty workflow with version 1", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ metadata: { name: "test-flow" } }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; workflow: any; version: number };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.version).toBe(1);
    expect(body.workflow.metadata.name).toBe("test-flow");
    expect(body.workflow.blocks).toEqual([]);
    expect(body.workflow.connections).toEqual([]);
  });

  it("GET /api/workflows/:id returns the stored workflow", async () => {
    h = await newApiHarness();
    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({ metadata: { name: "fetch-me" } }),
      })
    ).json()) as { id: string };
    const r = await h.fetch(`/api/workflows/${created.id}`, { headers: withAuth(h.token) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { workflow: any; version: number };
    expect(body.workflow.metadata.name).toBe("fetch-me");
    expect(body.version).toBe(1);
  });

  it("GET /api/workflows/:id with unknown id returns 404", async () => {
    h = await newApiHarness();
    const r = await h.fetch(`/api/workflows/00000000-0000-0000-0000-000000000000`, {
      headers: withAuth(h.token),
    });
    expect(r.status).toBe(404);
  });

  it("DELETE /api/workflows/:id returns 204 and removes the workflow", async () => {
    h = await newApiHarness();
    const created = (await (
      await h.fetch("/api/workflows", {
        method: "POST",
        headers: { ...withAuth(h.token), "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const del = await h.fetch(`/api/workflows/${created.id}`, {
      method: "DELETE",
      headers: withAuth(h.token),
    });
    expect(del.status).toBe(204);
    const after = await h.fetch(`/api/workflows/${created.id}`, { headers: withAuth(h.token) });
    expect(after.status).toBe(404);
  });

  it("auth: unauthorized requests get 401 (except /health)", async () => {
    h = await newApiHarness();
    const noToken = await h.fetch("/api/workflows");
    expect(noToken.status).toBe(401);
    const wrong = await h.fetch("/api/workflows", { headers: withAuth("WRONG") });
    expect(wrong.status).toBe(401);
    // /health is open
    expect((await h.fetch("/health")).status).toBe(200);
  });

  it("invalid POST body returns 400 with a structured error", async () => {
    h = await newApiHarness();
    const r = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: "not-json",
    });
    expect(r.status).toBe(400);
  });

  it("two concurrent harnesses don't see each other's workflows (per-test schema)", async () => {
    const h1 = await newApiHarness();
    const h2 = await newApiHarness();
    try {
      const create1 = (await (
        await h1.fetch("/api/workflows", {
          method: "POST",
          headers: { ...withAuth(h1.token), "content-type": "application/json" },
          body: JSON.stringify({ metadata: { name: "in-h1" } }),
        })
      ).json()) as { id: string };
      const probe = await h2.fetch(`/api/workflows/${create1.id}`, { headers: withAuth(h2.token) });
      expect(probe.status).toBe(404);
    } finally {
      await h1.dispose();
      await h2.dispose();
    }
  });
});
