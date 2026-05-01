import type { CliDeps } from "../deps.js";

interface EnvArgs {
  api: string;
  flags: Record<string, string | boolean>;
}

type Shell = "sh" | "fish" | "powershell";

export async function env(args: EnvArgs, deps: CliDeps): Promise<number> {
  const session = await deps.credentials.get(args.api);
  if (!session) {
    deps.stderr.write(`thodare: no credentials for ${args.api}. Run \`thodare login --api ${args.api}\`.\n`);
    return 1;
  }
  const shellFlag = typeof args.flags["shell"] === "string" ? (args.flags["shell"] as Shell) : "sh";
  const shell: Shell = (["sh", "fish", "powershell"] as const).includes(shellFlag)
    ? shellFlag as Shell
    : "sh";

  const lines = render(shell, args.api, session.apiKey);
  deps.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function render(shell: Shell, api: string, key: string): string[] {
  switch (shell) {
    case "fish":
      return [`set -x THODARE_API_KEY ${shellQuote(key)}`, `set -x THODARE_API ${shellQuote(api)}`];
    case "powershell":
      return [`$Env:THODARE_API_KEY = ${psQuote(key)}`, `$Env:THODARE_API = ${psQuote(api)}`];
    case "sh":
    default:
      return [`export THODARE_API_KEY=${shellQuote(key)}`, `export THODARE_API=${shellQuote(api)}`];
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function psQuote(s: string): string {
  return `"${s.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}
