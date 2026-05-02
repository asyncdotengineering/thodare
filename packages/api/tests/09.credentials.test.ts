/**
 * T-09: Credential CRUD — encrypt-at-rest, cross-org isolation, soft delete,
 * end-to-end runtime injection through `/api/workflows/:id/run`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { defineConnector } from "@thodare/engine";
import { newApiHarness, withAuth, type ApiHarness } from "./_harness.js";

function masterKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

let h: ApiHarness;
afterEach(async () => { await h?.dispose(); });

describe("POST /api/credentials", () => {
  it("creates a credential and response excludes any secret material", async () => {
    const mk = masterKey();
    h = await newApiHarness({ credentialsMasterKey: mk });
    const r = await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "My API Key",
        secret: { apiKey: "sk-secret-value-12345" },
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.type).toBe("api-key");
    expect(body.displayName).toBe("My API Key");
    expect(body.id).toBeTypeOf("string");
    expect(body.secret).toBeUndefined();
    expect(body.encrypted_secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sk-secret-value-12345");
  });
});

describe("GET /api/credentials", () => {
  it("lists credentials without secret material", async () => {
    const mk = masterKey();
    h = await newApiHarness({ credentialsMasterKey: mk });
    await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "Key A",
        secret: { apiKey: "sk-a" },
      }),
    });
    const r = await h.fetch("/api/credentials", {
      headers: withAuth(h.token),
    });
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    const cred = list[0]!;
    expect(cred.secret).toBeUndefined();
    expect(cred.encrypted_secret).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("sk-a");
  });
});

describe("encrypt-at-rest", () => {
  it("encrypted_secret column contains encrypted bytes, not plaintext", async () => {
    const mk = masterKey();
    h = await newApiHarness({ credentialsMasterKey: mk });
    const r = await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "Encrypted Key",
        secret: { apiKey: "sk-plaintext-should-not-be-visible" },
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string };
    const credId = body.id;

    const sql = postgres(process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test", { max: 1 });
    try {
      const rows = (await sql.unsafe(
        `SELECT encrypted_secret FROM "${h.schema}".credentials WHERE id = $1`,
        [credId],
      )) as Array<{ encrypted_secret: Buffer }>;
      expect(rows.length).toBe(1);
      const encrypted = rows[0]!.encrypted_secret;
      expect(encrypted.length).toBeGreaterThan(0);
      const utf8 = encrypted.toString("utf8");
      expect(utf8).not.toContain("sk-plaintext-should-not-be-visible");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe("cross-org isolation", () => {
  it("user B cannot see user A's credential in their list", async () => {
    const mk = masterKey();
    h = await newApiHarness({ credentialsMasterKey: mk });
    const createR = await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "Org A Key",
        secret: { apiKey: "sk-org-a-secret" },
      }),
    });
    expect(createR.status).toBe(201);
    const aCred = (await createR.json()) as { id: string };

    const other = await h.createOtherTenant();
    expect(other.organizationId).not.toBe(h.organizationId);

    // User B's list MUST NOT include user A's credential, and the
    // serialized response MUST NOT contain user A's secret.
    const listR = await h.fetch("/api/credentials", {
      headers: withAuth(other.token),
    });
    expect(listR.status).toBe(200);
    const bodyText = await listR.text();
    expect(bodyText).not.toContain("sk-org-a-secret");
    expect(bodyText).not.toContain(aCred.id);

    const list = JSON.parse(bodyText) as Array<{ id: string }>;
    expect(list.find((c) => c.id === aCred.id)).toBeUndefined();
  });

  it("DELETE on another org's credential returns 404", async () => {
    const mk = masterKey();
    h = await newApiHarness({ credentialsMasterKey: mk });
    const createR = await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "Org A",
        secret: { apiKey: "sk-a" },
      }),
    });
    const aCred = (await createR.json()) as { id: string };

    const other = await h.createOtherTenant();
    const delR = await h.fetch(`/api/credentials/${aCred.id}`, {
      method: "DELETE",
      headers: withAuth(other.token),
    });
    expect(delR.status).toBe(404);
  });
});

describe("soft delete", () => {
  it("DELETE /api/credentials/:id returns 204; row remains with deleted_at set", async () => {
    const mk = masterKey();
    h = await newApiHarness({ credentialsMasterKey: mk });
    const r = await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "To Delete",
        secret: { apiKey: "sk-delete-me" },
      }),
    });
    const { id } = (await r.json()) as { id: string };

    const delR = await h.fetch(`/api/credentials/${id}`, {
      method: "DELETE",
      headers: withAuth(h.token),
    });
    expect(delR.status).toBe(204);

    const sql = postgres(process.env.WFKIT_DURABLE_PG_URL ?? "postgresql://localhost:5432/wfkit_durable_test", { max: 1 });
    try {
      const rows = (await sql.unsafe(
        `SELECT id, deleted_at FROM "${h.schema}".credentials WHERE id = $1`,
        [id],
      )) as Array<{ id: string; deleted_at: string | null }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.deleted_at).not.toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe("end-to-end credential injection through POST /api/workflows/:id/run", () => {
  it("organizationId plumbed through dispatch; ctx.credential populated; secret never appears in HTTP responses", async () => {
    let capturedCredential: { secret: Record<string, unknown> } | undefined;

    const credConnector = defineConnector({
      type: "cred-test-conn",
      credential: { required: true, type: "api-key" },
      params: z.object({}),
      outputs: z.object({ hasCred: z.boolean(), secretKeys: z.array(z.string()) }),
      async run(_params, ctx) {
        capturedCredential = ctx.credential
          ? { secret: ctx.credential.secret }
          : undefined;
        return {
          hasCred: ctx.credential !== undefined,
          secretKeys: ctx.credential ? Object.keys(ctx.credential.secret) : [],
        };
      },
    });

    const mk = masterKey();
    h = await newApiHarness({
      credentialsMasterKey: mk,
      connectors: [credConnector],
    });

    // 1. Create the credential via the API.
    const credR = await h.fetch("/api/credentials", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        type: "api-key",
        displayName: "Run Key",
        secret: { apiKey: "sk-runtime-injection-test" },
      }),
    });
    expect(credR.status).toBe(201);
    const credBody = (await credR.json()) as { id: string };
    expect(JSON.stringify(credBody)).not.toContain("sk-runtime-injection-test");

    // 2. Create a workflow that uses the connector and references the credential by id.
    const wfCreateR = await h.fetch("/api/workflows", {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(wfCreateR.status).toBe(201);
    const wf = (await wfCreateR.json()) as { id: string; version: number };

    // Patch the workflow with a single block of our credential-bound connector.
    const patchR = await h.fetch(`/api/workflows/${wf.id}/operations`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({
        ops: [
          {
            operation_type: "add",
            block_id: "cred-block",
            type: "cred-test-conn",
            params: { credentialId: credBody.id },
          },
        ],
      }),
    });
    expect(patchR.status).toBe(200);
    const patchBody = (await patchR.json()) as {
      ok: boolean;
      skipped_items?: Array<{ reason_code: string; reason: string }>;
    };
    expect(patchBody.ok).toBe(true);
    expect(patchBody.skipped_items ?? []).toEqual([]);

    // 3. Dispatch a run.
    const runR = await h.fetch(`/api/workflows/${wf.id}/run`, {
      method: "POST",
      headers: { ...withAuth(h.token), "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(runR.status).toBe(202);
    const runBody = (await runR.json()) as { runId: string };
    const runId = runBody.runId;

    // 4. Poll until completed.
    const deadline = Date.now() + 10_000;
    let runState: { state: string; output?: unknown } | undefined;
    while (Date.now() < deadline) {
      const pollR = await h.fetch(`/api/runs/${runId}`, { headers: withAuth(h.token) });
      if (pollR.ok) {
        runState = (await pollR.json()) as { state: string; output?: unknown };
        if (runState.state === "completed" || runState.state === "failed") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runState).toBeDefined();
    expect(runState!.state).toBe("completed");

    // 5. Verify the connector saw the decrypted credential.
    expect(capturedCredential).toBeDefined();
    expect(capturedCredential!.secret).toEqual({ apiKey: "sk-runtime-injection-test" });

    // 6. Verify no HTTP response from any of the calls leaked the secret.
    const allResponseTexts = [
      JSON.stringify(credBody),
      JSON.stringify(patchBody),
      JSON.stringify(runBody),
      JSON.stringify(runState),
    ];
    for (const text of allResponseTexts) {
      expect(text).not.toContain("sk-runtime-injection-test");
    }
  }, 30_000);
});
