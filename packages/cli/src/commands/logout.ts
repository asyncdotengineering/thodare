import type { CliDeps } from "../deps.js";

export async function logout(args: { api: string }, deps: CliDeps): Promise<number> {
  const had = await deps.credentials.remove(args.api);
  if (had) {
    deps.stdout.write(`Removed credentials for ${args.api}\n`);
    return 0;
  }
  deps.stderr.write(`No credentials found for ${args.api}\n`);
  return 1;
}
