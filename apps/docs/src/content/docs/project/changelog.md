---
title: Changelog
description: "Per-package release history."
---

We use [Changesets](https://github.com/changesets/changesets) — every
PR carries a `.changeset/*.md` file describing the change at the
right semver level. Run `pnpm changeset` to add one.

Per-package changelogs live alongside each package:

- [`@thodare/engine`](https://github.com/asyncdotengineering/thodare/blob/main/packages/engine/CHANGELOG.md)
- [`@thodare/api`](https://github.com/asyncdotengineering/thodare/blob/main/packages/api/CHANGELOG.md)
- [`@thodare/cli`](https://github.com/asyncdotengineering/thodare/blob/main/packages/cli/CHANGELOG.md)
- [`@thodare/openworkflow`](https://github.com/asyncdotengineering/thodare/blob/main/packages/openworkflow/CHANGELOG.md)

## Highlights

### `@thodare/api@0.1.1`

- **Auto-create personal org on signup.** A first-time user no longer
  hits `401 no_active_organization` on their first protected request.
- **Persistent schedule claim.** `last_fired_at` column +
  `SELECT … FOR UPDATE`. Multi-process tickers can't double-fire.
- **First-run admin bootstrap.** `THODARE_BOOTSTRAP=1` + signed
  one-time `/api/bootstrap?token=…` link. Self-disables.

### `@thodare/engine@0.1.0` and `@thodare/api@0.1.0`

- Initial release as Thodare. Connector DSL, EditOp patch surface,
  durable runtime via vendored openworkflow, better-auth +
  organizations + apiKey.

### `@thodare/cli@0.1.0`

- Initial release. `login / token / env / whoami / logout / key {create,list,revoke}`.

## Versioning

Each package versions independently. A patch on `@thodare/api` does
not roll forward `@thodare/engine`. The `workspace:*` references in
each package.json get rewritten to actual versions at publish time.

To add a Changeset:

```sh
pnpm changeset
# select packages, level (patch/minor/major), summary
```

To compute versions from accumulated changesets:

```sh
pnpm changeset version    # bumps package.json + writes CHANGELOG.md
```

To publish:

```sh
pnpm changeset publish    # runs prepublishOnly (build), then npm publish
```
