# Flue Deep-Dive: CLI Shape and Deployment Abstractions

**Source:** `withastro/flue` (cloned shallow to `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/flue/`).
**Lens:** What can Thodare's `World` / Ports-and-Adapters layer steal from Flue's deploy story? Flue is an *agent harness* framework, not a workflow orchestrator, but its problem shape — "one user definition, many deploy targets" — is identical to what Thodare's `--target=cloudflare | lambda | postgres-self-host` story needs.

This is research only. No code changes.

---

## 1. CLI command shape

Three verbs, period: `dev`, `run`, `build`. There is **no** `flue init`, no `flue deploy`, no `flue login`. Source: the entire CLI lives in a single file, `packages/cli/bin/flue.ts:228-305`, which dispatches on those three commands and exits on anything else.

The verbs split cleanly along intent:

- **`flue dev`** (`bin/flue.ts:605-622`) — long-running watch-mode dev server. Rebuilds and reloads on file changes. The implementation lives in `packages/sdk/src/dev.ts:113-216`.
- **`flue run <agent>`** (`bin/flue.ts:624-727`) — one-shot, production-style: build → spawn server → POST → stream SSE → print final result to stdout → exit. Use for CI / scripted invocations. **Node-only.** Cloudflare gets a friendly "use `flue dev` instead" message at `bin/flue.ts:214-226`.
- **`flue build`** (`bin/flue.ts:590-603`) — produce a `dist/` deployable artifact (no run). Cloudflare and Node both supported. Implementation: `packages/sdk/src/build.ts:29-191`.

**Critically, there is no `flue deploy`.** Flue stops at producing a `dist/`. Deploying is delegated to whatever tool natively owns the target — `wrangler deploy` for Cloudflare, `node dist/server.mjs` for Node, a `Dockerfile` you write for Docker hosts. This is a deliberate choice and a key piece of taste worth stealing.

Help output (`bin/flue.ts:52-83`) is hand-written, ~30 lines, no library (no commander/yargs/clipanion). Flag parsing is a hand-rolled loop (`bin/flue.ts:124-208`) with explicit `--target`, `--workspace`, `--output`, `--port`, `--env`, `--id`, `--payload`. Flags-only — no sub-commands. Repeatable flags (e.g. `--env`) are handled inline.

The `--target` flag is the load-bearing axis: every command requires it (`bin/flue.ts:233-237, 248-252, 267-271`). There is no auto-detect for target. The user always types it.

## 2. Multi-target deployment

Two layers:

**Layer A — Build plugins (the adapter contract).** `packages/sdk/src/types.ts:441-469` defines a single TypeScript interface, `BuildPlugin`, with five members:

```ts
{
  name: string;
  generateEntryPoint(ctx: BuildContext): string | Promise<string>;
  bundle?: 'esbuild' | 'none';
  entryFilename?: string;                      // required if bundle === 'none'
  esbuildOptions?(ctx): Record<string, any>;
  additionalOutputs?(ctx): Record<string,string> | Promise<...>;
}
```

That's the entire contract. A plugin emits a string of TypeScript source for the runtime entry, optionally tweaks esbuild, and optionally produces side-files (e.g. `wrangler.jsonc`). The SDK then either runs esbuild itself (Node target, single bundle) or writes the entry verbatim and lets a downstream tool bundle it (Cloudflare target — wrangler does it).

**Layer B — Two built-in plugins.** `packages/sdk/src/build-plugin-node.ts` (`NodePlugin`) and `packages/sdk/src/build-plugin-cloudflare.ts` (`CloudflarePlugin`). They are picked by string in `packages/sdk/src/build.ts:193-214`, with a `plugin?: BuildPlugin` escape hatch on `BuildOptions` that lets a third-party plugin take over.

**Convention over config:** Agents are discovered by directory scan (`build.ts:260-276`), not declared in a manifest. Triggers are extracted by *regex* from the agent source — `build.ts:279-296` greps for `export const triggers = { webhook: true }` and `cron: '...'` literally. Cute, dangerous, fast. (See anti-patterns.)

The same agent definition compiles into very different runtime shapes:

- Node target: a Hono server emitted as a single bundled `dist/server.mjs` (`build-plugin-node.ts:48-281`).
- Cloudflare target: an unbundled `dist/_entry.ts` plus a per-webhook-agent Durable Object class, plus a merged `dist/wrangler.jsonc`, plus a deploy-redirect file at `.wrangler/deploy/config.json` (`build-plugin-cloudflare.ts:43-501`).

## 3. Configuration model

There is **no `flue.config.ts`**. Flue is aggressively config-light. Configuration sources, in order of precedence:

1. **CLI flags** (target, workspace, output, port, env-files).
2. **In-agent configuration** — model, sandbox, tools, role, persistence — passed to `init({...})` *inside the agent file itself* (`types.ts:158-202`). The same `AgentInit` shape works on every target.
3. **Per-target platform config** — Cloudflare reads the user's `wrangler.jsonc` from the project root (`cloudflare-wrangler-merge.ts:130-170`); Node reads `process.env`. Flue *merges into* the user's `wrangler.jsonc` rather than replacing it (`cloudflare-wrangler-merge.ts:325-415`).

The "you've selected target X, here's what's required for X" surface is *runtime errors with prose*. Examples:
- Pick `sandbox: 'local'` on Cloudflare → throw with a long message at `build-plugin-cloudflare.ts:159-166`.
- Pick `--target cloudflare` without `wrangler` installed → friendly `[flue] Cloudflare dev requires the "wrangler" package as a peer dependency...` (`dev.ts:570-577`).
- `wrangler.jsonc` has `compatibility_flags` but no `nodejs_compat` → throw at `cloudflare-wrangler-merge.ts:194-203`.
- `compatibility_date` too old → throw with the exact bump-to value (`cloudflare-wrangler-merge.ts:206-220`).

Per-target peer-dep gating is *not* declared anywhere — it's implicit in the lazy `await import('wrangler')` (`dev.ts:567-579`) and `await import('wrangler')` again in `cloudflare-wrangler-merge.ts:145-155`. The error message at the catch site does the work.

## 4. Detection / inference

Flue does very little auto-detection, and where it does, it's a *convention*, not a heuristic:

- **Workspace location** — `resolveWorkspaceFromCwd(cwd)` (`build.ts:229-234`) tries `./.flue/` then `./` and picks the first that has an `agents/` subdirectory. Two layouts only. No mixing. Documented out loud.
- **Sandbox-class detection** — `detectSandboxBindings(userConfig)` (`cloudflare-wrangler-merge.ts:486-500`) looks for any DO binding whose `class_name` *ends with* `Sandbox` and auto-emits `export { Sandbox as <name> } from '@cloudflare/sandbox';` in the generated entry. The suffix convention is the contract; a long comment explains exactly why suffix and not substring.
- **Agent discovery** — recursive scan of `agents/*.{ts,js,mts,mjs}` (`build.ts:260-276`).
- **Role discovery** — recursive scan of `roles/*.md` with frontmatter parsed (`build.ts:236-258`).
- **Externals** — read user's `package.json` deps and externalize them (so user-installed deps resolve at runtime, not bundle time): `build.ts:299-314`.
- **Migration tag computation** — `computeFlueMigrations()` (`cloudflare-wrangler-merge.ts:269-317`) walks the user's existing wrangler migrations to determine which DO classes are already declared, and emits **per-class tags** for net-new ones. The docstring is a lecture on why per-class (and not per-build) tagging is the only correct answer when migration tags are immutable. Worth reading in full.

What Flue does *not* auto-detect: the target. The user types `--target node` or `--target cloudflare` every single time. This is a feature.

## 5. Build vs. runtime split

Build time:
- Discover agents and roles.
- Parse triggers via regex (the only thing the build needs from agent source).
- Generate one DO class per webhook agent (Cloudflare) or one entry in a handler map (Node).
- Emit `dist/manifest.json` with the agent list (`build.ts:82-90`).
- For Cloudflare: read user's `wrangler.jsonc`, validate it, merge in Flue's contributions, write `dist/wrangler.jsonc`, write the deploy-redirect file.

Runtime:
- `AGENTS.md` and `.agents/skills/` are **discovered at runtime from session cwd** (`build.ts:76-77`). They are never bundled. Big deal: a coding agent in a Daytona sandbox discovers skills inside the Daytona container, not from the deploy bundle.
- Model selection is runtime only (no build-time model default — see `build-plugin-node.ts:96-98` and the matching Cloudflare comment).
- Sandbox selection is runtime only.
- Persistence store is runtime only — Cloudflare uses Durable Object SQLite (`build-plugin-cloudflare.ts:211-233`); Node uses an in-memory store unless the user provides one (`build-plugin-node.ts:131`).

The target-specific runtime shims are emitted as **string-templated TypeScript inside `generateEntryPoint`**. The Node entry imports `Hono`, `serve` from `@hono/node-server`, and `just-bash`'s `InMemoryFs` / `MountableFs` / `ReadWriteFs`. The Cloudflare entry imports from `agents`, `just-bash`, and re-exports `@cloudflare/sandbox`'s `Sandbox` class once per user-named binding. The user's agent file is `import`ed unmodified into both — its handler signature (`FlueContext` → result) is the portable contract.

## 6. Plugin / extension model

For **deploy targets**, the public-but-undocumented seam is `BuildOptions.plugin?: BuildPlugin` (`types.ts:485-488`). A third-party can construct a custom build plugin and pass it to `build()` directly. There is no plugin-discovery mechanism, no `flue.config.ts` hook, no `package.json` keyword. To be a deploy target today, you fork the CLI or call the SDK programmatically.

For **sandbox/runtime adapters** (the one Flue actually grew), the contract is `SandboxFactory` (`types.ts:363-366`):

```ts
interface SandboxFactory {
  createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
}
```

The Daytona connector (`packages/connectors/src/daytona.ts:115-152`) is the worked example. It takes a Daytona sandbox the user already created, wraps Daytona's filesystem/exec API in a class implementing `SandboxApi`, and returns a `SandboxFactory`. Lifecycle is opt-in via a `cleanup` option. This is a clean, minimal port adapter — exactly the pattern Thodare wants.

The split between "sandbox connectors" (a real plugin ecosystem at `@flue/connectors/*`) and "deploy plugins" (an internal interface with no ecosystem) is telling. The runtime port is generalized; the deploy port is not yet.

## 7. Error / validation surface

`packages/sdk/src/errors.ts:1-80` has a remarkable docstring that's worth reading verbatim if you write any error class in Thodare. The discipline:

- One file containing every error class (the "vocabulary"). Application code never constructs `FlueError` ad-hoc.
- Every error has three audience-classified strings: `message` (always shown), `details` (caller-safe, always shown), `dev` (developer-only, shown only when `FLUE_MODE=local`).
- Every error class owns its own `type` constant (snake_case wire identifier) and HTTP status code.
- Constructors take **structured input data**, never pre-formatted strings, so phrasing lives in one place.

Consequences for the deploy story specifically:

- Picking `--target cloudflare` without `wrangler` installed fails at the point of import with a friendly error that includes the install command (`dev.ts:567-577`).
- Selecting `sandbox: 'local'` from a Cloudflare-built agent fails at sandbox-resolution time with a multi-line error that lists the alternatives (`build-plugin-cloudflare.ts:159-166`).
- Wrangler config violations are caught at *build time* with surgical messages — exact field, exact required value, exact bump-to (`cloudflare-wrangler-merge.ts:191-220`).
- Missing `@cloudflare/sandbox` when the user declared a `*Sandbox` DO binding fails at build with `[flue] Your wrangler config declares DO binding(s)... Install it: \`npm install @cloudflare/sandbox\`` (`cloudflare-wrangler-merge.ts:514-549`).

The pattern: catch incompatible combinations *as early in the pipeline as possible* (build > start > first request) and explain the fix in the error itself.

## 8. Anti-patterns / things Thodare should avoid

- **Regex-parsing the agent source for `triggers`** (`build.ts:279-296`). Cute and fast, brittle and surprising. A user who writes `export const triggers = computeTriggers()` or splits the export across lines breaks the build invisibly. Thodare should pick either: (a) an exported config object the build *imports* (slower, correct), or (b) frontmatter / a sidecar YAML file. Don't grep TypeScript.
- **Two valid workspace layouts** (`./.flue/` and `./`, `build.ts:229-234`). Documented out loud, but every doc page now has a "drop the prefix if you prefer the root" caveat. One layout is better than two — pick the one that keeps Thodare definitions discoverable from the project root and stick with it.
- **No `flue.config.ts`** is a mostly-good choice but it cuts both ways: there is *nowhere* to declaratively register a custom build plugin or a custom sandbox factory at the project level. Third-party deploy targets have to be wired via SDK calls. If Thodare wants a real adapter ecosystem, it needs at least a `thodare.config.ts` for plugin registration, even if it stays empty for the common case.
- **`triggerless` agents are HTTP-invokable when `FLUE_MODE=local`** (`build-plugin-node.ts:84-90`). The seam for "let CI invoke a non-webhook agent over HTTP" is an env-var-controlled mode switch in production-shaped code. It works, but it's a foot-gun: forget to unset the var in a production container and your whole agent surface is exposed. Thodare should make this an explicit CLI mode (e.g. `thodare run` runs against a private socket, never an open port) rather than a runtime env flag.
- **`flue run` requires Node** (`bin/flue.ts:214-226`) because the one-shot invoker spawns the Node-built server. Cloudflare gets `flue dev` plus a `curl` example — fine for now, but it means CI agents and Cloudflare agents are not testable through the same command. Thodare's equivalent should make `thodare run --target=anything` work uniformly even if the implementation is target-specific.
- **No `flue init` / scaffolder**. Every doc starts with `npm init -y && npm install ...` and a hand-typed agent file. That's friction for first-time users. Thodare should ship `thodare init --target=<x>` that produces a minimal working project for the chosen target — including any platform config the target needs (e.g. a starter `wrangler.jsonc`).
- **Migrations array grows unboundedly** — one `flue-class-<agent>` tag per ever-existing agent (`cloudflare-wrangler-merge.ts:310-316`). Correct given Cloudflare's immutable-tag constraint, but the resulting `dist/wrangler.jsonc` will accumulate decades of dead tags for a long-lived project. Thodare's equivalent should plan for this from day one.
- **The Cloudflare path mutates the user's project** by writing `<outputDir>/.wrangler/deploy/config.json` (`cloudflare-wrangler-merge.ts:563-580`). Documented (`if (fs.existsSync(redirectPath)) return`), but still: a build command that writes a side-effect file outside `dist/` is surprising. Thodare should keep all generated artifacts under one explicit output directory.

---

## What Thodare can steal

1. **The three-verb CLI: `dev` / `run` / `build`. No `init`. No `deploy`.** Stop at the artifact. Let `wrangler deploy`, `aws lambda update-function-code`, `psql -f migrations/`, etc. own the actual ship. (Source: `bin/flue.ts:228-305`.) The exception is `init` — Flue's lack of one is documented friction; Thodare should add one.

2. **`--target=<x>` as the single load-bearing axis.** Required on every command, never inferred. Type discipline > magic. Accept that users will type the same flag a hundred times a day; it's the price of unambiguous deploys. (Source: `bin/flue.ts:149-159`.)

3. **A minimal `BuildPlugin` interface as the deploy adapter contract.** Five members: `name`, `generateEntryPoint`, `bundle: 'esbuild' | 'none' | 'passthrough'`, `entryFilename`, `additionalOutputs`. The plugin emits a TypeScript entry as a string and an optional bag of side-files. The SDK either bundles or hands off. (Source: `types.ts:441-469`, `build.ts:100-191`.) Thodare adds Postgres-self-host, Lambda, Rivet by writing one of these per target.

4. **Bundle-vs-passthrough as a first-class plugin choice.** Some targets (Lambda, Node) want a fully bundled artifact; others (Cloudflare with wrangler, Vercel with their CLI) want to hand the entry to the platform's own bundler so dev and deploy go through the same path. Build the abstraction with both in mind from day one. (Source: `build.ts:104-169` showing the two branches; `dev.ts:1-34` for the docstring on *why*.)

5. **Compose with the platform's native config file rather than replacing it.** Flue reads the user's `wrangler.jsonc`, validates it, merges its contributions in, and writes the composed result to `dist/wrangler.jsonc`. The user owns their config; Flue contributes the bits it owns (entrypoint, DO bindings, migrations) and passes everything else through. (Source: entirety of `cloudflare-wrangler-merge.ts`.) For Thodare: read the user's `serverless.yml` / `sam.yaml` / `pg-config.toml` / `rivet.json`, merge, write to `dist/`.

6. **A separate "runtime adapter" port (`SandboxFactory` in Flue, `World` in Thodare) with its own connector ecosystem.** Don't conflate "where it runs" (deploy plugin) with "what it runs against" (runtime adapter). Flue cleanly separates these and has a real `@flue/connectors` package for the runtime side; the deploy side stays as built-ins. Thodare's `World` already maps to this — keep it separate from the deploy plugins. (Source: `connectors/src/daytona.ts:115-152` for the connector pattern; `types.ts:363-366` for the contract.)

7. **Lazy peer-dependency imports with friendly catch-block errors.** `flue dev --target cloudflare` doesn't import wrangler unless you use it, and the catch block on the lazy import is where the "install wrangler" message lives. Same pattern for `@cloudflare/sandbox`. (Source: `dev.ts:561-579`, `cloudflare-wrangler-merge.ts:145-155`.) Thodare's `--target=postgres-self-host` should never make Cloudflare users install `pg`.

8. **A vocabulary of error classes in one file, with audience-classified prose.** `message` for end-users (always), `details` for the caller (always, never leaks framework internals), `dev` for the developer (gated on a mode flag). One-file vocabulary keeps tone, fix-ability, and granularity consistent. Errors carry their own HTTP status. Constructors take structured data only. (Source: the docstring at `errors.ts:1-80` is mandatory reading.)

9. **Validate target-incompatible config at build time, not run time.** Wrangler config missing `nodejs_compat`? Throw at build with the exact bump-to value. Picked a sandbox the target can't support? Throw at sandbox resolution with the alternatives enumerated. Each error names the user's exact next action. (Source: `cloudflare-wrangler-merge.ts:191-220`, `build-plugin-cloudflare.ts:159-166`.)

10. **Convention-driven detection over config explosion.** "Any DO binding whose `class_name` ends with `Sandbox` is auto-wired as `@cloudflare/sandbox`'s class" is a convention, not a config field. The docstring explains the suffix-vs-substring choice in detail. Pick one or two of these for Thodare (e.g. "any agent file under `workflows/` with an exported `runs_on` is wired up to that target") and document them as load-bearing conventions — not as inference. (Source: `cloudflare-wrangler-merge.ts:460-500`.)
