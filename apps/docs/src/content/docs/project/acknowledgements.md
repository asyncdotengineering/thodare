---
title: Acknowledgements
description: "Thodare stands on others' work."
---

## openworkflow

[**openworkflow**](https://github.com/openworkflowdev/openworkflow)
([Apache-2.0](https://github.com/openworkflowdev/openworkflow/blob/main/LICENSE))
is the durable-execution substrate underneath every Thodare run.
Every step is one `step.run()` call against openworkflow's worker;
replay determinism, crash recovery, and signal-driven waits are *its*
contributions, not ours. We're a thin DSL + control-plane layer on
top.

We vendor it as `@thodare/openworkflow` for version pinning and patch
capability — see
[Why we vendor openworkflow](/thodare/explanation/vendor-openworkflow/).

If you use Thodare, please star openworkflow too.

## Standards we lean on

- **Hono.** The HTTP framework. Tiny, fast, runs on every JS runtime.
  [hono.dev](https://hono.dev).
- **better-auth.** The auth library. Plugin architecture, organization
  + apiKey out of the box. [better-auth.com](https://www.better-auth.com).
- **Zod.** Schemas everywhere; the LLM-facing surface couldn't exist
  without it. [zod.dev](https://zod.dev).
- **Astro + Starlight.** This documentation site.
- **Diataxis.** This site's structural discipline. [diataxis.fr](https://diataxis.fr).
- **Changesets.** Per-package versioning + changelog.
- **`@tsconfig/strictest`.** The TypeScript strictness baseline.

## License

Thodare workspace: [MIT](https://github.com/asyncdotengineering/thodare/blob/main/LICENSE).

Vendored components retain their original licenses; see
[NOTICE](https://github.com/asyncdotengineering/thodare/blob/main/NOTICE).
