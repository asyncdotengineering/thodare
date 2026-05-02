/**
 * Postgres-backed credential store, scoped by `organization_id`.
 *
 * Every read and write requires an organization id; cross-org reads are
 * structurally impossible (queries always include `organization_id = $`).
 *
 * Secrets are AES-256-GCM-encrypted at rest with a per-org-derived key.
 * The encrypted_secret column is a bytea blob: iv(12) || authTag(16) || ciphertext.
 * The public surface (get, list) NEVER returns any form of secret.
 * Only getDecrypted (internal, runtime-host-only) returns the decrypted secret.
 *
 * Schema (per-API-instance, lives in `${schema}.credentials`):
 *
 *   id              uuid PK
 *   organization_id text NOT NULL
 *   type            text NOT NULL
 *   display_name    text NOT NULL
 *   properties      jsonb NOT NULL DEFAULT '{}'
 *   scopes          text[] NULL
 *   encrypted_secret bytea NOT NULL
 *   created_at      timestamptz NOT NULL DEFAULT now()
 *   updated_at      timestamptz NOT NULL DEFAULT now()
 *   last_used_at    timestamptz NULL
 *   deleted_at      timestamptz NULL
 */

import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import {
  deriveOrgKey,
  encryptSecret,
  decryptSecret,
  packEncrypted,
  unpackEncrypted,
} from "@thodare/engine";

export interface CredentialRow {
  id: string;
  organizationId: string;
  type: string;
  displayName: string;
  properties: Record<string, unknown>;
  scopes: string[] | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export interface CredentialCreateInput {
  type: string;
  displayName: string;
  properties?: Record<string, unknown>;
  scopes?: string[];
  secret: Record<string, unknown>;
}

export interface CredentialStore {
  init: () => Promise<void>;
  create: (organizationId: string, input: CredentialCreateInput, masterKey: Uint8Array) => Promise<CredentialRow>;
  get: (organizationId: string, id: string) => Promise<CredentialRow | null>;
  getDecrypted: (organizationId: string, id: string, masterKey: Uint8Array) => Promise<(CredentialRow & { secret: Record<string, unknown> }) | null>;
  list: (organizationId: string, opts?: { type?: string }) => Promise<CredentialRow[]>;
  remove: (organizationId: string, id: string) => Promise<boolean>;
  updateLastUsedAt: (organizationId: string, id: string) => Promise<void>;
  dispose: () => Promise<void>;
}

const SAFE_SCHEMA = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function createCredentialsStore(opts: {
  pgUrl: string;
  schema: string;
}): CredentialStore {
  if (!SAFE_SCHEMA.test(opts.schema)) {
    throw new Error(`unsafe schema name: ${opts.schema}`);
  }
  const sql: Sql = postgres(opts.pgUrl, { max: 4 });
  const q = (s: string) => `"${opts.schema}".${s}`;

  function rowFromDb(r: {
    id: string;
    organization_id: string;
    type: string;
    display_name: string;
    properties: unknown;
    scopes: string[] | null;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
  }): CredentialRow {
    return {
      id: r.id,
      organizationId: r.organization_id,
      type: r.type,
      displayName: r.display_name,
      properties: (typeof r.properties === "string" ? JSON.parse(r.properties) : r.properties) as Record<string, unknown>,
      scopes: r.scopes,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
    };
  }

  return {
    async init() {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${q("credentials")} (
          id              uuid PRIMARY KEY,
          organization_id text NOT NULL,
          type            text NOT NULL,
          display_name    text NOT NULL,
          properties      jsonb NOT NULL DEFAULT '{}',
          scopes          text[] NULL,
          encrypted_secret bytea NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          last_used_at    timestamptz NULL,
          deleted_at      timestamptz NULL
        )
      `);
      await sql.unsafe(
        `CREATE INDEX IF NOT EXISTS credentials_org_id_idx ON ${q("credentials")} (organization_id) WHERE deleted_at IS NULL`,
      );
    },

    async create(organizationId, input, masterKey) {
      const id = randomUUID();
      const orgKey = deriveOrgKey(masterKey, organizationId);
      const plaintext = JSON.stringify(input.secret);
      const encrypted = packEncrypted(encryptSecret(orgKey, plaintext));
      await sql.unsafe(
        `INSERT INTO ${q("credentials")} (id, organization_id, type, display_name, properties, scopes, encrypted_secret)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [id, organizationId, input.type, input.displayName, JSON.stringify(input.properties ?? {}), input.scopes ?? null, encrypted],
      );
      return {
        id,
        organizationId,
        type: input.type,
        displayName: input.displayName,
        properties: input.properties ?? {},
        scopes: input.scopes ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUsedAt: null,
      };
    },

    async get(organizationId, id) {
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, type, display_name, properties, scopes, created_at, updated_at, last_used_at
         FROM ${q("credentials")} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [id, organizationId],
      )) as Array<{
        id: string; organization_id: string; type: string; display_name: string;
        properties: unknown; scopes: string[] | null; created_at: string;
        updated_at: string; last_used_at: string | null;
      }>;
      const row = rows[0];
      if (!row) return null;
      return rowFromDb(row);
    },

    async getDecrypted(organizationId, id, masterKey) {
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, type, display_name, properties, scopes, encrypted_secret, created_at, updated_at, last_used_at
         FROM ${q("credentials")} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [id, organizationId],
      )) as Array<{
        id: string; organization_id: string; type: string; display_name: string;
        properties: unknown; scopes: string[] | null; encrypted_secret: Buffer;
        created_at: string; updated_at: string; last_used_at: string | null;
      }>;
      const row = rows[0];
      if (!row) return null;
      const orgKey = deriveOrgKey(masterKey, organizationId);
      const unpacked = unpackEncrypted(row.encrypted_secret);
      const plaintext = decryptSecret(orgKey, unpacked);
      const secret = JSON.parse(plaintext) as Record<string, unknown>;
      return { ...rowFromDb(row), secret };
    },

    async list(organizationId, opts) {
      const typeFilter = opts?.type ? `AND type = $2` : "";
      const params: string[] = opts?.type ? [organizationId, opts.type] : [organizationId];
      const rows = (await sql.unsafe(
        `SELECT id, organization_id, type, display_name, properties, scopes, created_at, updated_at, last_used_at
         FROM ${q("credentials")} WHERE organization_id = $1 ${typeFilter} AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        params,
      )) as Array<{
        id: string; organization_id: string; type: string; display_name: string;
        properties: unknown; scopes: string[] | null; created_at: string;
        updated_at: string; last_used_at: string | null;
      }>;
      return rows.map(rowFromDb);
    },

    async remove(organizationId, id) {
      const r = (await sql.unsafe(
        `UPDATE ${q("credentials")} SET deleted_at = now() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING id`,
        [id, organizationId],
      )) as Array<{ id: string }>;
      return r.length > 0;
    },

    async updateLastUsedAt(organizationId, id) {
      await sql.unsafe(
        `UPDATE ${q("credentials")} SET last_used_at = now() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [id, organizationId],
      ).catch(() => {});
    },

    async dispose() {
      try { await sql.end({ timeout: 5 }); } catch {}
    },
  };
}
