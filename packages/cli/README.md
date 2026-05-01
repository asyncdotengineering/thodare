# @thodare/cli

Command-line client for [`@thodare/api`](../api). Collapses the curl + cookie + origin-header
chain in the docs quickstart into one command.

## Install

```sh
pnpm add -g @thodare/cli
# or
npm install -g @thodare/cli
```

## Quickstart

```sh
thodare login --api http://localhost:3000
# → Email: you@example.com
# → Password: ********
# → Signed up as you@example.com
# → Active org: you-7f2k (org_xxxx)
# → API key: thd_… (saved to ~/.thodare/credentials.json)

curl -H "Authorization: Bearer $(thodare token)" http://localhost:3000/api/connectors
```

## Commands

| Command | Purpose |
|---|---|
| `thodare login [--api <url>] [--email <e>] [--password <p>] [--non-interactive]` | Sign in or sign up; auto-create personal org if needed; mint API key. |
| `thodare logout [--api <url>]` | Remove the local credentials for an API. |
| `thodare token [--api <url>]` | Print the API key on stdout. |
| `thodare env [--shell sh\|fish\|powershell]` | Print shell exports for `THODARE_API_KEY` + `THODARE_API`. |
| `thodare whoami [--api <url>]` | Print user + active org. |
| `thodare key create [--name <n>]` | Mint a new API key. |
| `thodare key list` | List keys for the active org. |
| `thodare key revoke <key-id>` | Revoke a key. |

`--api` defaults to `$THODARE_API`, then `https://api.thodare.dev`. The CLI carries credentials
for multiple API instances (local-dev, staging, prod) in one file — `--api` selects which.

## Credentials

Stored at `~/.thodare/credentials.json` (or `$THODARE_CREDENTIALS`). Permissions are
`0600` on POSIX. Two things live in this file: the API key (used for `Authorization: Bearer`)
and the better-auth session cookie (used by the `key` admin commands — those routes need a real
session, not just an API key).

## Programmatic

```ts
import { runCli } from "@thodare/cli";

const code = await runCli(process.argv.slice(2), {
  fetch,
  prompt: defaultPrompt(),
  credentials: createCredentialsStore(),
  stdout: process.stdout,
  stderr: process.stderr,
  defaultApi: "https://api.thodare.dev",
  now: () => new Date(),
});
process.exit(code);
```

`runCli` is dependency-injected — every external resource (`fetch`, `prompt`, credentials store,
stdio) is replaceable. The integration tests exercise the full CLI surface against a real
`@thodare/api` instance booted in-process.

## Tests

```sh
pnpm --filter @thodare/cli test
# 36 tests, ~9s
```

Six suites: parser, credentials store, run-dispatch, login (E2E), token/env/whoami/logout,
and `key` (E2E). All API tests use the same `newApiHarness` pattern as `@thodare/api`'s suite —
fresh Postgres schema per test, dropped on teardown.
