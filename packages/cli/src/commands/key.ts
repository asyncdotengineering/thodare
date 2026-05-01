/**
 * `thodare key {create,list,revoke}` — parity with /api/auth/api-key/*.
 *
 * Auth: these admin routes require a real session (cookie or bearer
 * session token), NOT an API key — an API key cannot mint, list, or
 * revoke other API keys. We use the session cookie that `thodare login`
 * captured when it bootstrapped the credentials.
 *
 * If the cookie has expired, the user gets a clean re-login prompt.
 */

import type { CliDeps } from "../deps.js";

interface CreateArgs {
  api: string;
  flags: Record<string, string | boolean>;
}

interface RevokeArgs {
  api: string;
  positional: string[];
}

async function authedHeaders(args: { api: string }, deps: CliDeps): Promise<Record<string, string> | null> {
  const session = await deps.credentials.get(args.api);
  if (!session) {
    deps.stderr.write(`thodare: no credentials for ${args.api}. Run \`thodare login --api ${args.api}\`.\n`);
    return null;
  }
  if (!session.sessionCookie) {
    deps.stderr.write(
      `thodare: stored credentials don't have a session cookie. ` +
      `Run \`thodare login --api ${args.api}\` to refresh.\n`,
    );
    return null;
  }
  return {
    "content-type": "application/json",
    origin: args.api,
    cookie: session.sessionCookie,
  };
}

function isSessionExpired(status: number): boolean {
  return status === 401 || status === 403;
}

export async function keyCreate(args: CreateArgs, deps: CliDeps): Promise<number> {
  const headers = await authedHeaders(args, deps);
  if (!headers) return 1;
  const session = (await deps.credentials.get(args.api))!;
  const name = typeof args.flags["name"] === "string" ? (args.flags["name"] as string) : `cli-${Date.now().toString(36)}`;

  const r = await deps.fetch(`${args.api}/api/auth/api-key/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      configId: "default",
      name,
      organizationId: session.organizationId,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    if (isSessionExpired(r.status)) {
      deps.stderr.write(`thodare: session expired. Run \`thodare login --api ${args.api}\` to refresh.\n`);
      return 1;
    }
    deps.stderr.write(`key create: ${r.status} ${txt}\n`);
    return 1;
  }
  const body = (await r.json()) as { key?: string; id?: string; data?: { key: string; id: string } };
  const key = body.key ?? body.data?.key ?? "";
  const id = body.id ?? body.data?.id ?? "";
  if (!process.stdout.isTTY) {
    deps.stdout.write(JSON.stringify({ id, key, name }) + "\n");
  } else {
    deps.stdout.write(`${key}\n(name: ${name}, id: ${id})\nstore this — you won't see it again.\n`);
  }
  return 0;
}

export async function keyList(args: { api: string }, deps: CliDeps): Promise<number> {
  const headers = await authedHeaders(args, deps);
  if (!headers) return 1;
  const r = await deps.fetch(`${args.api}/api/auth/api-key/list`, {
    method: "GET",
    headers,
  });
  if (!r.ok) {
    const txt = await r.text();
    if (isSessionExpired(r.status)) {
      deps.stderr.write(`thodare: session expired. Run \`thodare login --api ${args.api}\` to refresh.\n`);
      return 1;
    }
    deps.stderr.write(`key list: ${r.status} ${txt}\n`);
    return 1;
  }
  const list = (await r.json()) as Array<{ id: string; name: string; createdAt: string; lastRequest: string | null; start: string | null }>;
  if (!process.stdout.isTTY) {
    deps.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return 0;
  }
  for (const k of list) {
    deps.stdout.write(`${k.id}\t${k.start ?? "-"}…\t${k.name}\t${k.createdAt}\t${k.lastRequest ?? "never"}\n`);
  }
  return 0;
}

export async function keyRevoke(args: RevokeArgs, deps: CliDeps): Promise<number> {
  // Validate args BEFORE auth (so missing-id is reported clearly).
  const id = args.positional[0];
  if (!id) {
    deps.stderr.write("key revoke: missing <key-id>\n");
    return 1;
  }
  const headers = await authedHeaders(args, deps);
  if (!headers) return 1;

  const r = await deps.fetch(`${args.api}/api/auth/api-key/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ keyId: id }),
  });
  if (!r.ok) {
    const txt = await r.text();
    if (isSessionExpired(r.status)) {
      deps.stderr.write(`thodare: session expired. Run \`thodare login --api ${args.api}\` to refresh.\n`);
      return 1;
    }
    deps.stderr.write(`key revoke: ${r.status} ${txt}\n`);
    return 1;
  }
  deps.stdout.write(`Revoked ${id}\n`);
  return 0;
}
