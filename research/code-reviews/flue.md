# Flue Code Review (Round 2) — `BuildPlugin`, dev server, errors, merge

A second deep, source-level pass over `withastro/flue` for Thodare's World abstraction. Scope: every gap the first agent left — full `BuildPlugin` interface, dev server internals, error vocabulary, merge-don't-replace algorithm, env-var foot-gun, two-workspace-layout anti-pattern, the hand-rolled flag parser, and the `additionalOutputs` mechanism. Every claim is cited file:line.

Repo path: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/flue/`.

---

## 1. Repo Map

This is a small, focused pnpm workspace. From `pnpm-workspace.yaml`: `packages/*, examples/*, apps/*`.

- **`packages/sdk/`** (`@flue/sdk`, v0.3.6, Apache-2.0) — the entire build system, dev server, error framework, agent runtime, and platform plugins. 26 source files. This is where ~95% of Flue lives.
  - `src/types.ts` — every public TS interface (lines 1–489), including the `BuildPlugin` contract (lines 441–469).
  - `src/build.ts` — the `build()` orchestrator (lines 29–191), workspace resolution (`resolveWorkspaceFromCwd`, lines 229–234), agent discovery (lines 260–276), trigger parsing via regex (lines 279–296).
  - `src/dev.ts` — the `dev()` long-running watch server (lines 113–216), `Rebuilder` (lines 235–284), `createWatcher` (lines 315–392), `NodeReloader` (lines 396–540), `CloudflareReloader` (lines 582–819), and the env-file helpers `resolveEnvFiles`/`parseEnvFiles` (lines 830–860).
  - `src/build-plugin-node.ts` — `NodePlugin` (lines 4–295). Generates a Hono server, esbuild-bundles to `dist/server.mjs`.
  - `src/build-plugin-cloudflare.ts` — `CloudflarePlugin` (lines 16–620). Generates an unbundled `_entry.ts`, hands bundling to wrangler.
  - `src/cloudflare-wrangler-merge.ts` — the `wrangler.jsonc` merge-don't-replace algorithm (lines 1–581). Single most lift-worthy file in the repo.
  - `src/errors.ts` — the error *vocabulary* (lines 1–333). Concrete subclasses, audience-split prose convention.
  - `src/error-utils.ts` — the error *framework* (renderers, type guard, request parsing) (lines 1–319).
  - `src/internal.ts` — the bare-specifier surface that generated entry-points import (lines 1–69). Not public API.
  - `src/client.ts`, `src/agent.ts`, `src/session.ts`, `src/agent-client.ts`, `src/sandbox.ts`, `src/context.ts`, `src/result.ts`, `src/roles.ts`, `src/session-history.ts`, `src/compaction.ts`, `src/mcp.ts`, `src/command-helpers.ts`, `src/env-utils.ts` — agent runtime: sandbox plumbing, sessions, role parsing, MCP tool adapter, compaction. Out of scope for this review except where they touch the build/dev/error surfaces.
  - `src/cloudflare/` (`virtual-sandbox.ts`, `cf-sandbox.ts`, `session-store.ts`, `context.ts`, `index.ts`, `define-command.ts`) — Cloudflare-only runtime helpers re-exported via the `@flue/sdk/cloudflare` subpath.
  - `src/node/index.ts`, `src/node/define-command.ts` — Node-only runtime helpers (`@flue/sdk/node`).
- **`packages/cli/`** (`@flue/cli`, v0.3.6) — the CLI binary. One source file: `bin/flue.ts` (753 lines). Hand-rolled flag parser, SSE consumer, server lifecycle. Sole runtime dep is `@flue/sdk` (workspace).
- **`packages/connectors/`** — third-party sandbox wrappers. Today: only `src/daytona.ts`. Out of scope.
- **`apps/www/`** — the docs/marketing site (Astro). Out of scope.
- **`examples/hello-world/`** — 11 demo agents under `.flue/agents/` exercising every SDK feature (`hello.ts`, `with-role.ts`, `with-skill.ts`, `with-tools.ts`, `with-commands.ts`, `with-agent-commands.ts`, `with-sandbox.ts`, `child-session.ts`, `session-test.ts`, `fs-test.ts`, `compaction-test.ts`). Plus one role (`.flue/roles/greeter.md`) and one skill (`.agents/skills/greet/SKILL.md`).
- **`examples/assistant/`** — Cloudflare-targeted example with `wrangler.jsonc` + `Dockerfile` + `AGENTS.md`. The reference for the `Sandbox` DO binding pattern (see §5).
- **`docs/`** — four deploy guides: `deploy-cloudflare.md`, `deploy-node.md`, `deploy-github-actions.md`, `deploy-gitlab-ci.md`. No tutorial-style or reference docs; the format is "deploy to X."
- **`AGENTS.md`** at the repo root — the contributor entry point.
- **No `tests/` directory anywhere.** Confirmed: `find ... -name "*.test.*" -o -name "*.spec.*"` returns zero results across `packages/` and `examples/`. The only "tests" are the example agents in `examples/hello-world/.flue/agents/` (e.g. `compaction-test.ts`, `session-test.ts`, `fs-test.ts`), and `session-test.ts` (lines 1–49) is explicit about it: *"This is a multi-invocation test … This is a pain to test, so only run this as a test if you need the extra level of confidence."* See §7 for the test-pattern discussion.

The build tooling is `tsdown` (an esbuild-based bundler). `packages/sdk/tsdown.config.ts` declares six entry points (`index`, `client`, `sandbox`, `internal`, `cloudflare/index`, `node/index`) and externalizes `wrangler` (the heavy peer dep) — Flue users targeting only Node never resolve it.

---

## 2. The `BuildPlugin` Interface

Verbatim, from `packages/sdk/src/types.ts:441–469`:

```ts
/**
 * Controls the build output format for a target platform.
 *
 * A plugin can either ship a fully-bundled JavaScript artifact (Node target)
 * or hand over a TypeScript/ESM entry source that some downstream tool will
 * bundle (Cloudflare target — wrangler does the bundling). Pre-bundling on
 * top of a tool that bundles for itself causes subtle resolution conflicts
 * (we hit this with `tar`/`fs`/etc. via `nodejs_compat`), so the Cloudflare
 * path explicitly opts out.
 */
export interface BuildPlugin {
  name: string;
  /**
   * The source of the entry point (TS or JS). May be async — the Cloudflare
   * plugin reads the user's wrangler config (via wrangler's reader) which is
   * a sync call but lives behind a lazy `await import('wrangler')`.
   */
  generateEntryPoint(ctx: BuildContext): string | Promise<string>;
  /**
   * Bundling strategy:
   *   - `'esbuild'` (default): run the SDK's esbuild pass to produce a
   *     bundled `dist/server.mjs`. Use when the deploy target is "just run
   *     this file" with no further bundling step.
   *   - `'none'`: skip esbuild. The entry is written as-is to `dist/` and
   *     becomes the input for whatever tool will deploy it (e.g. wrangler).
   *     The plugin must also implement `entryFilename` to set the file name.
   */
  bundle?: 'esbuild' | 'none';
  /**
   * The filename to use for the entry, written under `dist/`. Required when
   * `bundle === 'none'`. For `bundle === 'esbuild'` the output is always
   * `server.mjs` and this field is ignored.
   */
  entryFilename?: string;
  /** esbuild options. Only consulted when `bundle === 'esbuild'`. */
  esbuildOptions?(ctx: BuildContext): Record<string, any>;
  /** Additional files to write to dist/ (e.g., wrangler.jsonc, Dockerfile). May be async. */
  additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
}
```

And the supporting `BuildContext` (types.ts:421–429):

```ts
export interface BuildContext {
  agents: AgentInfo[];
  roles: Record<string, Role>;
  /** The workspace root: the directory directly containing agents/ and roles/. */
  workspaceDir: string;
  /** Where dist/ is written. Typically the project root, independent of workspaceDir. */
  outputDir: string;
  options: BuildOptions;
}
```

Method-by-method semantics:

### `name: string`
Plugin identifier. Logged at the start of every build (build.ts:37). No uniqueness enforcement — Flue's first-party set is `'node'` and `'cloudflare'`, hard-coded in `resolvePlugin` (build.ts:204–213).

### `generateEntryPoint(ctx) → string | Promise<string>`
Returns the entry-point source as a TS/JS string. Either inlines all routing logic (Node — emits a Hono server) or imports the platform shim and re-exports DO classes (Cloudflare — emits an `Agent` subclass per webhook agent). The output is written to `dist/_entry_server.ts` (esbuild path, build.ts:107) or `dist/<entryFilename>` (none path, build.ts:153) and is the **single source of truth for the deployed artifact's behavior**. Async because the Cloudflare plugin lazy-imports wrangler to read the user's config (build-plugin-cloudflare.ts:36–41, 96).

### `bundle?: 'esbuild' | 'none'` (default `'esbuild'`)
**`'esbuild'`** (Node): the SDK's own esbuild pass runs over the entry, externalizing the user's direct deps and bundling Flue's runtime infra into `dist/server.mjs`. Fully self-contained — `node dist/server.mjs` Just Works. Code path: build.ts:104–144.

**`'none'`** (Cloudflare): skip esbuild entirely. The entry source is written as-is to `dist/<entryFilename>` (the file becomes input for an *external* bundler, in this case wrangler's). Code path: build.ts:145–169.

The README (line 354) confirms verbatim: *"For Cloudflare, `flue build` produces an unbundled TypeScript entry that `wrangler deploy` bundles itself — the same path `flue dev --target cloudflare` uses. Dev and deploy go through the same bundler, so what works in dev will work in production."*

The motivation is in the `BuildPlugin` JSDoc itself (types.ts:432–440) and again in `CloudflarePlugin.bundle`'s comment (build-plugin-cloudflare.ts:18–24): *"Pre-bundling caused subtle resolution conflicts with `nodejs_compat` (e.g. `tar` package using bare `fs`/`zlib`/`assert` imports). Letting wrangler be the only bundler in the chain eliminates that whole category of problem and makes our dev/deploy paths identical."*

### `entryFilename?: string`
Only relevant for `bundle: 'none'`. Required there — `build.ts:148–151` throws otherwise: *"Plugin "<name>" set bundle: 'none' but did not provide entryFilename."* For `'esbuild'`, output is hardcoded `server.mjs` and this field is ignored.

### `esbuildOptions?(ctx) → Record<string, any>`
Only consulted on the esbuild path. Returns a partial esbuild config that's spread onto Flue's defaults (build.ts:113–133). Notably, the plugin's `external` array is appended to the user-deps externals, not replaced (build.ts:114). NodePlugin uses this to set `platform: 'node'`, `target: 'node22'`, and externalize two native addons (`node-liblzma`, `@mongodb-js/zstd`) used by `just-bash`'s archive code under try/catch (build-plugin-node.ts:284–293).

### `additionalOutputs?(ctx) → Record<string, string> | Promise<...>`
Returns a `{ filename: content }` map, all relative to `dist/`. Build.ts:171–187 writes each file, creating directories as needed. **Critically: byte-equality check before writing** — if the file already exists with identical content, skip the write entirely so downstream watchers don't see spurious mtime updates. This is the exact mechanic that lets Cloudflare's wrangler not redundantly hot-reload on agent body edits (see §4).

This is the only escape hatch for "I need to put more than one file in `dist/`." The Cloudflare plugin uses it for the merged `wrangler.jsonc` (build-plugin-cloudflare.ts:585). Could also emit a Dockerfile (the comment at build-plugin-cloudflare.ts:587–589 mentions this used to happen, but Flue stopped — users now provide their own).

### Per-build instance discipline
`resolvePlugin` (build.ts:193–214) constructs a *fresh* plugin instance per build. The CloudflarePlugin uses this to scope a `userConfigCache` to a single build (build-plugin-cloudflare.ts:34–41). A `BuildPlugin` is short-lived; long-lived state (like a watcher) belongs in the dev server, not the plugin.

---

## 3. CLI Dispatch — Every Verb, Every Flag

The entire CLI is `packages/cli/bin/flue.ts:1–753`. One file. Zero deps beyond `@flue/sdk` (and Node built-ins).

### Verbs

Three: `dev`, `run`, `build`. Dispatched at lines 731–752:

```ts
const args = parseArgs(process.argv.slice(2));
// signal handling …
if (args.command === 'build') buildCommand(args);
else if (args.command === 'dev') devCommand(args);
else run(args);
```

`parseArgs` (lines 228–305) is a switch-on-first-arg that calls `parseFlags` for the rest. Anything that isn't `build`, `dev`, or `run <agent>` falls through to `printUsage(); process.exit(1)`.

**No `init`. No `deploy`.** That's not an oversight — see §9 ("anti-features") and §1's note on deploy docs.

### Flag parser (~85 LoC, hand-rolled)

`parseFlags` is at flue.ts:124–208. The shape is one `for` loop, one `arg` per iteration, hand-coded `if/else if` per flag:

```ts
for (let i = 0; i < flags.length; i++) {
  const arg = flags[i];
  if (arg === '--payload') {
    payload = flags[++i] ?? '';
    if (!payload) { console.error('Missing value for --payload'); process.exit(1); }
  } else if (arg === '--target') {
    const targetFlag = flags[++i];
    if (!targetFlag) { console.error('Missing value for --target'); process.exit(1); }
    if (targetFlag !== 'node' && targetFlag !== 'cloudflare') {
      console.error(`Invalid target: "${targetFlag}". Supported targets: node, cloudflare`);
      process.exit(1);
    }
    target = targetFlag;
  } else if (arg === '--id') { ... }
  else if (arg === '--workspace') { ... }
  else if (arg === '--output') { ... }
  else if (arg === '--port') { ... }
  else if (arg === '--env') { ... }
  else { console.error(`Unknown argument: ${arg}`); printUsage(); process.exit(1); }
}
```

Every recognized flag has a uniform shape: read next arg (`++i`), check non-empty, validate (for `--target`, the literal-set check; for `--port`, `parseInt`/`isNaN`), assign. `--env` is the only repeatable flag (`envFiles.push(value)`). At return time (lines 199–207), `--workspace` and `--output` are normalized via `path.resolve()` *only if explicit*, and `--port` defaults to `0` (sentinel for "ask the SDK").

There's no library. No `commander`, no `yargs`, no `meow`. The cost: ~85 LoC of hand-coded loop, plus per-verb required-flag checks in `parseArgs`. The benefit: zero dependency surface in the CLI, zero implicit coercion, every error message is hand-written for that exact failure mode.

### Per-verb dispatch graph

**`flue build`** (parseArgs:231–244, buildCommand:590–603):
- Required: `--target` (validated to `'node' | 'cloudflare'` at parse time).
- Optional: `--workspace`, `--output`.
- Calls `build({ workspaceDir, outputDir, target })`. Catches and prints, exit 1.

**`flue dev`** (parseArgs:246–261, devCommand:605–622):
- Required: `--target`.
- Optional: `--workspace`, `--output`, `--port`, repeatable `--env`.
- Calls `dev({ workspaceDir, outputDir, target, port: args.port || undefined, envFiles })`. The `args.port || undefined` (line 615) preserves the SDK's own `DEFAULT_DEV_PORT` (3583, dev.ts:72) when `--port` isn't passed.

**`flue run <agent>`** (parseArgs:263–301, run:624–727):
- Positional: `<agent>` (lines 263–264).
- Required: `--target` and `--id`.
- Validation: `--target cloudflare` is rejected with `printCloudflareRunUnsupported` (lines 214–226), which prints a friendly hint to use `flue dev --target cloudflare` plus a curl example. `--payload` defaults to `'{}'` and is JSON-validated at parse time (lines 279–284).
- Build → pick port → spawn server → wait for `/health` → fetch manifest → POST to `/agents/<agent>/<id>` over SSE → render events → exit. Full flow at lines 624–727.

### Workspace and output resolution

`resolveWorkspaceDir` (flue.ts:23–38): if `--workspace` was passed, trust it. Otherwise call the SDK's `resolveWorkspaceFromCwd(cwd)` which checks `./.flue/` first, else `./agents/`, else null. On null: print a helpful error showing both candidate paths and exit 1.

`resolveOutputDir` (flue.ts:46–48): trivially `explicitOutput ?? process.cwd()`. The comment at lines 41–45 explains the deliberate split: *"Independent of the workspace so the built artifact and platform config (e.g. wrangler.jsonc) land where the deploy tool expects."* Concretely: on the `.flue/` layout, the workspace is `.flue/` but `wrangler.jsonc` belongs at the project root.

### SSE event renderer

`logEvent` (flue.ts:320–416) handles the streaming event types: `agent_start`, `text_delta` (with line-buffering through `flushTextBuffer`), `tool_start` (with per-tool argument formatting at lines 340–352 — `bash`/`read`/`write`/`edit`/`grep`/`glob` each get a custom one-line summary), `tool_end`, `turn_end`, `compaction_start`/`end`, `idle`, `error`, `result`. Errors render the canonical envelope (`[type] message` + indented `details` + indented `dev`) — see §6.

### `consumeSSE` and pre-stream-error handling

`consumeSSE` (flue.ts:418–520) is a manual SSE parser (split on `\n\n`, peel `data: ` prefix, JSON.parse). The interesting bit is at lines 433–462: when the response is `!ok` (HTTP 4xx/5xx, before any SSE bytes flow), the CLI parses the body as JSON and pretty-prints the canonical Flue error envelope. If parsing fails (proxy/CDN injected text/plain), it falls back to the raw body. *"A non-Flue upstream (CDN, load balancer, proxy) might intercept the request and return text/plain or some other shape."* This is the discipline that makes the error system actually work end-to-end — see §6.

### Server child process

`startServer` (flue.ts:524–544) sets `FLUE_MODE=local` for the spawned child (line 542). This is the foot-gun discussed in §7.

---

## 4. The Dev Server — Two Different Reload Models

`packages/sdk/src/dev.ts` (917 lines). Documented end to end in the file's leading JSDoc (lines 1–34).

### High-level shape

`dev()` (lines 113–216) is the entry point. Steps:

1. Resolve env files (lines 121, must exist or throw).
2. Build once (lines 137–144). If the initial build fails, throw; the dev server doesn't start.
3. Construct a `DevReloader` — `NodeReloader` or `CloudflareReloader` — based on target (lines 146–149).
4. Start the reloader (line 151), print URL + sample curl.
5. Construct a `Rebuilder` (line 165) and a `Watcher` (lines 167–178) wired together.
6. Install signal handlers (lines 199–212), then block forever (line 215).

The `DevReloader` interface (lines 79–103) is the abstraction:

- `start(): Promise<void>` — initial server bring-up.
- `shouldRebuildOn(relPath): boolean` — *the reloader decides whether a given file change matters.* Node returns true for every non-ignored path; Cloudflare returns true only for *structural* changes.
- `reload(buildChanged: boolean): Promise<void>` — post-rebuild action. The flag is "did this build write any new bytes to dist/?" Cloudflare uses it to skip restarts on no-op rebuilds.
- `stop(): Promise<void>` — clean shutdown.
- `killSync?(): void` — synchronous best-effort kill, called from `process.on('exit')` as a last-resort.

### The `Rebuilder` (debounce + coalesce)

`createRebuilder` (lines 235–284). State: `running`, `queued`, `queuedForce`, `pendingForce`, `debounceTimer`. 150ms debounce window (line 281). Invariants:

- Multiple `schedule()` calls inside the debounce window collapse into a single rebuild.
- If a rebuild is already running, exactly one follow-up is queued (further calls coalesce).
- `forceReload` "stickies" — if any call inside the window passed `true`, the resulting reload is forced. This is how env-file edits trigger a worker restart on Cloudflare even though the build itself is unchanged (lines 222–233).

### The watcher

`createWatcher` (lines 315–392). Uses `fs.watch(workspaceDir, { recursive: true })` (Node 20+, line 337). Watches:

1. The workspace root recursively.
2. For Cloudflare: `<outputDir>/wrangler.jsonc` (and `.json`, `.toml`) at lines 350–365 — but only files that *exist today*. Adding a wrangler.* file mid-session needs a dev-server restart. Trade-off explicitly called out at lines 352–354.
3. Any user-supplied env file via `--env` (lines 372–379).

Ignored (lines 319–334):
- `node_modules/`, `dist/`, `.git/`, `.turbo/` anywhere in the path
- Dotfiles other than `.flueignore`
- Editor backups: `*~`, `*.swp`, `*.swx`, `.DS_Store`

### Node reload model (the simple one)

`NodeReloader` (lines 396–540). Spawns `node dist/server.mjs` (line 455), pipes stdout/stderr (filtering known startup chatter at lines 470–483), waits for `/health` (line 498). On any change: kill + respawn.

`shouldRebuildOn(_relPath): true` (line 419–421) — Node has no downstream watcher, every workspace edit is a rebuild trigger. The watcher's ignore list already filters dist/, node_modules/, etc.

`reload()` (lines 423–431) always restarts the child unconditionally — esbuild re-emits `server.mjs` on every build (no dedup), and even if it didn't, the child has the old code in memory.

`killChild` (lines 505–539) is careful: SIGTERM, then a 1-second SIGKILL fallback. The SIGKILL timeout is deliberately tight so the dev server returns control before any wrapping process manager (pm2, systemd) gives up and orphans Flue's child. Spelled out in the comment at lines 530–533.

### Cloudflare reload model (the subtle one)

`CloudflareReloader` (lines 582–819). Wraps wrangler's `unstable_startWorker`. The whole reason the model is different is that *wrangler is itself a watching bundler*: when an imported source file changes, wrangler hot-reloads workerd. Flue must NOT redundantly restart for those changes — that's the whole point.

So `shouldRebuildOn` (lines 651–668) is strict: rebuild only on env-file changes, `wrangler.{jsonc,json,toml}` changes, or anything under `agents/` or `roles/`. Plain edits to imported source files outside those directories: ignored. AGENTS.md and `.agents/skills/` are runtime-discovered, not baked into the entry, so also ignored. Lines 645–649 spell this out.

`reload(buildChanged)` (lines 670–687) is the killer move: if `buildChanged === false`, do nothing — wrangler already has it. If `true` (structural change: new agent, removed agent, triggers changed, user edited wrangler.jsonc), dispose the worker and start a fresh one.

The `buildChanged` signal is generated by `build.ts`'s byte-equality checks on `additionalOutputs` (build.ts:171–187) and on the entry source for `bundle: 'none'` (build.ts:155–166). For the esbuild path, esbuild always writes, so `buildChanged` is always true — but Cloudflare doesn't take that path.

### Hardcoded `nodejsCompatMode: 'v2'` and why it works

`startWorker` (lines 702–793) passes `nodejsCompatMode: 'v2'` literally (line 742). The comment at lines 710–725 explains:

`unstable_startWorker` doesn't derive `nodejsCompatMode` from `compatibility_flags` — that's the caller's responsibility (wrangler's CLI passes a hook). Flue can hardcode `'v2'` because:
1. `validateUserWranglerConfig` rejects configs missing `nodejs_compat` if the field is set at all (cloudflare-wrangler-merge.ts:194–203).
2. `mergeFlueAdditions` adds `nodejs_compat` when missing (lines 358–364).
3. `compatibility_date` is floored at `MIN_COMPATIBILITY_DATE = '2026-04-01'` (lines 33, 213–219), well past the v1→v2 cutover (2024-09-23).

The merged dist/wrangler.jsonc is *guaranteed* to have nodejs_compat with a date that resolves to v2. Re-deriving the constant on every reload would be pointless work. This is one of the cleaner examples of "lift invariants out of the dynamic path" in the codebase.

### Container build ID hack

Lines 590–605 (and 624, 761) — `containerBuildId` is generated once per reloader (`randomUUID().slice(0, 8)`) and reused across reloads. The story: when the merged config has `containers[]`, `unstable_startWorker` *requires* `containerBuildId` but doesn't default it (only wrangler's CLI path does, via `generateContainerBuildId`). Without it, the very first `onBundleComplete` calls `getImageNameFromDOClassName` which asserts that `options.containerBuildId` is set; the assertion throws inside wrangler's `ProxyController`, the controller never gets `reloadComplete`, and *every request hangs* — including `/health`. Issue #22 in their tracker. This is the kind of thing only a deep-source review catches.

### Wrangler error funnel

Lines 775–785 — wrangler's central error handler routes controller errors to `logger.debug(...)` which is suppressed at Flue's `info` level. Things like "Docker daemon not running" or any future runtime-controller assertion would produce zero output and a hung server. Flue subscribes to `worker.raw.on('error', ...)` and re-emits at `console.error` with a `[flue]` prefix. The listener is bound here (not in the constructor) because `worker.raw` doesn't exist until `unstable_startWorker` resolves, and is detached on dispose to avoid leaks across reloads (lines 800–810).

### Env-file plumbing for both targets

`resolveEnvFiles` (lines 830–839) validates existence eagerly — typo on `--env` errors before any build.

`parseEnvFiles` (lines 852–860) uses Node's built-in `node:util.parseEnv` (Node 20.6+; Flue requires 22+). No `dotenv` package. Later files override earlier ones on key collision.

For Node, env vars are merged into the child env (dev.ts:454–467, with file values first, `process.env` second so shell wins, then explicit overrides last).

For Cloudflare, the resolved paths are passed to `unstable_startWorker({ envFiles: [...] })` (line 740). Wrangler loads them as `secret_text` bindings. Flue *always* passes the array (even if empty) — per wrangler's docs, an explicit `envFiles: []` fully disables auto-discovery (which would otherwise hunt in `dist/` for `.dev.vars` and `.env*`, the wrong place because Flue's config lives there but the user's env files don't). Lines 727–737 spell this out.

---

## 5. The Merge-Don't-Replace Algorithm

`packages/sdk/src/cloudflare-wrangler-merge.ts` (581 lines). The single most lift-worthy file in Flue for Thodare.

### Philosophy (verbatim, lines 1–25)

> Merge Flue's Cloudflare additions into the user's wrangler config.
>
> Philosophy: the user's wrangler config is the source of truth. Flue contributes the pieces it owns (the Worker entrypoint, its per-agent Durable Object bindings, the Sandbox DO, the migration tag) and leaves everything else untouched. The merged result is written to `dist/wrangler.jsonc` so the deployed Worker sees both.
>
> We delegate parsing and normalization to wrangler's own `unstable_readConfig` (lazy-imported so Node-only Flue users don't pay for it). This gets us:
>   - Both jsonc and TOML support for free.
>   - Wrangler's own validation diagnostics (clearer errors than ours).
>   - Path normalization: relative paths in fields like `containers[].image` are resolved to absolute paths against the user's config dir before we merge. This is critical because we write the merged config to `dist/wrangler.jsonc` — wrangler resolves relative paths against the config file's own directory, so without normalization a user's `containers[].image: "./Dockerfile"` would resolve to `dist/Dockerfile` after the move and fail to deploy.
>
> Flue still owns merge semantics (DO binding de-dup by `name`, migration append-if-tag-absent) and Flue-specific validation (compat date floor, required compat flags) — wrangler doesn't know about those.

This is the cleanest "merge don't replace" rationale I've ever seen written down. Three principles:

1. **User config is source of truth.** Don't rewrite their file; read it, merge, write a *separate* output to `dist/`.
2. **Borrow the upstream parser.** Don't reimplement JSONC + TOML + validation. Wrangler does it correctly (and warns appropriately) and lazy-import keeps the cost off Node-only users.
3. **Path normalization at parse time.** This single trick — let wrangler resolve relative paths against the user's config dir before merge — is what makes "write to dist/ but dereference from project root" work.

### The algorithm step-by-step

`mergeFlueAdditions` (lines 325–415) is the merge core. Pure function: takes `userConfig` + `additions`, returns merged. No I/O.

```
1. Shallow-clone userConfig (line 330) — never mutate the input.

2. main: Flue ALWAYS wins (line 336).
   Comment (lines 332–335): "Flue owns the bundle at dist/server.mjs, and pointing
   main elsewhere would mean wrangler deploys something Flue didn't build. If the
   user had a conflicting main, they're now using Flue and should accept this."

3. name: user wins if set; fall back to additions.defaultName (lines 338–341).

4. compatibility_date: user wins if set; fall back to MIN_COMPATIBILITY_DATE
   (lines 352–354). Validation already enforced any user value meets the floor.
   Comment (lines 346–351): explicitly does NOT default to "today's date" because
   "today" can be ahead of an older Flue install's bundled workerd's supported
   range and produce a confusing "compatibility_date is in the future" error.

5. compatibility_flags: union with nodejs_compat (lines 358–364). Validation
   already rejected arrays that were SET but missing nodejs_compat — this branch
   only fires when the user didn't set the field at all.

6. durable_objects.bindings: concat user + Flue, dedupe by `name`. USER WINS on
   conflict (lines 368–385). Comment: "they may be overriding a class_name
   intentionally."

7. migrations: append Flue's per-class entries at the END, skipping any whose
   tag is already present (lines 392–408). Order matters because Cloudflare
   applies migrations sequentially, so user's history comes first.

8. containers: untouched. The shallow-clone at step 1 already passed any user
   entries through; Flue contributes nothing (lines 410–412).
```

**What if the user has conflicting bindings already?** They win (step 6). Flue's entry for the same `name` is filtered out at line 381: `additions.doBindings.filter((b) => !existingBindingNames.has(b.name))`. The caveat: if the user gave a Flue-managed agent's binding name a different `class_name`, the user's class_name reaches the deployed worker but Flue's generated `_entry.ts` exports the *Flue-determined* class. Cloudflare's deploy will fail loud with "class not found." Flue's response: surface this user's intent rather than silently overriding it.

### The migration algorithm (the gnarliest bit)

`computeFlueMigrations` (lines 269–317). The story behind this is in the docstring (lines 226–268), but the punchline:

Cloudflare migration tags are **immutable once deployed**. The original bug (issue #15) had Flue emitting one migration tag like `'flue-v1'` containing all agent classes. Adding a new agent later meant either reusing the tag (silently ignored — Cloudflare won't re-run a tag) or bumping the tag (which would try to recreate the existing classes). Both broken.

The fix: emit one tag per class, deterministic name `flue-class-<className>`. Every redeploy is then a no-op for already-deployed classes and a single-tag append for the truly net-new ones. Sorted alphabetically (line 311) so the generated `dist/wrangler.jsonc` is byte-identical across machines and CI runs.

The "already declared" set is computed by walking every existing migration entry (lines 277–308):
- Add classes from `new_sqlite_classes` (line 288). Subtract from `deleted_classes` (line 289).
- Renames: subtract `from`, add `to` (lines 292–298).
- Transfers: add `to` only — `from` lives in a different worker (lines 302–307).
- **`new_classes` (KV-backed) deliberately NOT counted** (comment at lines 240–246). Rationale: Flue agents always need SQLite-backed sessions, so even if the user has a KV-backed DO with the same name as an agent, Flue still emits its SQLite migration. Cloudflare's deploy then surfaces a clear "class already defined" error rather than silently shipping a worker where the agent has no working session store.

Renames and deletes are not auto-detected. If an agent file disappears, Flue silently emits no migration for it — Cloudflare keeps the orphan class data alive but unbound, and the user can clean up with a manual `renamed_classes` / `deleted_classes` migration. Auto-emitting `deleted_classes` would destroy stored DO data on every accidental file removal — the docstring (lines 256–260) calls this out as "never the right default."

### The `Sandbox` re-export convention

`detectSandboxBindings` (lines 486–500): walk `durable_objects.bindings`, collect any `class_name` that **ends with** the literal `"Sandbox"` (case-sensitive, sorted, deduped). For each, the entry-point template generates `export { Sandbox as <className> } from '@cloudflare/sandbox';` (build-plugin-cloudflare.ts:97–100, 432).

The suffix-match (not substring) is deliberate (lines 478–482): mid-word matches like `MySandboxV2`, `MySandboxedAgent`, `LegacySandboxedThing` are *not* overridden. The trailing-suffix is the convention, and any class that ends with `Sandbox` opts in.

`assertSandboxPackageInstalled` (lines 514–550): walk `package.json` files up from `[outputDir, workspaceDir]`. If any binding ends with `Sandbox` but `@cloudflare/sandbox` isn't a dep anywhere, fail at build time with an actionable error rather than letting esbuild emit a confusing module-resolution failure. Lenient: gracefully skips if no `package.json` is parseable.

### Defensive `stripNoisyWranglerDefaults`

Lines 446–456. Wrangler's `unstable_readConfig` returns a fully-normalized config with every section populated to a default — including `unsafe: {}`. Wrangler's own validator then warns whenever `unsafe` is *present* (regardless of empty). Flue strips `unsafe` only when it's an empty object — if the user actually wrote `unsafe: {...}`, the value is non-empty and Flue leaves it alone (the warning is then wrangler's intended diagnostic, not noise).

Other defaulted-empty fields (`vars: {}`, `kv_namespaces: []`, `python_modules: { exclude: ['**/*.pyc'] }`) are left in place — wrangler doesn't warn about them, and dist/wrangler.jsonc is an internal build artifact. Saving bytes wasn't worth the complexity.

### The deploy-redirect trick

`writeDeployRedirectIfMissing` (lines 563–580). Writes `<outputDir>/.wrangler/deploy/config.json` with `{ "configPath": "../../dist/wrangler.jsonc" }`. This is wrangler's own *native* redirect mechanism (the same one Astro's Cloudflare adapter uses). With it, `wrangler deploy` run from `outputDir` automatically picks up Flue's generated config without any flag.

Only written if not already present — respects user intent if they've set up their own redirect.

This is a real "delegate to platform tools" win: instead of building `flue deploy`, Flue makes `wrangler deploy` Just Work. (See §9.)

---

## 6. The Error Vocabulary

Two files: `errors.ts` (vocabulary, 333 lines) + `error-utils.ts` (framework, 319 lines). The split is deliberate and load-bearing — see the JSDoc at `errors.ts:1–101` and `error-utils.ts:1–43`.

### The audience-classified prose pattern

From `errors.ts:23–55`:

> **Two audiences: caller vs. developer**
>
> The reader of an error message is one of two distinct audiences:
>
>   - The *caller*: an HTTP client. Possibly third-party, possibly hostile, possibly an end user who shouldn't even know we're built on Flue. Sees `message` and `details` always.
>
>   - The *developer*: the human running the service (`flue dev`, `flue run`, local debugging). Sees `dev` in addition, but only when the server is running in local/dev mode (gated by `FLUE_MODE=local`).
>
> Every error class must classify its prose by audience. The required-but-possibly-empty shape of both `details` and `dev` is the discipline: forgetting either field is a TypeScript error, and writing `''` is a deliberate "I have nothing for that audience" decision.

The required-but-possibly-empty discipline is the key trick. Since both fields are required strings on `FlueErrorOptions` (errors.ts:142–156), you can't accidentally omit them — you have to type `''` consciously, which makes "I have nothing for this audience" a deliberate act.

The wire envelope is gated in `error-utils.ts:135–152`:

```ts
function envelope(err: FlueError): WireEnvelope {
  const out: WireEnvelope = {
    error: { type: err.type, message: err.message, details: err.details },
  };
  // `dev` is included only when the server is in dev mode AND the error
  // class actually populated it. ...
  if (isDevMode() && err.dev) out.error.dev = err.dev;
  if (err.meta) out.error.meta = err.meta;
  return out;
}
```

`isDevMode()` (lines 131–133) just checks `process.env?.FLUE_MODE === 'local'`. Set by the CLI's `startServer` (cli/bin/flue.ts:542) and the dev server's spawn (sdk/src/dev.ts:465). On Cloudflare workers there's no `process.env`, so deployed CF *and* `flue dev --target cloudflare` currently render the prod envelope (acknowledged as a follow-up in lines 124–129).

### Three verbatim examples

#### Example 1 — `AgentNotFoundError` (errors.ts:270–287)

```ts
export class AgentNotFoundError extends FlueHttpError {
  constructor({ name, available }: { name: string; available: readonly string[] }) {
    super({
      type: 'agent_not_found',
      message: `Agent "${name}" is not registered.`,
      // Caller-safe: no enumeration, no framework internals.
      details: `Verify the agent name is correct.`,
      // Dev-only: sibling enumeration and workspace mechanics. Useful
      // for the human running the service; would leak namespace state
      // or framework details to a public caller.
      dev:
        `Available agents: ${formatList(available)}.\n` +
        `Agents are loaded from the workspace's "agents/" directory at build time. ` +
        `Verify the agent file is present in the workspace being served.`,
      status: 404,
    });
  }
}
```

The split is pristine. `details` says nothing the caller didn't already supply (the agent name in their URL). `dev` enumerates siblings and explains the mechanic. A hostile public caller probing `/agents/foo/x` learns nothing about what other agents exist. A developer running `flue dev` sees `Available agents: "echo", "greeter"` plus where to look.

#### Example 2 — `AgentNotWebhookError` (errors.ts:289–304)

```ts
export class AgentNotWebhookError extends FlueHttpError {
  constructor({ name }: { name: string }) {
    super({
      type: 'agent_not_webhook',
      message: `Agent "${name}" is not web-accessible.`,
      details: `This endpoint is not exposed over HTTP.`,
      // Dev-only: source-code-level fix instructions for the agent
      // author. The HTTP caller can't act on this.
      dev:
        `This agent has no webhook trigger configured. ` +
        `To expose it, add a webhook trigger to its definition (\`triggers: { webhook: true }\`). ` +
        `Trigger-less agents remain invokable via "flue run" in local mode.`,
      status: 404,
    });
  }
}
```

Same pattern: `details` is what an HTTP caller can act on (nothing — they don't author the agent). `dev` is the agent author's fix instruction.

#### Example 3 — `MethodNotAllowedError` (errors.ts:218–229)

```ts
export class MethodNotAllowedError extends FlueHttpError {
  constructor({ method, allowed }: { method: string; allowed: readonly string[] }) {
    super({
      type: 'method_not_allowed',
      message: `HTTP method ${method} is not allowed on this endpoint.`,
      details: `This endpoint accepts ${formatList(allowed)} only.`,
      dev: '',                              // ← deliberate empty
      status: 405,
      headers: { Allow: allowed.join(', ') },
    });
  }
}
```

Note `dev: ''`. There's nothing to add for the developer that isn't already in `details`. The `''` is a deliberate "I have nothing for that audience" decision. The fact that this *required* explicit empty-string is what enforces the discipline — there's no way to silently forget the dev field.

### Constructor-only-takes-data discipline

Errors.ts:62–69:

> Constructor takes ONLY structured input data (the values used to build the message). The constructor assembles `message`, `details`, and `dev` from that data, so call sites never reinvent phrasing.

Counter-example from errors.ts:86–98:

```ts
class AgentNotFoundError extends FlueHttpError {
  constructor(message: string) {                       // ✗ free-form
    super({
      type: 'agent_error',
      message,
      details: 'Available: "x", "y", "z"',             // ✗ leaks names
      dev: '',                                         // ✗ wasted channel
      status: 500,                                     // ✗ wrong status
    });
  }
}
```

This is the documentation showing the wrong way for the express purpose of preventing it. The structural pressure (typed constructor inputs) is what keeps the vocabulary consistent across the codebase.

### Full catalog (errors.ts)

| Class                       | Type                       | Status | Lines    |
|-----------------------------|----------------------------|--------|----------|
| `MethodNotAllowedError`     | `method_not_allowed`       | 405    | 218–229  |
| `UnsupportedMediaTypeError` | `unsupported_media_type`   | 415    | 231–251  |
| `InvalidJsonError`          | `invalid_json`             | 400    | 253–268  |
| `AgentNotFoundError`        | `agent_not_found`          | 404    | 270–287  |
| `AgentNotWebhookError`      | `agent_not_webhook`        | 404    | 289–304  |
| `RouteNotFoundError`        | `route_not_found`          | 404    | 306–318  |
| `InvalidRequestError`       | `invalid_request`          | 400    | 320–332  |

Plus the base `FlueError` (lines 174–190) and `FlueHttpError` (lines 204–214). Internal-error fallback `GENERIC_INTERNAL` lives in error-utils.ts:154–160 — used when an unknown `throw` reaches the HTTP boundary.

### The framework: renderers + parsers

`error-utils.ts:169–193` (`toHttpResponse`) — the single source of truth for HTTP error responses. Both Hono's `app.onError` (build-plugin-node.ts:264) and the Cloudflare worker's outer `try/catch` (build-plugin-cloudflare.ts:418, 497) call this. Anything not a `FlueError` is logged in full server-side and rendered as the generic 500 — never leak.

`error-utils.ts:200–209` (`toSseData`) — twin for in-stream errors. Same envelope, JSON-stringified for the SSE `data:` line.

`error-utils.ts:227–278` (`parseJsonBody`) — the request body parser. Quirks: empty body (`Content-Length: 0` or both headers absent) is treated as `{}` so no-payload agents work with `curl -X POST <url>`. If a body is present without `application/json`, `UnsupportedMediaTypeError`. Stream-read failures and JSON-parse failures both surface as `InvalidJsonError` — the comment (lines 255–259) explains: a separate `BodyReadError` would be more precise, but neither runtime exposes the distinction in a way that's actionable for the client.

`error-utils.ts:303–318` (`validateAgentRequest`) — the gate function used by Node's Hono handler. Throws the appropriate FlueHttpError on each failure mode. Cloudflare's worker re-implements the same gate inline (build-plugin-cloudflare.ts:466–490) because it pre-routes before delegating to `routeAgentRequest` (the partyserver dispatcher would otherwise return text/plain "Invalid request" — visibly inconsistent with the rest of the API).

---

## 7. Two Workspace Layouts + Env-Var Foot-Gun

### The two-layout convention

`build.ts:222–234`:

```ts
/**
 * Resolve a Flue workspace directory from the current working directory,
 * using the two-layout convention. ...
 *
 * Two supported layouts, checked in order:
 *   1. `<cwd>/.flue/` — use this when Flue is embedded in an existing project.
 *   2. `<cwd>/` — use this when the project itself is the Flue workspace.
 *
 * If `.flue/` exists, it wins unconditionally — no mixing with the bare layout.
 * Returns null if neither is present so the caller can produce a helpful error.
 */
export function resolveWorkspaceFromCwd(cwd: string): string | null {
  const dotFlue = path.join(cwd, '.flue');
  if (fs.existsSync(dotFlue)) return dotFlue;
  if (fs.existsSync(path.join(cwd, 'agents'))) return cwd;
  return null;
}
```

The two layouts are:

1. **`./.flue/`** — for embedding Flue in an existing project. Agents live at `./.flue/agents/`, roles at `./.flue/roles/`. The project root has its own `package.json`, `wrangler.jsonc`, etc. — Flue stays in its own corner.
2. **`./`** — for projects where Flue *is* the project. Agents at `./agents/`, roles at `./roles/`.

### Why having two is an anti-pattern (sort of)

The first agent flagged this as an anti-pattern. The actual story in the source is more nuanced:

**Flue *acknowledges* the cost:**
- The CLI usage banner (cli/bin/flue.ts:65) hardcodes both into the help text: *"Default: ./.flue/ if it exists, else ./"*.
- The error message when neither is present (cli/bin/flue.ts:30–37) prints both candidate paths.
- Every doc has to say "use this layout, or drop the prefix if you prefer the root" (e.g., docs/deploy-cloudflare.md:9–12).

**The split is real, not an anti-pattern in the abstract:**
- Bare layout would be hostile to embedding Flue inside an existing Astro/Next/Node project (their `agents/` would collide).
- `.flue/` only would force every greenfield Flue project into a redundant subdirectory.

**What Flue actually does:** ships both, documents both, and takes care to make `outputDir` (where dist/, wrangler.jsonc, .wrangler/ go) *always* be the project root regardless of layout. The CLI's `resolveOutputDir` (cli/bin/flue.ts:46–48) defaults to `process.cwd()`; build.ts:545–550 derives the default Worker name from `path.basename(outputDir)` rather than `workspaceDir` for exactly this reason: *"workspaceDir may be ./.flue/ which would produce a useless ".flue" worker name."*

**Why it's still mildly an anti-pattern:** every doc page has to describe both. Every "where is X" question has two answers. The discoverability cost is real. If Flue were greenfield today, picking one (probably `./`) and recommending users move existing Flue stuff to `flue/` rather than `.flue/` would be cleaner. But the boat sailed at v0.0.x and there's no migration story for it.

**For Thodare:** pick one. The unambiguously better choice is the bare layout (project IS the workspace), because:
- Embedding inside an existing project is rare for a workflow engine (workflows tend to be greenfield).
- The "drop the prefix if you prefer" aside in docs accumulates real cognitive cost.
- `outputDir` vs `workspaceDir` separation falls out for free if the workspace IS the project root.
- If you later need to embed, add `--workspace ./flue/` as an opt-in escape hatch (the CLI already supports an explicit `--workspace`).

### The env-var production-mode foot-gun

The variable is **`FLUE_MODE`**. Searched and found in 6 files (cli/bin/flue.ts:533, 541, 542; sdk/src/build-plugin-node.ts:84, 89, 169, 272; sdk/src/dev.ts:458, 465; sdk/src/build.ts:52; sdk/src/error-utils.ts:35, 124, 131, 132, 149; sdk/src/errors.ts:32, 53, 145).

`FLUE_MODE=local` does **two distinct things**:

1. **Bypass webhook gating.** In the generated Node server (build-plugin-node.ts:89, 169): `const isLocalMode = process.env.FLUE_MODE === 'local';` and `validateAgentRequest({ ..., allowNonWebhook: isLocalMode })`. In production this is `false`, so trigger-less agents (`triggers = {}`) are *not* exposed over HTTP — they're CI-only, invokable only via `flue run`. In local mode it's `true`, so any registered agent is reachable.

2. **Render the `dev` field of error envelopes.** error-utils.ts:131–133, 149: `if (isDevMode() && err.dev) out.error.dev = err.dev;`. In production the `dev` field is suppressed. In local mode it's rendered.

**The foot-gun:** `FLUE_MODE` is set by the CLI's spawn (cli/bin/flue.ts:542) and the dev server's spawn (dev.ts:465). It is NOT cleared in `dist/server.mjs`. If a user runs `node dist/server.mjs` directly with `FLUE_MODE=local` already in their shell environment, **the production server runs in local mode** — webhook gating is off (CI-only agents reachable over HTTP) and error envelopes leak the `dev` field (sibling enumeration, framework internals). Both of these are explicitly the things `dev` was designed to keep out of public callers' hands.

There's no defense in code. The env var name is generic enough that a developer who has it set for `flue dev` work, then ships the same shell context to production via Docker `ENV` carry-over or a misconfigured systemd unit, or `set -a; source .env`, will silently expose internals. The Node target's startup banner does say `[flue] Mode: local (all agents invokable, including trigger-less)` (build-plugin-node.ts:272–274), but a logging message isn't a guardrail.

**How Thodare should avoid it:**

- **Use a more explicit flag.** Not `FLUE_MODE=local` but `THODARE_DEV_BYPASS=1` or similar — names that carry obvious risk and aren't going to accidentally appear in someone's `.bashrc`.
- **Or split the two concerns.** "Allow trigger-less agents over HTTP" and "render dev-only error fields" are different things. A single env var that does both is one Boolean too few.
- **Or refuse to start with the bypass enabled if `NODE_ENV=production`.** Belt-and-suspenders: the production server should hard-error on startup if it sees the dev bypass, with a message pointing at the env var name so it's obvious to remove.
- **Or drop the bypass entirely.** Document that production-deployed servers expose only webhook agents, period. Make CI-only invocation always go through a separate code path (a `flue run` that uses the SDK in-process rather than via HTTP to a spawned server).

The existing comment at error-utils.ts:124–129 acknowledges that on Cloudflare there's no `FLUE_MODE` plumbing to the worker, so the dev/prod distinction *doesn't apply* there — both render the prod envelope. That's actually the right default. The Node path is the broken one.

---

## 8. The Test Pattern (Or Lack Of One)

There is no test directory in this repo. `find packages -name "*.test.*" -o -name "*.spec.*"` returns zero. There's no `vitest`, `jest`, `node:test`, or any other test runner declared in any `package.json` in `packages/`. `pnpm-workspace.yaml`'s `packages: [packages/*, examples/*, apps/*]` doesn't include a tests workspace.

What Flue has *instead*:

1. **Example agents that double as smoke tests.** `examples/hello-world/.flue/agents/` has 11 agents. Several have `-test` in their name: `compaction-test.ts`, `session-test.ts`, `fs-test.ts`. The implicit test plan is "build the workspace, run `flue dev`, hit each agent with `curl`, watch for failure."

2. **A maintainer note that says testing is expensive.** `examples/hello-world/.flue/agents/session-test.ts:18–22`:

   > Note to maintainers: This is a pain to test, so only run this as a test if you need the extra level of confidence, if you were recently changing code that impacted sessions/persistence, or were doing a larger refactor. Otherwise, this test is safe to skip and not run as part of your regular test suite.

   The honesty is admirable; the position is risky. Multi-invocation persistence is exactly the kind of thing you want continuously regression-tested.

3. **A type-check command as the primary CI gate.** `packages/sdk/package.json` declares `"check:types": "tsc --noEmit"` as a script. AGENTS.md (lines 62–64) calls this out as the gate. With the strict `BuildPlugin` interface, audience-classified `FlueErrorOptions`, and rich generic types throughout, `tsc` catches a real chunk of what unit tests would.

**For Thodare:** Don't copy this. Flue gets away with it because (a) the surface is small, (b) the example agents exercise most code paths, (c) the audience is willing to read the source. A workflow orchestration engine has a much larger, longer-lived state space — runtime semantics matter much more than they do for a build tool. *Do* lift the type-driven approach (it's genuinely effective for the build pipeline and the error vocabulary), but pair it with actual integration tests for the orchestration semantics from day one.

---

## 9. Top 10 Surprises

1. **`bundle: 'none'` is a first-class strategy, not a hack.** The `BuildPlugin` interface (types.ts:441–469) enshrines "let the downstream tool bundle" as one of two equal options. Most build frameworks treat their own bundler as the universal answer; Flue acknowledges that some platforms (Cloudflare's wrangler, future Vercel/Netlify) own bundling and pre-bundling on top of them is actively wrong. Three sentences at types.ts:435–440 explain it: pre-bundling caused real problems (`tar`/`fs`/etc. via `nodejs_compat`), and the cleanest fix was to opt out.

2. **Flue *contains* a Cloudflare-config merger that's better than most "deploy adapter" packages.** `cloudflare-wrangler-merge.ts` is 581 lines of disciplined, well-commented, pure-function merge logic. The "lazy-import wrangler's own reader for parsing + path normalization" trick (lines 130–170) is the kind of thing that takes a year of integration pain to figure out.

3. **Dev server's "no structural change → wrangler hot-reloads → Flue does nothing" pattern.** dev.ts:670–687. Most file-watcher dev servers naively rebuild + restart on every change. Flue understands when the downstream tool already handles it and gets out of the way. The byte-equality check at build.ts:155–166 and 178–185 is what makes this work — without it, every rebuild would touch mtime and trigger a redundant wrangler reload.

4. **Migration tags use one-class-per-tag.** cloudflare-wrangler-merge.ts:269–317. The naive approach (one tag per build, all classes inside) is broken in a way that only shows up in production after months — issue #15 in their tracker. The fix is mechanical (`tag: \`flue-class-${c}\``, sorted) but the design discipline of "every redeploy is byte-identical for stable input" is the lift.

5. **Hand-rolled flag parser with custom error messages per flag.** cli/bin/flue.ts:124–208. Every flag's error message is hand-tuned for that exact failure mode. `commander`/`yargs` would give generic messages.

6. **The error vocabulary required-but-possibly-empty discipline.** errors.ts:142–156. Both `details` and `dev` are *required* string fields. Forgetting either is a TypeScript error. Writing `''` is a deliberate "I have nothing for that audience" act. This single piece of API design is what makes the audience split survive contact with new contributors.

7. **`FLUE_MODE=local` does two things at once and isn't cleared in production.** The foot-gun in §7. Most code reviews wouldn't catch this because the env var is set and consumed in different files; you have to trace it across cli/bin/flue.ts → dev.ts → generated Node server → error-utils.ts.

8. **The `containerBuildId` workaround.** dev.ts:590–605. wrangler's `unstable_startWorker` doesn't default this field but asserts on it when `containers[]` is set, with a failure mode of "every request hangs forever including /health." The fix is one line plus a 17-line comment explaining why. That ratio is the codebase's whole personality.

9. **The deploy-redirect file as an alternative to `flue deploy`.** cloudflare-wrangler-merge.ts:563–580. Flue could have built a `flue deploy` that wraps `wrangler deploy --config dist/wrangler.jsonc`. Instead it writes a 30-byte redirect file that makes plain `wrangler deploy` Just Work. The deploy command never exists.

10. **The Sandbox detection by suffix-match instead of explicit registration.** cloudflare-wrangler-merge.ts:486–500. Flue could have made users opt in with a flag (`@flue/sandbox: true`). Instead it auto-detects any DO binding whose `class_name` ends with `Sandbox`, with the care to suffix-match (not substring) so `MySandboxV2` doesn't trigger. The convention is invisible until you read the source — but combined with `assertSandboxPackageInstalled` at build time (lines 514–550), the failure mode for a user who got the convention wrong is friendly and actionable.

---

## 10. Implications for Thodare

### Patterns to lift, with file references

1. **Three verbs, one `--target` axis, no `deploy`.** `cli/bin/flue.ts:50–82`. Lift wholesale. The verb set (`init` / `dev` / `run` / `build`) — minus `init`, which Flue doesn't have either — is exactly the right shape for a long-running orchestrator. Reference: every flag in the help text is one of `--target`, `--workspace`, `--output`, `--port`, `--env`, plus the verb-specific `--id`/`--payload`. Five global flags total.

2. **The `BuildPlugin` interface verbatim, with `bundle: 'esbuild' | 'none'` and `additionalOutputs`.** `packages/sdk/src/types.ts:441–469`. Lift the entire shape. The `bundle: 'none'` strategy is what makes future platform support (Vercel, Netlify, Fly, Railway, AWS Lambda) tractable — those platforms own bundling, and Thodare needs to opt out cleanly. The `additionalOutputs` map gives plugins a single uniform way to emit platform config alongside the entry point.

3. **The wrangler-merge algorithm pattern, generalized.** `packages/sdk/src/cloudflare-wrangler-merge.ts` end to end. Specifically:
   - Lazy-import the platform's own config reader for parsing (lines 130–170). Don't reimplement JSONC/TOML/YAML.
   - Pure-function merge with shallow clone of user input (line 330).
   - Per-field policy (Flue-wins, user-wins, union, append-skip-if-tag-exists).
   - Byte-equality skip-write at the build layer (build.ts:155–166, 178–185).
   - Never modify the user's source file; write to a separate output path.
   - Use the platform's *own* redirect mechanism to make platform-tool deploys work without a wrapper command (lines 563–580).

   For Thodare, this directly maps to per-target merges: `serverless.yml`, `vercel.json`, `fly.toml`, `Dockerfile`, etc. Each target's merge file should have the same structure as `cloudflare-wrangler-merge.ts`.

4. **Audience-classified error vocabulary with required-but-possibly-empty fields.** `packages/sdk/src/errors.ts:1–333` and `error-utils.ts:1–319`. Lift wholesale. The `{ message, details, dev }` triple, the required-string discipline, the structured-constructor pattern, the type-then-render pipeline (`toHttpResponse` / `toSseData`) — every one of these is a clear win for any framework that surfaces errors to both end users and operators. The `errors.ts` JSDoc preamble (lines 1–101) is reusable as a contributor doc almost verbatim.

5. **Fresh plugin instance per build with internal caching.** `build-plugin-cloudflare.ts:34–41`. Plugin holds short-lived state (the `userConfigCache`) that's auto-cleaned by being scoped to a single instance. No global mutable state, no manual cache invalidation, no surprises.

6. **The dev server's two-tier reload model.** `packages/sdk/src/dev.ts:79–103, 396–540, 582–819`. The `DevReloader` interface — `start` / `shouldRebuildOn` / `reload(buildChanged)` / `stop` / `killSync` — is exactly the right abstraction. Some targets need full restart on every change (Node, Lambda); others have a downstream watcher that handles body edits (Cloudflare; future Vercel dev). The interface lets each target pick its policy without leaking the choice into core dev logic. Lift the debounce-and-coalesce `Rebuilder` (lines 235–284) wholesale.

7. **150ms debounce, fs.watch recursive, ignore list of obvious junk.** `packages/sdk/src/dev.ts:281, 315–392`. The ignore list (`node_modules`, `dist`, `.git`, `.turbo`, dotfiles, `*~`, `*.swp`, `.DS_Store`) is portable. The 150ms window is short enough to feel instant but long enough to coalesce a save-bursting editor.

8. **Workspace resolution as a discrete pure function.** `build.ts:222–234`. `resolveWorkspaceFromCwd(cwd): string | null` is testable, predictable, and decoupled from the CLI. Thodare should follow the shape — but pick **one** layout, not two (see §7).

9. **Manifest written to `dist/manifest.json` for runtime introspection.** `build.ts:82–90`. The `_entry` imports it at runtime, the dev server uses it to pick a sample agent for the curl example (`pickExampleAgentName`, dev.ts:887–916). For Thodare, an analogous `dist/workflows.json` (or whatever) is a cheap, durable way to give later tools (CLI commands, dashboards, the platform itself) a single source of truth on what was deployed.

10. **The deploy-redirect trick, generalized.** cloudflare-wrangler-merge.ts:563–580. *For every target that supports it*, write a redirect file in the platform's native format so the platform's deploy command Just Works without any Thodare wrapper. This is the single biggest lever for "no `flue deploy` command."

### Mistakes to avoid

1. **Two workspace layouts.** §7. Pick one. Ship `--workspace` as the explicit-override escape hatch, but never default-search across two locations. The discoverability tax compounds over every doc page and every error message.

2. **`FLUE_MODE`-style env var that does two things at once and isn't gated against production.** §7. Use a name that carries obvious risk. Hard-error on startup if the dev bypass is enabled in production. Or split the two concerns. Or drop the bypass entirely and route CI-only invocation through an in-process SDK call rather than a spawned server.

3. **No tests.** §8. Flue gets away with it because the surface is small and the build pipeline is pure-functional. Thodare's surface is much larger and the orchestration semantics are exactly what unit tests are for. Lift the type-driven approach (it's genuinely good for the build pipeline and the error vocabulary), but write integration tests for the workflow runtime from day one.

4. **Regex-based trigger parsing.** `build.ts:279–296`. `parseTriggers` matches `export\s+const\s+triggers\s*=\s*\{([^}]*)\}` then sub-matches on the body. This is brittle: nested braces, comments, computed values, type annotations, helper functions — any of them break it. For Thodare's analog (workflow triggers, schedules, event subscriptions), use the TypeScript compiler API or a proper parser. Even a tiny `oxc-parser` invocation would be more robust.

5. **Implicit `console.error` everywhere.** The CLI logs to stderr to keep stdout reserved for the result (cli/bin/flue.ts:721 puts the result on stdout, everything else on stderr — a clean discipline). But the SDK also `console.log`s build progress (build.ts:35–77, 134, 162, 165, etc.), making Flue noisy when used as a library. For Thodare, route every framework log through a structured logger that the host can replace.

6. **Plugin auto-detection by class-name suffix.** cloudflare-wrangler-merge.ts:486–500 (the `Sandbox` suffix convention). It's clever and the suffix-not-substring care is real, but it's invisible. A user who reads `class_name: "MockSandbox"` in their config and doesn't know about Flue's convention will be confused when their mock gets auto-aliased to `@cloudflare/sandbox`. Prefer explicit registration (e.g., a per-binding `flue: 'sandbox'` field) for Thodare.

7. **Hardcoded constants tied to platform-version-floors with cross-file invariants.** dev.ts:710–725's hardcoded `nodejsCompatMode: 'v2'` works only because `MIN_COMPATIBILITY_DATE` is `'2026-04-01'` and the validation/merge code enforces it. If anyone bumps `MIN_COMPATIBILITY_DATE` past v2's deprecation, the hardcode silently becomes wrong. The comment is detailed but the dependency isn't expressed in code. For Thodare, derive these constants from a single source rather than threading invariants across files.

---

## Executive Summary (≈200 words)

Flue is a small, disciplined codebase: ~8,000 LoC of TypeScript across `@flue/sdk` and `@flue/cli`, with the deepest design effort concentrated in three places — the `BuildPlugin` interface (types.ts:441–469), the `cloudflare-wrangler-merge.ts` algorithm (581 lines), and the audience-classified error vocabulary in `errors.ts` (333 lines). The CLI is three verbs (`dev`, `run`, `build`), one `--target` axis, no `deploy` — wrangler's native redirect mechanism is repurposed so `wrangler deploy` Just Works without a wrapper. The dev server has a two-tier reloader: Node always restarts; Cloudflare lets wrangler hot-reload body edits and only acts on structural change, gated by a byte-equality check on `dist/` writes. The error system enforces caller/developer audience separation through required-but-possibly-empty `details`/`dev` fields. There are zero tests. The two-workspace-layout convention (`./.flue/` vs `./`) and the `FLUE_MODE=local` env var (which both bypasses webhook gating *and* leaks dev-only error fields, with no production guardrail) are the two patterns Thodare should consciously not copy. Everything else is liftable, and most of it is liftable verbatim.

**File:** `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/flue.md`
