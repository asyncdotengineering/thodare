/**
 * Command dispatch. `runCli(argv, deps)` parses argv, picks a command,
 * runs it, returns the exit code. The bin entry is a one-liner around
 * this; tests call it directly with injected `deps`.
 */

import { parseArgv } from "./parser.js";
import { HELP, VERSION } from "./help.js";
import type { CliDeps } from "./deps.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { token } from "./commands/token.js";
import { env } from "./commands/env.js";
import { whoami } from "./commands/whoami.js";
import { keyCreate, keyList, keyRevoke } from "./commands/key.js";

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed.version) {
    deps.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.help) {
    deps.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.command.length === 0) {
    deps.stdout.write(`${HELP}\n`);
    return 1;
  }

  const apiOverride = typeof parsed.flags["api"] === "string" ? (parsed.flags["api"] as string) : undefined;
  const api = apiOverride ?? process.env["THODARE_API"] ?? deps.defaultApi;

  const cmd = parsed.command.join(" ");
  switch (cmd) {
    case "login":   return login({ api, flags: parsed.flags }, deps);
    case "logout":  return logout({ api }, deps);
    case "token":   return token({ api }, deps);
    case "env":     return env({ api, flags: parsed.flags }, deps);
    case "whoami":  return whoami({ api }, deps);
    case "key create": return keyCreate({ api, flags: parsed.flags }, deps);
    case "key list":   return keyList({ api }, deps);
    case "key revoke": return keyRevoke({ api, positional: parsed.positional }, deps);
    default:
      deps.stderr.write(`thodare: unknown command "${cmd}". Run \`thodare --help\`.\n`);
      return 1;
  }
}
