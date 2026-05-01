---
title: Why we vendor openworkflow
description: "The reasoning behind shipping @thodare/openworkflow as a fork."
---

## The decision

`@thodare/openworkflow` is a vendored fork of
[openworkflow](https://github.com/openworkflowdev/openworkflow), kept
in `packages/openworkflow/` in our monorepo. We did not write it;
openworkflow is Apache-2.0 and the original source files match
upstream byte-for-byte. We just package it under our scope.

## Why fork

1. **Version pinning.** The Thodare control plane has tight
   integration points (the `wfkit-runtime` workflow walks JSON
   dynamically). Pinning a specific upstream revision protects us
   from breaking changes during alpha.

2. **Patch capability.** When we hit a bug or need a Thodare-specific
   extension (e.g., extra metadata persisted on `step_attempts` for
   LLM observability), we can ship the fix immediately rather than
   wait on upstream review cycles.

3. **Brand surface.** Consumers of `@thodare/api` install one scope:
   `@thodare/*`. Mixing scopes (`openworkflow` + `@thodare/engine`)
   adds cognitive load when reading lockfiles and security scans.

## What we did NOT change

The initial vendor preserves upstream verbatim apart from packaging:

- `package.json` renamed to `@thodare/openworkflow`. Repo URLs updated.
  Contributors field credits upstream and our scope.
- `UPSTREAM.md` added (the relationship doc).
- `README.md` preserves upstream's content with a one-paragraph
  Thodare-context preface.

**No source-file changes** from upstream. We use the same
`@tsconfig/strictest` + `@tsconfig/node22` extends that upstream uses,
so source compiles unchanged. If we add patches in the future, each
is documented in `UPSTREAM.md` with a one-line summary and a commit
link.

## Apache-2.0 obligations

- ✅ Original `LICENSE.md` included verbatim alongside source.
- ✅ `NOTICE` at the repo root documents the relationship and any modifications.
- ✅ Original copyright headers preserved.
- ✅ Modifications, when made, will be clearly marked.

## When upstream releases

We evaluate, sync changes (or cherry-pick), bump our version, document
the sync in `CHANGELOG.md` under "Synced from upstream openworkflow
vX.Y.Z". The intent is to track upstream closely — fork distance
should stay near zero unless we have a specific patch.

## Star openworkflow

If you use Thodare in production, **please star
[openworkflowdev/openworkflow](https://github.com/openworkflowdev/openworkflow)**.
Maintaining a durable-execution framework is hard work that very few
people get right; the project deserves the recognition.

## Implementation

The vendored package:
[`packages/openworkflow/`](https://github.com/asyncdotengineering/thodare/tree/main/packages/openworkflow).

The relationship doc:
[`UPSTREAM.md`](https://github.com/asyncdotengineering/thodare/blob/main/packages/openworkflow/UPSTREAM.md).

The repo NOTICE:
[`NOTICE`](https://github.com/asyncdotengineering/thodare/blob/main/NOTICE).
