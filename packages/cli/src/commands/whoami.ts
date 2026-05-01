import type { CliDeps } from "../deps.js";

export async function whoami(args: { api: string }, deps: CliDeps): Promise<number> {
  const session = await deps.credentials.get(args.api);
  if (!session) {
    deps.stderr.write(`thodare: no credentials for ${args.api}\n`);
    return 1;
  }
  deps.stdout.write(
    `${session.userEmail}\n` +
    `org: ${session.organizationSlug} (${session.organizationId})\n` +
    `api: ${args.api}\n`,
  );
  return 0;
}
