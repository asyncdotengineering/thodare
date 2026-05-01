/**
 * Credentials store at `~/.thodare/credentials.json`. Atomic writes
 * (write-temp + rename) and POSIX 0o600 permissions to keep keys away
 * from other processes running as the same user.
 *
 * Multi-API support: the file is keyed by API base URL, so the same
 * machine can hold credentials for local-dev, staging, and prod
 * simultaneously.
 */

import { mkdir, readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { randomUUID } from "node:crypto";

export interface SessionRecord {
  userId: string;
  userEmail: string;
  organizationId: string;
  organizationSlug: string;
  apiKey: string;
  apiKeyId: string;
  /**
   * better-auth session cookie. Required for `/api/auth/api-key/*`
   * admin routes (create / list / revoke), which only accept a real
   * session — an API key cannot mint, list, or revoke other API keys.
   * Cookie expires per the auth instance's session policy (default 7d
   * sliding). When it expires, the CLI prompts a re-login.
   */
  sessionCookie?: string;
  createdAt: string;
}

export interface CredentialsFile {
  /** The default API URL when `--api` is omitted. */
  default: string;
  /** Per-API session records keyed by base URL. */
  sessions: Record<string, SessionRecord>;
}

const EMPTY: CredentialsFile = { default: "", sessions: {} };

export interface CredentialsStore {
  read: () => Promise<CredentialsFile>;
  write: (file: CredentialsFile) => Promise<void>;
  /** Get the session for `api`, or null if none. */
  get: (api: string) => Promise<SessionRecord | null>;
  /** Replace/insert the session for `api`; updates `default` if file is empty. */
  put: (api: string, session: SessionRecord) => Promise<void>;
  /** Remove the session for `api`. Returns true if it existed. */
  remove: (api: string) => Promise<boolean>;
  /** Filesystem path of the credentials file. */
  path: string;
}

export function createCredentialsStore(opts: { path?: string } = {}): CredentialsStore {
  const path = opts.path ?? defaultPath();

  const read = async (): Promise<CredentialsFile> => {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
      return {
        default: parsed.default ?? "",
        sessions: parsed.sessions ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, sessions: {} };
      throw err;
    }
  };

  const write = async (file: CredentialsFile): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmp, path);
    if (platform() !== "win32") {
      try { await chmod(path, 0o600); } catch {}
    }
  };

  return {
    path,
    read,
    write,
    async get(api) {
      const f = await read();
      return f.sessions[api] ?? null;
    },
    async put(api, session) {
      const f = await read();
      f.sessions[api] = session;
      if (!f.default) f.default = api;
      await write(f);
    },
    async remove(api) {
      const f = await read();
      const had = api in f.sessions;
      delete f.sessions[api];
      if (f.default === api) {
        const remaining = Object.keys(f.sessions);
        f.default = remaining[0] ?? "";
      }
      if (Object.keys(f.sessions).length === 0) {
        try { await unlink(path); } catch {}
      } else {
        await write(f);
      }
      return had;
    },
  };
}

function defaultPath(): string {
  const override = process.env["THODARE_CREDENTIALS"];
  if (override) return override;
  return join(homedir(), ".thodare", "credentials.json");
}
