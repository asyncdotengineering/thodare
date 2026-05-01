export const VERSION = "0.1.0";

export const HELP = `thodare ${VERSION} — command-line client for @thodare/api

USAGE
  thodare <command> [...flags]

COMMANDS
  login                            Sign in or sign up; create personal org if needed; mint API key.
  logout                           Remove the local credentials for the active API.
  token                            Print the current API key.
  env [--shell sh|fish|powershell] Print shell exports for THODARE_API_KEY + THODARE_API.
  whoami                           Print the current user + active organization.
  key create [--name <n>]          Mint a new API key.
  key list                         List API keys for the active organization.
  key revoke <key-id>              Revoke an API key by id.

GLOBAL FLAGS
  --api <url>                      Base URL of the @thodare/api instance.
                                   Default: \$THODARE_API or https://api.thodare.dev.
  --version, -v                    Print version.
  --help, -h                       Print this help.

EXAMPLES
  thodare login --api http://localhost:3000
  curl -H "Authorization: Bearer \$(thodare token)" \\
       \$(thodare env --shell sh | grep THODARE_API= | cut -d= -f2)/api/workflows
`;
