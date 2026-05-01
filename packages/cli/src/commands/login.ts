/**
 * `thodare login` — full bootstrap. Sign in (or sign up), make sure
 * the user has at least one organization, set it active, mint an API
 * key, save credentials.
 *
 * Designed to be friction-free for first-time use:
 *
 *   - Tries sign-in first; falls back to sign-up if the account doesn't
 *     exist (and the operator confirms in interactive mode).
 *   - Auto-creates `<email-prefix>-org` if the user has no orgs.
 *   - Re-running with the same credentials works idempotently — same
 *     org, new API key.
 */

import type { CliDeps } from "../deps.js";
import type { SessionRecord } from "../credentials.js";

interface LoginArgs {
  api: string;
  flags: Record<string, string | boolean>;
}

export async function login(args: LoginArgs, deps: CliDeps): Promise<number> {
  const interactive = args.flags["non-interactive"] !== true;

  let email = typeof args.flags["email"] === "string" ? args.flags["email"] as string : "";
  let password = typeof args.flags["password"] === "string" ? args.flags["password"] as string : "";
  const orgName = typeof args.flags["org-name"] === "string" ? (args.flags["org-name"] as string) : undefined;

  if (!email && interactive) email = (await deps.prompt("Email: ")).trim();
  if (!password && interactive) password = await deps.prompt("Password: ", { mask: true });

  if (!email || !password) {
    deps.stderr.write("login: --email and --password are required in non-interactive mode\n");
    return 1;
  }

  const headers = {
    "content-type": "application/json",
    origin: args.api,
  };

  // 1. Try sign-in.
  let sessionCookie = "";
  let userId = "";
  let signedUp = false;

  const signInRes = await deps.fetch(`${args.api}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });

  if (signInRes.ok) {
    const body = (await signInRes.json()) as { user?: { id: string } };
    userId = body.user?.id ?? "";
    sessionCookie = extractCookie(signInRes);
  } else if (signInRes.status === 401 || signInRes.status === 400 || signInRes.status === 404) {
    // Account doesn't exist (or wrong password). Try sign-up.
    if (interactive) {
      const ans = (await deps.prompt(`No account for ${email}. Create one? [Y/n]: `)).trim().toLowerCase();
      if (ans === "n" || ans === "no") {
        deps.stderr.write("login: aborted\n");
        return 1;
      }
    }
    const signUpRes = await deps.fetch(`${args.api}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password, name: email.split("@")[0] ?? "user" }),
    });
    if (!signUpRes.ok) {
      const txt = await signUpRes.text();
      deps.stderr.write(`login: sign-up failed (${signUpRes.status}): ${txt}\n`);
      return 1;
    }
    const body = (await signUpRes.json()) as { user?: { id: string } };
    userId = body.user?.id ?? "";
    sessionCookie = extractCookie(signUpRes);
    signedUp = true;
  } else {
    const txt = await signInRes.text();
    deps.stderr.write(`login: sign-in failed (${signInRes.status}): ${txt}\n`);
    return 1;
  }

  if (!sessionCookie || !userId) {
    deps.stderr.write("login: server did not return a session\n");
    return 1;
  }

  const authedHeaders = { ...headers, cookie: sessionCookie };

  // 2. Make sure the user has an organization.
  let organizationId = "";
  let organizationSlug = "";

  const listRes = await deps.fetch(`${args.api}/api/auth/organization/list`, {
    method: "GET",
    headers: authedHeaders,
  });
  if (listRes.ok) {
    const orgs = (await listRes.json()) as Array<{ id: string; slug: string }>;
    if (Array.isArray(orgs) && orgs.length > 0) {
      organizationId = orgs[0]!.id;
      organizationSlug = orgs[0]!.slug;
    }
  }

  if (!organizationId) {
    const slug = orgName ?? `${email.split("@")[0]}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const createRes = await deps.fetch(`${args.api}/api/auth/organization/create`, {
      method: "POST",
      headers: authedHeaders,
      body: JSON.stringify({ name: orgName ?? `${email.split("@")[0]}'s workspace`, slug }),
    });
    if (!createRes.ok) {
      const txt = await createRes.text();
      deps.stderr.write(`login: organization/create failed (${createRes.status}): ${txt}\n`);
      return 1;
    }
    const orgBody = (await createRes.json()) as { id?: string; slug?: string; data?: { id: string; slug: string } };
    organizationId = orgBody.id ?? orgBody.data?.id ?? "";
    organizationSlug = orgBody.slug ?? orgBody.data?.slug ?? slug;
  }

  // 3. Set as active.
  const setActiveRes = await deps.fetch(`${args.api}/api/auth/organization/set-active`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({ organizationId }),
  });
  if (!setActiveRes.ok) {
    const txt = await setActiveRes.text();
    deps.stderr.write(`login: organization/set-active failed (${setActiveRes.status}): ${txt}\n`);
    return 1;
  }

  // 4. Mint an API key.
  const keyRes = await deps.fetch(`${args.api}/api/auth/api-key/create`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({
      configId: "default",
      name: `cli@${hostnameSafe(deps)}`,
      organizationId,
    }),
  });
  if (!keyRes.ok) {
    const txt = await keyRes.text();
    deps.stderr.write(`login: api-key/create failed (${keyRes.status}): ${txt}\n`);
    return 1;
  }
  const keyBody = (await keyRes.json()) as { key?: string; id?: string; data?: { key: string; id: string } };
  const apiKey = keyBody.key ?? keyBody.data?.key ?? "";
  const apiKeyId = keyBody.id ?? keyBody.data?.id ?? "";
  if (!apiKey || !apiKeyId) {
    deps.stderr.write("login: server did not return an api key\n");
    return 1;
  }

  // 5. Save credentials.
  const session: SessionRecord = {
    userId,
    userEmail: email,
    organizationId,
    organizationSlug,
    apiKey,
    apiKeyId,
    sessionCookie,
    createdAt: deps.now().toISOString(),
  };
  await deps.credentials.put(args.api, session);

  deps.stdout.write(
    `${signedUp ? "Signed up" : "Signed in"} as ${email}\n` +
    `Active org: ${organizationSlug} (${organizationId})\n` +
    `API key: ${apiKey} (saved to ${deps.credentials.path})\n` +
    `\n` +
    `Try it:\n` +
    `  curl -H "Authorization: Bearer ${apiKey}" ${args.api}/api/connectors\n`,
  );
  return 0;
}

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw
    .split(",")
    .map((s) => s.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

function hostnameSafe(_: CliDeps): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os");
    const h = String(os.hostname?.() ?? "host").replace(/[^A-Za-z0-9-]/g, "-").slice(0, 24);
    return h || "host";
  } catch {
    return "host";
  }
}
