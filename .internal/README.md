# `.internal/` — for the next session

This directory holds engineering-internal artifacts that aren't part
of the public package surface but are essential for continuity across
sessions (Claude Code, contractors, contributors).

**Start here:**

- 👉 [`HANDOFF.md`](./HANDOFF.md) — the load-bearing handoff document. Read this first.
- [`../SPEC.md`](../SPEC.md) — v0 spec; the 19 locked decisions T1–T19. Constitution.
- [`../publishing-doc.md`](../publishing-doc.md) — release runbook.
- [`../NOTICE`](../NOTICE) — vendored-component attributions (Apache-2.0 obligations).
- [`../rfcs/`](../rfcs/) — design decisions per feature.

**What this directory is for:**

- Cross-session memory ("here's where we left off")
- Tribal knowledge that doesn't fit in the public docs
- Decision logs that postdate `SPEC.md`
- Drafts of internal proposals before they become RFCs

**What this directory is NOT for:**

- Secrets, tokens, credentials (use env vars)
- User data
- Anything that should be in public docs (move to `apps/docs/`)

The directory is committed to the public repo — if you write something
here, assume it will be read by a contributor on day one.
