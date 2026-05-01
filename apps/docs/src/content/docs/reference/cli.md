---
title: CLI commands
description: "Every `thodare` verb at a glance."
---

```sh
thodare login | logout | token | env | whoami
        | key create | key list | key revoke
        | --version | --help
```

## `login`

```sh
thodare login [--api <url>] [--email <e>] [--password <p>] [--non-interactive]
              [--org-name <n>]
```

Sign in or sign up. Auto-creates a personal org (server-side via
`databaseHooks.user.create.after`). Mints an API key. Saves
credentials to `~/.thodare/credentials.json` (or `$THODARE_CREDENTIALS`).

## `logout`

```sh
thodare logout [--api <url>]
```

Removes the local credentials for the active API. Does NOT revoke
remote sessions or keys.

## `token`

```sh
thodare token [--api <url>]
```

Prints the API key on stdout. Pipe-friendly:

```sh
curl -H "Authorization: Bearer $(thodare token)" $URL/api/connectors
```

## `env`

```sh
thodare env [--api <url>] [--shell sh|fish|powershell]
```

Prints shell exports for `THODARE_API_KEY` + `THODARE_API`. Default
shell is `sh`. Eval to set in current session:

```sh
eval "$(thodare env)"
```

## `whoami`

```sh
thodare whoami [--api <url>]
```

Prints user email + active org slug + API URL.

## `key create`

```sh
thodare key create [--name <n>] [--api <url>]
```

Mints a new API key tied to the active org. Prints the raw `thd_…`
ONCE; store it. JSON output when stdout isn't a TTY (for scripting).

## `key list`

```sh
thodare key list [--api <url>]
```

Lists keys for the active org. Raw values are not in the response —
only `id`, `name`, `start` (first 6 chars), `createdAt`, `lastRequest`.

## `key revoke`

```sh
thodare key revoke <key-id> [--api <url>]
```

Revokes the key. Effective on next request.

## Global flags

| Flag | Default | Purpose |
|---|---|---|
| `--api <url>` | `$THODARE_API` then `https://api.thodare.dev` | Which API instance. |
| `--version`, `-v` | — | Print version. |
| `--help`, `-h` | — | Print help. |

## Credentials file

`~/.thodare/credentials.json` (or `$THODARE_CREDENTIALS`). Permissions:
`0600` on POSIX. Multi-API support: the file carries credentials for
multiple `@thodare/api` instances (local-dev, staging, prod) — `--api`
selects which.

```jsonc
{
  "default": "https://api.thodare.dev",
  "sessions": {
    "https://api.thodare.dev": {
      "userId": "…",
      "userEmail": "you@…",
      "organizationId": "…",
      "organizationSlug": "personal-…",
      "apiKey": "thd_…",
      "apiKeyId": "…",
      "sessionCookie": "better-auth.session_token=…",
      "createdAt": "2026-05-02T…"
    }
  }
}
```

The session cookie is stored alongside the API key because
`/api/auth/api-key/*` admin routes require a session (an API key
cannot mint other API keys).
