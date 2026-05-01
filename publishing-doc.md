# Publishing — internal notes

Step-by-step for cutting a release of any `@thodare/*` package.
This file is internal — not on the docs site.

## What ships, what doesn't

| Package | Published? | Tarball includes |
|---|---|---|
| `@thodare/openworkflow` | ✅ public | `dist/`, `README.md`, `LICENSE.md`, `UPSTREAM.md`, `CHANGELOG.md` |
| `@thodare/engine` | ✅ public | `dist/`, `README.md`, `LEARNINGS.md`, `ARCHITECTURE.md`, `THREAT-MODEL.md` |
| `@thodare/api` | ✅ public | `dist/`, `README.md` |
| `@thodare/cli` | ✅ public | `dist/`, `README.md` |
| `@thodare/docs` | ❌ private | (this is the docs site, not a library) |
| `@thodare-examples/*` | ❌ private | (private workspaces, never published) |

Each publishable package's `files` field is the allowlist. No `*.map`,
no source `*.ts`, no test files.

## Pre-flight checklist

Before any release:

- [ ] `pnpm test` clean (209+ tests).
- [ ] `pnpm -r run build` clean (every publishable package emits dist/).
- [ ] `find packages/*/dist examples/*/dist -name '*.map'` returns empty.
- [ ] No uncommitted changes (`git status` clean).
- [ ] Working on `main` (or a release branch).
- [ ] All Changesets present and complete (`.changeset/*.md`).

## Cutting a release

```sh
# 1. Compute new versions from accumulated Changesets.
pnpm changeset version
# - Bumps each affected package's version.
# - Writes/updates each package's CHANGELOG.md.
# - Consumes the .changeset/*.md files.

# 2. Review the diff. Check version bumps make sense + CHANGELOG reads cleanly.
git diff

# 3. Commit the version bumps.
git add -A
git commit -m "release: cut versions"

# 4. Build everything.
pnpm -r run build

# 5. Publish in dependency order. Pnpm + Changesets handle workspace:* substitution.
pnpm changeset publish

# 6. Push the release commit + tags.
git push origin main --follow-tags
```

## Manual publish (single package)

When you only want to ship one package and skip the changeset machinery:

```sh
# Bump manually in packages/<pkg>/package.json
# Then:
pnpm --filter @thodare/<pkg> run build
pnpm publish --filter @thodare/<pkg> --no-git-checks --access public

# Tag manually
git tag -a "@thodare/<pkg>@<version>" -m "@thodare/<pkg> <version> — <summary>"
git push origin "@thodare/<pkg>@<version>"
```

## Workspace deps at publish time

Every internal dep uses `workspace:*` in source. At publish time pnpm
+ Changesets rewrites it to the actual version (e.g., `^0.1.0`). This
means:

- ✅ Local dev resolves `@thodare/engine` to the workspace package.
- ✅ Published consumers get the proper semver range.
- ❌ Don't try to publish a package that depends on an unpublished
  workspace package.

If you bump `@thodare/engine` and `@thodare/api` together, publish
engine first, then api. Changesets does this automatically when run
via `pnpm changeset publish`.

## First-time scope setup

Already done; record for posterity:

```sh
npm org create thodare        # if not already
npm access list packages @thodare    # confirm membership
```

The asyncdotengineering org owns `@thodare` on npm. Maintainers
need org membership + `npm login`.

## Pre-flight verification

For a paranoid release:

```sh
# Pack each publishable package and inspect the tarball.
pnpm pack --filter @thodare/engine
tar -tzf thodare-engine-*.tgz
# Confirm: dist/* (.js + .d.ts), README, LEARNINGS, ARCHITECTURE, THREAT-MODEL.
# No .map, no .ts source files (.d.ts is fine).
rm thodare-engine-*.tgz
```

## Post-publish

- `npm view @thodare/<pkg>` confirms registry has the new version.
- Verify `npm install -g @thodare/cli` (or the relevant package) on a
  clean machine.
- Update the docs site if any user-facing route changed.
- If breaking change shipped: issue a release note pointing at the
  upgrade-guide doc.

## Rolling back

You can't unpublish from npm after 72 hours. Within that window:
`npm unpublish @thodare/<pkg>@<version>`. After: ship a patch release
that fixes whatever was wrong. `npm deprecate @thodare/<pkg>@<bad>`
flags the broken version.

## CI/CD (future)

Currently we publish manually. The setup for automated publish:

1. CI on PR merge runs `changeset version` against the merge.
2. Opens a "Version Packages" PR with the bumps.
3. Merging that PR triggers `changeset publish`.

Standard Changesets flow; we'll wire it up with a GitHub Action when
the release cadence picks up.

## Security

If a published package contains a secret or vulnerability:

1. Don't unpublish; that breaks downstream users.
2. Patch immediately; `npm publish` the fix.
3. `npm deprecate @thodare/<pkg>@<bad-version> "Security: upgrade to <new>"`.
4. File a security advisory on the GitHub repo.
5. Email security@thodare.dev to coordinate disclosure.
