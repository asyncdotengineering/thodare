import type { CliDeps } from "../deps.js";

export async function token(args: { api: string }, deps: CliDeps): Promise<number> {
  const session = await deps.credentials.get(args.api);
  if (!session) {
    deps.stderr.write(`thodare: no credentials for ${args.api}. Run \`thodare login --api ${args.api}\`.\n`);
    return 1;
  }
  deps.stdout.write(`${session.apiKey}\n`);
  return 0;
}
