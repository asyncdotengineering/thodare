# Thodare research — Backend abstraction (May 2026)

> Research artifacts for the planned Thodare **Backend** / Ports-and-Adapters layer. Authored 2026-05-02 in one extended research session. Purpose: give the next session enough context + cited research to open the RFC at `rfcs/backend-abstraction/` without re-deriving the same ground.

## Read order

If you read nothing else, read [`backend-abstraction-proposal.md`](./backend-abstraction-proposal.md). It's the load-bearing artifact; everything else is supporting evidence.

For the full context dive:

1. **[`backend-abstraction-proposal.md`](./backend-abstraction-proposal.md)** — the proposal. Vision, interface design, adapter roster, migration path, success metrics, open decisions. ~5k words.
2. **[`_scratch-interface-design.md`](./_scratch-interface-design.md)** — three interface alternatives sketched + the openworkflow coupling map (which files import what). The proposal's §3 picks Alternative B; this file shows the others.
3. **[`durable-engines-survey.md`](./durable-engines-survey.md)** — comparative survey of Inngest / Hatchet / Trigger.dev / Temporal / Cloudflare Workflows / DBOS / Quirrel + Vercel WDK (terse). State substrate, exec model, serverless story, DX, pluggability, what to copy / what to avoid. ~4500 words.
4. **[`cloudflare-as-world.md`](./cloudflare-as-world.md)** — primitive-by-primitive feasibility for a Cloudflare adapter (Workflows, Queues, DO, D1). Three viable shapes ranked by complexity/fidelity, with pricing math at 10M runs/day. **Important:** the May 2026 `cloudflare/dynamic-workflows` library substantially improves Option A's economics — see proposal §4.3 for the updated read.
5. **[`flue-deep-dive.md`](./flue-deep-dive.md)** — Astro Flue's CLI shape + `BuildPlugin` interface + multi-target deploy. Source of the "no `thodare deploy`, ship `build` only" recommendation in proposal §6.
6. **[`rivet-deep-dive.md`](./rivet-deep-dive.md)** — Rivet's actor / workflow-engine / queue split. Source of the **convergence finding** (proposal §1) — Thodare T5, CF dynamic-workflows, and Rivet's `@rivetkit/workflow-engine` independently arrived at the same architectural pattern.

## External clones referenced

Sibling directories of `thodare/` in `agent-control-panel/`. Cloned shallow during this session:

| Repo | Path | License | Why |
|---|---|---|---|
| `vercel/workflow` | `../../workflow/` | Apache-2.0 | The WDK source — read for the Backend contract pattern; closest peer to where Thodare wants to go |
| `vercel/workflow-examples` | `../../workflow-examples/` | (per-package) | All 14 examples; primitives demo + custom adapter pattern (Bun) |
| `vercel-labs/workflow-builder-template` | `../../workflow-builder-template/` | Apache-2.0 | React Flow canvas + plugin registry — feeds the separate `next-up.md:211` builder-UI spike |
| `cloudflare/dynamic-workflows` | `../../dynamic-workflows/` | MIT | ~300 LOC pattern that makes the CF adapter affordable at scale (proposal §4.3) |
| `withastro/flue` | `../../flue/` | (check repo) | CLI + deploy ergonomics |
| `rivet-gg/rivet` | `../../rivet/` | Apache-2.0 | Actor/workflow primitives + `@rivetkit/workflow-engine`'s `EngineDriver` interface |

## What's *not* in this folder (and shouldn't be)

- The RFC itself. That belongs at `rfcs/backend-abstraction/README.md`. This proposal is its source material, not a substitute.
- Code. The maintainer asked for "the way forward, not code." Implementation patterns are sketched at the level of "what's the shape and what's the impedance mismatch," not at the level of "here's the file."
- A decision. Three open decisions are listed in the proposal §9; the maintainer picks before opening the RFC.

## Status

- [x] Rivet research
- [x] Flue research
- [x] Cloudflare-as-Backend research
- [x] Durable engines survey
- [x] Thodare openworkflow coupling map
- [x] Three-alternative interface design
- [x] Synthesized proposal
- [x] This index

Total: 1 proposal + 5 research files + 1 index. ~30k words across the six markdown documents in this folder.
