# Code Review: `vercel-labs/workflow-builder-template`

Source: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/workflow-builder-template/`
Commit reviewed: shallow clone present locally on 2026-05-02.
License: Apache-2.0. Stack: Next.js 16, React 19, `@xyflow/react` 12, Drizzle 0.44 + Postgres, Better Auth 1.3, `workflow` 4.0.1-beta.17 (Vercel WDK), `ai` 5.0, OpenAI/AI Gateway, Jotai, shadcn/ui, Tailwind 4.

This review feeds two Thodare workstreams:
1. The "evaluate this template as a builder UI" spike tracked at `next-up.md:211`.
2. The broader **World abstraction proposal** — specifically, what an existing AI-driven streaming op-log says about Thodare's EditOp loop.

It is intentionally long. Skip to section 8 ("Implications for Thodare") for the verdict.

---

## 1. Repo map

Top-level layout (`workflow-builder-template/`):

| Path | Role |
|------|------|
| `app/` | Next.js 16 App Router. Three pages (`/`, `/workflows`, `/workflows/[workflowId]`) plus all REST API routes under `app/api/**`. The canvas itself is mounted on the homepage (`app/page.tsx`). |
| `app/api/ai/generate/route.ts` | The streaming AI op-log endpoint. NDJSON of `Operation` objects. (Section 4.) |
| `app/api/workflow/[workflowId]/execute/route.ts` | The execution trigger. Calls `start()` from `workflow/api`. (Section 12.) |
| `app/api/workflows/**` | CRUD + executions/code/download endpoints. |
| `app/api/integrations/**` | Credential CRUD + connection test endpoints. |
| `app/api/ai-gateway/**` | Vercel AI Gateway "managed user keys" consent flow. |
| `components/workflow/` | The React Flow canvas + node renderers + side panel. `workflow-canvas.tsx` (587 lines) is the orchestrator. |
| `components/ai-elements/` | Vercel "AI elements" — the `Canvas`, `Node`, `Edge`, `Panel`, `Controls`, `Connection`, `Prompt`, `Shimmer` primitives. The prompt bar lives in `components/ai-elements/prompt.tsx`. |
| `components/overlays/` | Modal dialogs (settings, integrations, add-connection, AI Gateway consent, etc.). |
| `components/ui/` | shadcn/ui primitives + custom `template-badge-input`, `template-badge-textarea`, `code-editor` (Monaco). |
| `lib/workflow-executor.workflow.ts` | The **interpreter path**. 766 lines. Dispatches blocks at runtime. Marked `"use workflow"`. (Section 3.) |
| `lib/workflow-codegen.ts` | The **codegen path**. 1316 lines. Walks the graph, emits TypeScript. (Section 3.) |
| `lib/workflow-codegen-shared.ts` | Helpers shared by codegen + interpreter (template parsing, node-usage analysis). |
| `lib/workflow-codegen-sdk.ts` | Codegen targeting "export to standalone WDK project" (uses `lib/codegen-templates/` + `lib/codegen-registry.ts` from auto-discovered step files). |
| `lib/codegen-templates/` | Three string-template fallbacks: `http-request.ts`, `condition.ts`, `database-query.ts` for system actions that don't have plugins. |
| `lib/steps/` | System steps the interpreter dispatches: `trigger.ts`, `http-request.ts`, `condition.ts`, `database-query.ts`, `credentials.ts`, `step-handler.ts` (the `withStepLogging` wrapper). |
| `lib/db/schema.ts` | Drizzle schema. 9 tables. (Section 5.) |
| `lib/db/integrations.ts` | AES-256-GCM encrypt/decrypt for stored credential blobs. |
| `lib/auth.ts` + `lib/auth-providers.ts` + `lib/auth-client.ts` | Better Auth with email/password, GitHub, Google, anonymous, and Vercel OAuth. (Section 6.) |
| `lib/credential-fetcher.ts` | Resolves an `integrationId` reference to a credential bag at step runtime. The "creds never enter the workflow JSON" boundary. |
| `lib/api-client.ts` | Type-safe fetch wrapper exporting `api.ai`, `api.aiGateway`, `api.integration`, `api.user`, `api.workflow`. Includes the client-side NDJSON stream parser that mirrors the server op-log. |
| `lib/workflow-store.ts` | Jotai atoms for canvas state. Atoms talk to `api.workflow` directly — no Redux, no Zustand. |
| `lib/ai-gateway/` | Vercel AI Gateway managed-key state machine. |
| `lib/utils/` | `template.ts`, `redact.ts` (PII/credential redaction in logs), `id.ts` (nanoid wrapper), `time.ts`, `format-number.ts`. |
| `lib/next-boilerplate/` | Boilerplate files copied into the user's exported project (full Next.js scaffold). |
| `plugins/` | One folder per integration. 14 plugins. Plus `registry.ts` (the contract), `index.ts` (auto-generated), `legacy-mappings.ts` (back-compat for renamed action IDs), `_template/` (skeleton for new plugins), `AGENTS.md` (the plugin-author guide). |
| `hooks/` | `use-mobile.ts`, `use-touch.ts`. Tiny. |
| `drizzle/` | Five generated migrations + meta snapshots. |
| `scripts/discover-plugins.ts` | The build-time codegen that produces `plugins/index.ts`, `lib/types/integration.ts`, `lib/step-registry.ts`, `lib/output-display-configs.ts`, `lib/codegen-registry.ts`, and rewrites the README integration list. (Section 2.) |
| `scripts/create-plugin.ts` | Interactive `pnpm create-plugin` wizard. |
| `scripts/migrate-prod.ts` | Production migration runner invoked from `pnpm build`. |
| `e2e/workflow.spec.ts` | Playwright tests against the homepage canvas (no auth). 6 tests, 258 lines. (Section 7.) |
| `public/` | Static assets. |

The repo is monolithic — there is no `apps/builder/` vs `apps/runner/` split. The canvas, the API, the interpreter, the codegen, and the auth all live in one Next app.

---

## 2. The plugin model

### 2.1 The verbatim `IntegrationPlugin` interface

From `plugins/registry.ts:162-200`:

```ts
export type IntegrationPlugin = {
  // Basic info
  type: IntegrationType;
  label: string;
  description: string;

  // Icon component (should be exported from plugins/[name]/icon.tsx)
  icon: React.ComponentType<{ className?: string }>;

  // Form fields for the integration dialog
  formFields: Array<{
    id: string;
    label: string;
    type: "text" | "password" | "url";
    placeholder?: string;
    helpText?: string;
    helpLink?: { text: string; url: string };
    configKey: string; // Which key in IntegrationConfig to store the value
    envVar?: string; // Environment variable this field maps to (e.g., "RESEND_API_KEY")
  }>;

  // Testing configuration (lazy-loaded to avoid bundling Node.js packages in client)
  testConfig?: {
    getTestFunction: () => Promise<
      (
        credentials: Record<string, string>
      ) => Promise<{ success: boolean; error?: string }>
    >;
  };

  // Avoid using this field. Plugins should use fetch instead of SDK dependencies
  // to reduce supply chain attack surface. Only use for codegen if absolutely necessary.
  dependencies?: Record<string, string>;

  // Actions provided by this integration
  actions: PluginAction[];
};
```

And `PluginAction` (`plugins/registry.ts:125-156`):

```ts
export type PluginAction = {
  slug: string;                      // "send-message"
  label: string;                     // "Send Slack Message"
  description: string;
  category: string;                  // grouping in UI
  stepFunction: string;              // exported function name in the step file
  stepImportPath: string;            // path under plugins/[plugin-name]/steps/
  configFields: ActionConfigField[];
  outputFields?: OutputField[];      // for template autocomplete
  outputConfig?: OutputDisplayConfig; // image/video/url/component renderer
  codegenTemplate?: string;          // optional override for export
};
```

A `ActionConfigFieldBase` (`plugins/registry.ts:17-59`) carries the declarative schema for each form field shown in the side panel: `key`, `label`, `type` (`template-input | template-textarea | text | number | select | schema-builder`), `placeholder`, `defaultValue`, `example` (used for AI prompt generation — see section 4), `options` (for select), `rows`, `min`, `required`, and `showWhen` for conditional rendering. There's also `ActionConfigFieldGroup` (`registry.ts:65-77`) for collapsible sections.

The full action ID is computed `${integration}/${slug}` — e.g. `slack/send-message`, `linear/create-ticket`, `ai-gateway/generate-text`. `parseActionId` (`registry.ts:230`) and `findActionById` (`registry.ts:319`) recover the plugin from a stringified ID, with a fallback chain: namespaced ID → `LEGACY_ACTION_MAPPINGS` (e.g. `"Send Email" -> "resend/send-email"`) → exact-label lookup. This is how the interpreter (which receives `actionType: "ai-gateway/generate-text"` from the JSON config) finds the right step function at runtime.

### 2.2 Auto-registration

The plugin lifecycle has three layers:

1. **Convention.** Every plugin is a directory under `plugins/` containing `index.ts`, `credentials.ts`, `icon.tsx`, `test.ts`, and `steps/<slug>.ts` for each action. Per `plugins/AGENTS.md:21-31`. Folder name **must** equal the plugin `type`.
2. **Self-registration.** Each `index.ts` ends with `registerIntegration(plugin)` (e.g. `plugins/slack/index.ts:72`), which writes into a module-level `Map<IntegrationType, IntegrationPlugin>` (`registry.ts:215`). Importing the plugin file is the registration.
3. **Auto-discovery codegen.** `scripts/discover-plugins.ts` runs before `next dev` and `next build` (per `package.json:8-9`). It:
   - Lists `plugins/*` directories, filtering `_*`, dotfiles, `index.ts`, `registry.ts` (`discover-plugins.ts:71`).
   - Writes `plugins/index.ts` with one `import "./<plugin>";` per discovered plugin (`generateIndexFile`, `discover-plugins.ts:100`).
   - Imports the freshly-written index, then queries the registry to write four more generated files:
     - `lib/types/integration.ts` — a `IntegrationType` union literal of every plugin type plus the `"database"` system type (`generateTypesFile`, `discover-plugins.ts:205`).
     - `lib/step-registry.ts` — `PLUGIN_STEP_IMPORTERS: Record<string, { importer, stepFunction }>` with statically-analyzable `() => import("@/plugins/...")` thunks. Includes legacy-label aliases so old workflow JSON keeps working (`generateStepRegistry`, `discover-plugins.ts:597`).
     - `lib/output-display-configs.ts` — client-safe map of action IDs to output renderers (image/video/url field hints) (`generateOutputDisplayConfigs`, `discover-plugins.ts:747`).
     - `lib/codegen-registry.ts` — for every step file that exports a `stepHandler` function, the script uses TypeScript's compiler API (`ts.createSourceFile`, `discover-plugins.ts:428`) to extract the function body, the imports (excluding `server-only` and internal `@/` paths), the input types (matched by the `Result | Credentials | CoreInput` suffix per `shouldIncludeType` at `discover-plugins.ts:297`), and weaves them into a portable WDK template wrapped with `"use step";` and `fetchCredentials("<integrationType>")`.
   - Rewrites the README's `<!-- PLUGINS:START -->`/`<!-- PLUGINS:END -->` block (`updateReadme`, `discover-plugins.ts:160`).

The net effect: a contributor drops a folder, runs `pnpm discover-plugins`, and gets a typed integration union, a registered runtime importer, an export template for the codegen path, and a README entry without touching shared code. `legacy-mappings.ts` exists precisely because action IDs were renamed once and the team did not want to break stored workflows.

The codegen is deliberately AST-based, not regex-based — `processNode`/`processVariableStatement`/`processTypeAlias` (`discover-plugins.ts:346-415`) walk the source tree. This is unusually rigorous for a build script in a Next template.

### 2.3 An annotated example plugin: Slack

`plugins/slack/index.ts` (verbatim, annotated):

```ts
import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { SlackIcon } from "./icon";

const slackPlugin: IntegrationPlugin = {
  type: "slack",                              // Must equal folder name + IntegrationType union member
  label: "Slack",
  description: "Send messages to Slack channels",
  icon: SlackIcon,                            // SVG component, uses currentColor
  formFields: [
    {
      id: "apiKey",
      label: "Bot Token",
      type: "password",                       // Side panel renders <input type="password">
      placeholder: "xoxb-...",
      configKey: "apiKey",                    // Key in encrypted IntegrationConfig blob
      envVar: "SLACK_API_KEY",                // Becomes credentials.SLACK_API_KEY at runtime
      helpText: "Create a Slack app and get your Bot Token from ",
      helpLink: { text: "api.slack.com/apps", url: "https://api.slack.com/apps" },
    },
  ],
  testConfig: {
    getTestFunction: async () => {            // Lazy import: server-only test code
      const { testSlack } = await import("./test");
      return testSlack;
    },
  },
  actions: [
    {
      slug: "send-message",                   // Full ID: "slack/send-message"
      label: "Send Slack Message",
      description: "Send a message to a Slack channel",
      category: "Slack",
      stepFunction: "sendSlackMessageStep",   // Exported from steps/send-slack-message.ts
      stepImportPath: "send-slack-message",
      outputFields: [
        { field: "ts", description: "Message timestamp" },
        { field: "channel", description: "Channel ID" },
      ],
      configFields: [
        {
          key: "slackChannel", label: "Channel", type: "text",
          placeholder: "#general or {{NodeName.channel}}",
          example: "#general", required: true,
        },
        {
          key: "slackMessage", label: "Message", type: "template-textarea",
          placeholder: "Your message. Use {{NodeName.field}} to insert data from previous nodes.",
          rows: 4, example: "Hello from my workflow!", required: true,
        },
      ],
    },
  ],
};

registerIntegration(slackPlugin);              // The side effect of import
export default slackPlugin;
```

The matching step file (`plugins/slack/steps/send-slack-message.ts`) shows the **two-layer pattern** that AGENTS.md prescribes:

```ts
import "server-only";                          // Hard-fail if bundled into client
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
// ...types omitted...

// Layer 1: pure core. Receives credentials as a parameter. Reused by codegen.
async function stepHandler(
  input: SendSlackMessageCoreInput,
  credentials: SlackCredentials
): Promise<SendSlackMessageResult> {
  const apiKey = credentials.SLACK_API_KEY;
  if (!apiKey) return { success: false, error: "SLACK_API_KEY is not configured..." };
  try {
    const response = await fetch(`${SLACK_API_URL}/chat.postMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ channel: input.slackChannel, text: input.slackMessage }),
    });
    // ...
    return { success: true, ts: result.ts || "", channel: result.channel || "" };
  } catch (error) {
    return { success: false, error: `Failed to send Slack message: ${getErrorMessage(error)}` };
  }
}

// Layer 2: app entry point. Fetches credentials by ID and wraps in logging.
export async function sendSlackMessageStep(
  input: SendSlackMessageInput
): Promise<SendSlackMessageResult> {
  "use step";                                  // WDK directive — makes this a checkpoint
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};
  return withStepLogging(input, () => stepHandler(input, credentials));
}
sendSlackMessageStep.maxRetries = 0;           // WDK retry config
export const _integrationType = "slack";       // Marker for the codegen AST extractor
```

Key invariants enforced across all 14 plugins:
- `import "server-only"` at top of step files (`AGENTS.md:122`).
- Every step ends with a `"use step";` directive (so WDK records a step boundary).
- Step input includes `_context?: StepContext` for logging; `withStepLogging` (`lib/steps/step-handler.ts:169`) strips `_context`, `actionType`, `integrationId` before logging input (`INTERNAL_FIELDS` constant at `step-handler.ts:95`), and `redactSensitiveData` (`lib/utils/redact.ts`) scrubs the output. **Credentials are never on the step input** — only an opaque `integrationId` reference is.
- Result format is the discriminated union `{ success: true, data?: ... } | { success: false, error: { message: string } }` (per `AGENTS.md:88-99`). The interpreter and `withStepLogging` both unwrap `data` automatically.
- `dependencies` field is discouraged (`AGENTS.md:81-84`). All HTTP must use native `fetch`. The exception is `plugins/ai-gateway/index.ts:35-40`, which legitimately needs `ai`, `openai`, `@google/genai`, `zod`, and `linear/sdk` (kept in the legacy `@linear/sdk` import in `package.json` though no plugin actually uses it).
- `maxRetries = 0` is the conventional setting on every step (Slack, Linear, AI Gateway, etc.), suggesting the team disabled WDK's retry-on-throw semantics in favour of explicit `{ success: false }` returns. This means the interpreter does **not** rely on `RetryableError` / `FatalError` from WDK.

### 2.4 The plugin contract end-to-end

For one user click on "Add a Slack action":

1. **Discovery.** `getActionsByCategory()` (`registry.ts:296`) returns the full registry to the side-panel action grid (`components/workflow/config/action-grid.tsx`).
2. **Insertion.** The user picks an action; the canvas writes `node.data.config.actionType = "slack/send-message"` into Jotai.
3. **Configuration.** The side panel renders form fields by reading `findActionById("slack/send-message").configFields`, dispatching to `template-input` / `template-textarea` / `select` / `schema-builder` widgets (`components/workflow/config/action-config-renderer.tsx`). The user types a message; template variables `{{NodeName.field}}` are interactively converted to the canonical `{{@nodeId:Label.field}}` form by `template-badge-textarea.tsx`.
4. **Persistence.** `autosaveAtom` (`workflow-store.ts:77`) calls `api.workflow.update` after a 1s debounce, persisting nodes/edges as JSONB.
5. **Execution.** The interpreter (next section) dispatches `actionType: "slack/send-message"` to `getStepImporter(...)`, which returns the auto-generated thunk in `lib/step-registry.ts`, which dynamically imports `plugins/slack/steps/send-slack-message.ts` and invokes `sendSlackMessageStep`.
6. **Export.** When the user "Downloads" the workflow, `lib/workflow-codegen-sdk.ts` reads the auto-generated codegen template from `lib/codegen-registry.ts`, which contains a portable copy of `stepHandler` rewritten to use `fetchCredentials("slack")`, plus the original Slack-API-call body.

---

## 3. The two execution paths

### 3.1 Interpreter (`lib/workflow-executor.workflow.ts`)

`executeWorkflow` (line 376) is itself a WDK function — it carries `"use workflow";` at line 377. The route handler at `app/api/workflow/[workflowId]/execute/route.ts:33` invokes it via `start(executeWorkflow, [...])` from `workflow/api`, which puts the run on the WDK queue. The interpreter never blocks the request; the API returns `{ executionId, status: "running" }` immediately (line 138-141 of the route).

Pipeline:

1. **Build maps.** `nodeMap` and `edgesBySource` (`workflow-executor.workflow.ts:394-400`).
2. **Find triggers.** Nodes of type `trigger` with no incoming edges (`:404`).
3. **Execute each trigger** in parallel via `Promise.all(triggerNodes.map(executeNode))` (`:696`).
4. **`executeNode(nodeId, visited)`** (`:438`):
   - Cycle guard via `visited` set.
   - Disabled nodes (`enabled === false`) emit a `null` output and continue traversal (`:454-468`). This is what makes `{{NodeName.field}}` resolve to `""` instead of throwing in templates.
   - Trigger nodes: invoke `triggerStep` from `lib/steps/trigger.ts` with merged `triggerInput` + parsed `webhookMockRequest` if present (`:486-506`). Result is `{ triggered: true, timestamp, ...mockData }`.
   - Action nodes: pull `actionType` from config; if missing → error result. Otherwise call `processTemplates(config, outputs)` to substitute `{{@nodeId:Label.field}}` in every string-valued config key (`:284-371`). The `condition` key is stripped from this pre-pass and re-attached unprocessed because conditions need expression evaluation, not string substitution.
   - Dispatch via `executeActionStep` (`:217`):
     - **Special case: `Condition`.** Calls `evaluateConditionExpression` (`:136`), which validates the expression with `preValidateConditionExpression` then `validateConditionExpression` (both in `lib/condition-validator.ts`), substitutes templates with `__v0`, `__v1`... variables, and runs the expression with `new Function(...varNames, "return (...);")`. Both expression and resolved values are passed to `conditionStep` for logging.
     - **System actions** (`Database Query`, `HTTP Request`): in-file `SYSTEM_ACTIONS` map at `:21-37`.
     - **Plugin actions:** `getStepImporter(actionType)` from the auto-generated `lib/step-registry.ts`, then call the named export.
     - **Unknown:** structured error string explaining the registry miss.
5. **Result handling.** The interpreter unwraps the discriminated union: if `result.success === false`, it pulls `error.message` (or legacy string) into the node's `result.error`. Otherwise it stores `data: stepResult` (the **wrapped** form, not the unwrapped) in `outputs[sanitizedNodeId]` (`:622`). This wrapped form is what the auto-unwrap logic in `processTemplates` (`:331-341`) and `replaceTemplateVariable` (`:91-102`) skip past when they see `{ success, data, error }`.
6. **Edge traversal.** `Promise.all(nextNodes.map(executeNode))` for non-condition nodes (`:673`). For condition nodes, only traverse if `result.data.condition === true` (`:648`); both branches are then traversed in parallel. **There is no explicit "true branch / false branch" — both children of a condition node are taken iff condition is true.** That's why the AI prompt (section 4) tells the LLM to make two condition nodes for if/else.
7. **Final report.** `triggerStep` is invoked one more time with a `_workflowComplete` payload (`:710-718`), which writes the overall status to `workflow_executions`.

#### Errors and retries

There is no use of WDK's `RetryableError`/`FatalError`. Plugin steps return `{ success: false, error: ... }` instead of throwing, and `withStepLogging` (`step-handler.ts:189-205`) classifies the result by the discriminator. The interpreter sets `maxRetries = 0` on every step. So **retries are off by design** — the team uses error envelopes, not WDK retry semantics.

### 3.2 Codegen (`lib/workflow-codegen.ts` + companions)

`generateWorkflowCode(nodes, edges, options)` walks the same graph and emits a TypeScript function body. The result starts with `"use workflow";` and looks like:

```ts
import { sendSlackMessageStep } from '...';

export async function executeWorkflow<TInput>(input: TInput) {
  "use workflow";

  // Action: Send Slack Message
  const sendSlackMessage = await sendSlackMessageStep({
    slackChannel: "#general",
    slackMessage: `Hello ${input.userName}`,
  });
}
```

Steps the codegen takes that the interpreter does not:
- **Variable naming.** `toFriendlyVarName(label, actionType)` (in `workflow-codegen-shared.ts`) turns "Send Slack Message" into `sendSlackMessage`. Uniqueness is ensured by appending counters (`:88-94`).
- **Template → JS expression.** `convertTemplateToJS` (`:203`) rewrites `{{@nodeId:Label.field}}` into either `${varName.field}` (inside template literals) or `varName.field` (inside JS expressions, used for `if (...)` conditions). The `processAtFormat` / `processDollarFormat` family at `:105-200` handles both `@` and `$` template flavours.
- **Dead-code elimination.** `analyzeNodeUsage(nodes)` (in shared) returns the set of node IDs whose outputs are referenced by templates. If a node's output is unused, `removeVariableAssignment` (`:742`) drops the `const varName =` and emits a bare `await ...({...});` call.
- **Condition emission.** Generates `if (cond) { ... } else { ... }` taking the first edge as true-branch, second as false-branch (`:850-873`). Note: this **diverges from the interpreter's behaviour** (which AND-conditions both children). The codegen path treats the first/second children as if/else; the interpreter takes both children iff true. This is a real semantic gap — see section 7.
- **Parallel branches.** When a non-condition node has multiple downstream children, codegen emits `await Promise.all([(async () => { ... })(), (async () => { ... })()])` (`:1031-1056`).
- **Per-action emitters.** There are dedicated emitters for `Generate Text`, `Generate Image`, `Send Email`, `Send Slack Message`, `Create Ticket`, `Scrape`, `Search`, `Create Chat`, `Send Message`, `Database Query`, `HTTP Request` (`:702-833`). For everything else, `generatePluginActionCode` (`:655`) walks `findActionById(actionType).configFields`, type-dispatches with `formatFieldValue` (`:632`), and emits a generic `stepFn({ ...fields })` call. This is a leaky design — `Send Slack Message` has bespoke logic even though `generatePluginActionCode` would handle it. The bespoke emitters predate the auto-generated codegen registry.

The companion `lib/workflow-codegen-sdk.ts` (736 lines, not exhaustively read) handles the **export-to-standalone-project** flow: it bundles the generated workflow file with `lib/next-boilerplate/` (a complete Next.js scaffold with `package.json`, `tsconfig.json`, `app/page.tsx`) and the auto-generated step templates from `lib/codegen-registry.ts`, zips them with `jszip` (per `package.json:48`), and serves a download. This is the team's bet on "your visual workflow becomes a real, forkable Next app you own."

### 3.3 When does each get used?

| Path | Triggered by | Purpose |
|------|--------------|---------|
| Interpreter | "Run" button → `POST /api/workflow/[workflowId]/execute` → `start(executeWorkflow, ...)` | Live execution from the canvas. Fast iteration. Steps run on WDK with full observability. |
| Codegen (in-app) | "View Code" tab in the toolbar → `GET /api/workflows/[id]/code` | Show the user what their workflow looks like as TS. Read-only Monaco view. |
| Codegen (export) | "Download" button → `GET /api/workflows/[id]/download` | Hand the user a zipped Next project they can `vercel deploy` themselves. |

The two paths exist because the bet is "JSON for the LLM, TS for the human." The JSON form is the LLM-editable canonical store. The TS form is the human-readable, forkable artifact. Both paths converge on WDK steps with `"use step"` directives, so the runtime semantics are *intended* to match — but as the if/else divergence above shows, they don't quite.

---

## 4. The AI op-log route

### 4.1 The full op type

From `app/api/ai/generate/route.ts:7-26`:

```ts
type Operation = {
  op:
    | "setName"
    | "setDescription"
    | "addNode"
    | "addEdge"
    | "removeNode"
    | "removeEdge"
    | "updateNode";
  name?: string;
  description?: string;
  node?: unknown;
  edge?: unknown;
  nodeId?: string;
  edgeId?: string;
  updates?: {
    position?: { x: number; y: number };
    data?: unknown;
  };
};
```

Seven op types. Three creators (`setName`, `setDescription`, `addNode`/`addEdge`), two destroyers (`removeNode`, `removeEdge`), one mutator (`updateNode`) with a partial-update payload. **No `setCondition`, no `setConfigField`, no `connectIntegration`.** Every config change is expressed as `updateNode` with an opaque `data` blob.

### 4.2 Wire format

NDJSON (`Content-Type: application/x-ndjson`, `:357`). Each chunk from the model is line-buffered (`processBufferLines`, `:69`); each complete line is `JSON.parse`d and re-emitted to the client wrapped as:

```json
{"type": "operation", "operation": {"op": "addNode", "node": {...}}}\n
```

…and at the end:

```json
{"type": "complete"}\n
```

Or on failure:

```json
{"type": "error", "error": "..."}\n
```

The server lightly defends against the model breaking format: blank lines and lines starting with `` ``` `` are skipped (`shouldSkipLine`, `:32`), invalid JSON lines are logged and dropped (`tryParseAndEnqueueOperation`, `:63`).

### 4.3 The client applier

`lib/api-client.ts:185-207` is the canvas-side dispatcher:

```ts
const operationHandlers: Record<string, OperationHandler> = {
  setName: handleSetName,
  setDescription: handleSetDescription,
  addNode: handleAddNode,
  addEdge: handleAddEdge,
  removeNode: handleRemoveNode,
  removeEdge: handleRemoveEdge,
  updateNode: handleUpdateNode,
};

function applyOperation(op, state) {
  if (!op?.op) return;
  const handler = operationHandlers[op.op];
  if (handler) handler(op, state);
}
```

Each handler is a tiny pure mutation. `handleAddNode` appends; `handleRemoveNode` cascades by also dropping all edges that touch the removed node (`:148-150`); `handleUpdateNode` does a shallow merge of `position` and a deep-merge of `data` (`:170-180`). After each op, the in-memory `state.currentData` is shipped to `onUpdate(...)` — which is `setNodes/setEdges/setName` in the Jotai store (`components/ai-elements/prompt.tsx:107-148`) plus a `fitView({ padding: 0.2, duration: 200 })` so the camera tracks the growing graph.

The result is exactly the user-visible behaviour: nodes pop into the canvas one at a time as the model produces them, edges connect them seconds later, and the camera pans to keep them framed. **This is the streamed EditOp loop that Thodare has been describing as the World abstraction.**

### 4.4 The model + prompt strategy

Model: `"openai/gpt-5.1-instant"` (`route.ts:328`) routed through Vercel AI Gateway (`AI_GATEWAY_API_KEY` env var, falling back to `OPENAI_API_KEY`). The `streamText` call comes from the `ai` SDK; its `textStream` async iterable is the upstream that `processOperationStream` reads.

The system prompt (`getSystemPrompt`, `:134-247`) is ~110 lines and remarkable in three ways:

1. **Hard format contract.** "Output your workflow as INDIVIDUAL OPERATIONS, one per line in JSONL format." "NEVER output explanatory text." "Do NOT wrap in markdown code blocks." This is a JSONL fence — and the server-side line buffer is what enforces it.
2. **Dynamic action enumeration.** `pluginActionPrompts` is computed by `generateAIActionPrompts()` from `plugins/registry.ts:521-560`, which walks the registry and emits one line per action like:
   ```
   - Send Slack Message (slack/send-message): {"actionType":"slack/send-message","slackChannel":"#general","slackMessage":"Hello from my workflow!"}
   ```
   Each example uses `field.example`, then `field.defaultValue`, then a sensible default by type. **The plugin registry is literally the LLM's tool catalog** — adding a plugin extends the LLM's capabilities with no prompt edit.
3. **Layout coaching.** "Nodes are squares, so use equal spacing in both directions. Horizontal spacing 250px. Vertical spacing for parallel branches: 250px. Start trigger node at {x:100, y:200}." — a real attempt to prevent overlapping nodes by giving the LLM a coordinate system and worked examples for both linear and branching cases.
4. **Condition semantics.** Explicit warning: "When TRUE: ALL connected nodes execute. When FALSE: ALL connected nodes are SKIPPED. For if/else logic, CREATE MULTIPLE SEPARATE condition nodes (one per branch)." This matches the **interpreter's** semantics exactly. The codegen's if/else semantics are not mentioned to the LLM.

For "modify existing workflow" requests, the prompt is augmented (`:298-324`) with the current node list, edge list, and the full JSON, plus very explicit instructions: "Output ONLY the operations needed to make the requested changes." The LLM is being asked to produce a **diff** as ops, not a full re-emit. There is no transactional grouping — ops just stream.

### 4.5 Authorization + rate limits

`auth.api.getSession` is required (`:251`). Beyond auth, there is **no rate limiting, no token budget, no abuse defence**. The server checks `process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY` exists and forwards the request. This is fine for a template; not fine for a hosted multi-tenant Thodare deployment.

---

## 5. The Drizzle schema

From `lib/db/schema.ts`. Nine tables:

| Table | Columns of note | Role |
|-------|-----------------|------|
| `users` | `id text PK`, `email text unique`, `name`, `image`, `email_verified bool`, `is_anonymous bool` | Better Auth user table. Anonymous users persist until they link an account. |
| `sessions` | `id text PK`, `token text unique`, `user_id FK`, `expires_at`, `ip_address`, `user_agent` | Better Auth session. |
| `accounts` | `provider_id`, `account_id`, `access_token`, `refresh_token`, `password`, ... | Better Auth's identity-provider link table. Vercel/GitHub/Google tokens live here. |
| `verifications` | `identifier`, `value`, `expires_at` | Better Auth email/OTP verification. |
| `workflows` | `id text PK ($defaultFn nanoid)`, `name`, `description`, `user_id FK`, `nodes jsonb`, `edges jsonb`, `visibility text default 'private'`, `created_at`, `updated_at` | The workflow JSON. **Single owner** via `user_id`. **No version history** — autosave overwrites. |
| `integrations` | `id text PK`, `user_id FK`, `name`, `type text` (the `IntegrationType` union), `config jsonb`, `is_managed bool default false`, timestamps | Per-user credential store. `config` is **encrypted at rest** (see section 6.2). `is_managed=true` for OAuth-flow integrations like the AI Gateway managed key. |
| `workflow_executions` | `id text PK`, `workflow_id FK`, `user_id FK`, `status text` (`pending|running|success|error|cancelled`), `input jsonb`, `output jsonb`, `error text`, `started_at`, `completed_at`, `duration text` | One row per run. `duration` is stored as `text` (ms as string) — minor quirk. |
| `workflow_execution_logs` | `id`, `execution_id FK`, `node_id`, `node_name`, `node_type`, `status`, `input jsonb`, `output jsonb`, `error`, timestamps + `duration text` | One row per node run. Written by `withStepLogging` via `logStepStartDb` / `logStepCompleteDb` in `lib/workflow-logging.ts`. The `output` and `input` here have already been passed through `redactSensitiveData`. |
| `api_keys` | `id`, `user_id FK`, `name`, `key_hash`, `key_prefix`, `last_used_at` | For webhook trigger auth. Hashed; only the prefix is shown back to the user. |

There are **no indexes declared in the schema** beyond the implicit primary keys and the unique constraints on `users.email` and `sessions.token`. Hot paths like "list executions for a workflow" and "list logs for an execution" will rely on Postgres planner choices — likely fine at template scale, will need indexing in production.

The single `relations(...)` block (`:167-175`) connects `workflowExecutions` back to `workflows`. There are no `relations` for the other tables, which means Drizzle's relational query API only works for that one direction; everything else uses raw `eq` joins.

There is **no `tenants` table.** Multi-tenancy is purely "one user owns it" via `user_id` FKs. Sharing a workflow is a special case: `workflows.visibility = 'public'` flips the read-permission check in `app/api/workflows/[workflowId]/route.ts`. There is no concept of teams or organizations.

---

## 6. Auth + multi-tenancy

### 6.1 Better Auth setup

`lib/auth.ts` exports a single `auth` object. Configuration:

- **Database:** `drizzleAdapter(db, { provider: "pg", schema })`. The `schema` object aliases `users → user`, etc., to match Better Auth's naming (`:20-29`).
- **Email/password:** enabled, `requireEmailVerification: false` (`:148-151`).
- **Social:** GitHub and Google, both enabled iff their `*_CLIENT_ID` env vars are set (`:152-163`).
- **Anonymous plugin** (`:57-97`): users can use the app without signing up; their workflow/integration/execution rows are tagged with the anonymous user ID. When they later link a real account, `onLinkAccount` runs three `UPDATE` statements to migrate ownership (`:69-84`). This is the mechanism that lets the homepage canvas be usable before signup.
- **Vercel OAuth** (`:98-139`): conditionally added if `VERCEL_CLIENT_ID` is set. Used for the AI Gateway "managed user keys" flow — when consent is granted, the app gets a Vercel API token with `read-write:team` scope (`:111-113`) iff `isAiGatewayManagedKeysEnabled()`, which is then used to mint a per-user AI Gateway API key on Vercel's side.
- **Base URL detection** (`:33-53`): four-level fallback (`BETTER_AUTH_URL` → `NEXT_PUBLIC_APP_URL` → `VERCEL_URL` → `localhost:3000`). Vercel preview deployments work because each has a fresh `VERCEL_URL`.

`lib/auth-client.ts` is the client-side companion. Auth is wired through React context (`components/auth/provider.tsx`).

### 6.2 How secrets are scoped

This is the load-bearing security model:

1. **Per-user storage.** `integrations.user_id` is checked on every read. `getIntegrationById` (in `lib/db/integrations.ts`) and `validateWorkflowIntegrations` ensure a user can only resolve credential references they own. The execute route (`app/api/workflow/[workflowId]/execute/route.ts:96-109`) re-validates that all `integrationId`s referenced in the workflow JSON belong to the calling user before kicking off execution.
2. **Encryption at rest.** `lib/db/integrations.ts:18-76` reads a 32-byte hex key from `INTEGRATION_ENCRYPTION_KEY` (mandatory), AES-256-GCM-encrypts the `IntegrationConfig` JSON, and stores `iv:authTag:ciphertext` (all hex) in `integrations.config`. `decryptConfig` is the only path back. **If the env var is missing or wrong length, encryption throws** — the app fails closed.
3. **Reference-not-value in the workflow JSON.** Workflow JSON only ever stores an `integrationId` (a nanoid). The actual credential blob is fetched by `fetchCredentials(integrationId)` at step runtime (`lib/credential-fetcher.ts:69`). This is what keeps creds out of the workflow JSON entirely — meaning the **LLM never sees them**, the canvas never sees them, the export never embeds them.
4. **Logging redaction.** `withStepLogging` strips `_context, actionType, integrationId` from inputs before logging (`lib/steps/step-handler.ts:95-108`), and `redactSensitiveData` further scrubs values matching credential-like patterns. So even if a step accidentally returned a credential in its output, it would be redacted before hitting `workflow_execution_logs`.
5. **Server-only enforcement.** All step files start with `import "server-only";` (Next.js will refuse to bundle them into client code). `lib/credential-fetcher.ts` likewise.

The `formFields` / `configKey` / `envVar` mapping in the plugin definition (section 2.1) is the bridge: when a user fills the integration form, `configKey` says where in the encrypted `config` blob to store the value; `envVar` says under which key to expose it inside the credentials object that the step receives. The LLM only sees `formFields` *labels and placeholders* via the action prompt generator — never any actual credential value.

### 6.3 What "multi-tenant" means here

There is exactly **one tenant primitive: `users.id`**. No teams. No organizations. No RBAC. Sharing is binary (`visibility=public` makes a workflow readable by anyone, with no ACL granularity). For Thodare's "one customer can have multiple users on their world" model, this is missing the entire team layer.

---

## 7. Top 10 surprises

1. **No version history on workflows.** `autosaveAtom` (`workflow-store.ts:77`) overwrites `workflows.nodes/edges` on every change. Undo/redo is **client-side-only** via `historyAtom`/`futureAtom` in Jotai (`workflow-store.ts:509-565`). Refresh the page mid-edit and your undo stack is gone. For an LLM-edited graph this is genuinely worrying — you cannot revert an AI mistake after the autosave debounce fires.
2. **The interpreter and codegen disagree on condition semantics.** Interpreter: when `condition === true`, both children execute in parallel (`workflow-executor.workflow.ts:648-658`). Codegen: emits `if (cond) { ...firstChild... } else { ...secondChild... }` (`workflow-codegen.ts:850-873`). The system prompt teaches the LLM the **interpreter's** semantics ("create two condition nodes for if/else"). A workflow that runs correctly via the interpreter may behave differently when downloaded as a standalone project.
3. **Two file path conventions in templates.** `{{@nodeId:DisplayName.field}}` vs `{{$nodeId.field}}` are both supported by the codegen (`processAtFormat` and `processDollarFormat` at `:105-200`). The interpreter only handles the `@`-flavoured one (`:294`). The dollar form appears to be legacy from an earlier syntax. The label-rename code (`workflow-store.ts:298-329`) only updates the `@`-flavoured templates.
4. **The plugin AI prompt is generated at request time, not cached.** `getSystemPrompt()` calls `generateAIActionPrompts()` on every `POST /api/ai/generate` (`route.ts:135`). Walks the entire registry, builds JSON example configs, joins lines. Cheap, but means changes to the registry hot-reload into the prompt with no cache to bust.
5. **Auto-generated codegen registry is escape-string magic.** `discover-plugins.ts:546-553` reads each `stepHandler` body, escapes backticks and `${`, and emits it into `lib/codegen-registry.ts` as a backtick-quoted string literal. If a plugin author writes a backslash in their step body, the escape gets `\\\\`-doubled. If they use a template literal inside a step, the `${` gets escaped to `\${`. This works because the AGENTS.md prescribes simple-shape step files, but it's brittle.
6. **`maxRetries = 0` on every step.** WDK supports retry-on-throw with `RetryableError`; this template explicitly disables it on every plugin step (Slack `:104`, Linear `:177`, AI Gateway). The team chose the discriminated-union envelope (`{success, error}`) instead of throw-based control flow. That means **WDK's retry/checkpoint machinery is largely unused** by this template — they're using WDK mostly for observability and the `start()` queue.
7. **The execute route does not await execution.** `executeWorkflowBackground` is called without `await` (`execute/route.ts:129-135`). The HTTP response returns `{ executionId, status: "running" }` synchronously. The actual workflow runs on WDK's background queue. Polling for status is the client's problem.
8. **The interpreter sanitizes node IDs into JS-identifier-safe variable names** (`nodeId.replace(/[^a-zA-Z0-9]/g, "_")`, used in `outputs[sanitizedNodeId]` at `:621`). This means two nodes named `node-1` and `node!1` collide. nanoid IDs (the default) sidestep this, but legacy or AI-generated workflows with custom IDs could trip it.
9. **The canvas has no multi-user collaboration.** No CRDT, no presence, no realtime sync. Two browser tabs editing the same workflow will race on the autosave overwrite. The 1s debounce makes the race wider, not narrower.
10. **Output rendering supports custom React components per plugin** (`OutputDisplayConfig.type === "component"` at `registry.ts:114-119`), but the auto-generated `lib/output-display-configs.ts` deliberately filters those out (`discover-plugins.ts:763-771`) because component types can't be serialized to JSON — they're imported separately at runtime. So plugins can ship custom result renderers but only via their own React tree, not via the auto-generated registry.

---

## 8. Implications for Thodare

### 8.1 For the builder-UI spike (`next-up.md:211`)

**What's portable, with low effort:**

- **The plugin registry shape.** `IntegrationPlugin` + `PluginAction` + `ActionConfigField` are essentially Thodare's `Block` definition with extra UI metadata (`label`, `placeholder`, `helpText`, `helpLink`). The split between a declarative TS spec (`index.ts`) and a runtime function (`steps/<slug>.ts`) maps cleanly onto Thodare's "Block defines schema, Tool implements it." The auto-discovery script (`scripts/discover-plugins.ts`) is well-engineered and could be lifted with attribution.
- **The streaming op-log route.** `app/api/ai/generate/route.ts` is ~370 lines including the prompt; the seven-op surface is small enough that we could re-implement it on day one for Thodare. The shape and semantics are battle-tested in this template — we can take it as confirmed.
- **The React Flow canvas.** `components/workflow/workflow-canvas.tsx` (587 lines) plus `components/ai-elements/*` (~10 files) and `components/workflow/nodes/*`. This is an opinionated, well-shaped canvas with: drag-to-create-node, drag-to-connect, autosave, undo/redo, context menus, fit-to-view, mobile gestures. Bundle cost: `@xyflow/react@12.9` is ~150KB gzipped, plus the AI elements and shadcn components. Not free, but not a deal-breaker.
- **Credential vault pattern.** The `integrationId`-as-reference + AES-256-GCM-at-rest + `formFields.envVar` mapping is exactly what Thodare needs. Better Auth's per-user scoping is the simplest path to multi-tenant if we don't yet need teams.

**What's not portable, or needs serious rework:**

- **No teams / orgs / RBAC.** Thodare's "World" is multi-tenant by definition. We would need to add a `teams` table, `team_memberships`, and rewrite every `where userId = ?` to `where teamId in (...)`. Better Auth has an org plugin but the template doesn't use it. Cost: meaningful but bounded.
- **No version history.** Thodare's whole bet is on `EditOp` as an audit log of LLM edits. The template overwrites on autosave. We'd need an `edit_ops` table and a "current = fold(initial, ops)" model — which is basically what we already plan, but we cannot adopt the template's autosave wholesale.
- **Two interpreters that disagree.** The interpreter/codegen split is interesting (Thodare wants both "JSON for the LLM, code for the human"), but the if/else divergence and the bespoke-emitter-per-action codegen pattern are technical debt. We should pick one execution model and have the other generate from it.
- **Coupled to Vercel WDK.** `"use workflow"` and `"use step"` are SWC plugin directives provided by `workflow@4.0.1-beta.17`. They give you queueing, observability, and retries — but locking the runtime to Vercel is exactly what Thodare is trying to avoid as a "self-hostable" project. We could keep the *shape* (steps as functions, workflow as orchestrator) without the WDK plugin.
- **No rate limiting on the AI route.** Trivial to add, but worth flagging — for a hosted Thodare this is a billing exposure.
- **The bespoke-action-emitter codegen.** `workflow-codegen.ts` has hand-written emitters for ~10 action types plus a generic plugin path. We should not adopt the bespoke ones; the auto-generated codegen-registry approach (`lib/codegen-registry.ts` + `scripts/discover-plugins.ts`) is the right pattern.

**Verdict for the spike:** the template is ~70% portable as a builder UI, and the 30% that isn't (teams, version history, WDK lock-in) maps to changes Thodare was already going to make. The right move is **not to fork** — instead, lift the canvas + plugin-registry shape + streaming-op-log shape into Thodare's repo as deliberately re-implemented modules, with attribution to the Apache-2.0 source. Forking would inherit too much Vercel-specific machinery (WDK directives, AI Gateway, Vercel SDK, OAuth flow) that Thodare doesn't need.

### 8.2 For the World abstraction proposal

The streaming op-log route is **the closest analogue to Thodare's EditOp loop in the wild**, and it works. Three things this template's existence validates:

1. **A small op surface is enough.** Seven ops (`setName`, `setDescription`, `addNode`, `addEdge`, `removeNode`, `removeEdge`, `updateNode`) cover a complete LLM-editable graph builder. Thodare's planned EditOp set should not be larger by default; if we need more, we should justify each one.
2. **NDJSON over fetch is the right transport.** Not SSE, not websockets — just `Content-Type: application/x-ndjson` with line-buffered parsing on both ends. Survives proxies, easy to debug with `curl`, and the AI SDK's `streamText` API hands you exactly the right shape.
3. **The plugin registry IS the LLM tool catalog.** `generateAIActionPrompts()` reading from the registry to build the system prompt — with `field.example` used to make synthetic config blobs the LLM can copy — is a clean way to keep the model and the runtime in sync. Thodare should make Block definitions carry `example` values for the same reason.

What this template's design **challenges** about Thodare's plan:

1. **The lack of transactional grouping is a feature, not a bug.** The template streams individual ops without any `beginTransaction`/`commit` envelope. The LLM produces an op, the server validates it, the client applies it, the camera moves. No batching. This works because each op is independently valid (an `addEdge` to a not-yet-added target is harmless — the canvas just shows a dangling edge until the target arrives microseconds later). Thodare's EditOp loop should consider whether transactional grouping is necessary at all, or whether per-op streaming is sufficient.
2. **The LLM is the planner; the canvas is the truth.** There's no central state machine that "owns" the workflow — the Jotai atoms are mutated directly by the op handler, then debounced to the database. The LLM is producing ops *into the same in-memory store the user is editing*. There's no "AI working copy" / "user working copy" merge. This is simpler than Thodare's mental model and is worth seriously considering.
3. **Diff-mode prompting works without OT/CRDT.** When the user asks for a modification, the route prepends the existing nodes/edges to the prompt and asks the LLM for ops-as-a-diff (`route.ts:298-324`). This is a much lighter-weight way to do collaborative editing than full operational transformation — and the template ships it.
4. **Conditions break the symmetry.** The interpreter runs both children of a true condition in parallel; the codegen treats them as if/else. The system prompt sides with the interpreter and tells the LLM to use multiple condition nodes. This is the kind of subtle gap Thodare's `Block.semantics` formalization should rule out. The lesson: **define block execution semantics in one place, and make both runtime and exporter derive from that definition** — do not let two implementations co-exist.

### 8.3 Concrete artifacts to lift

If the spike concludes "yes, build on this," these are the low-hanging targets:

- `plugins/registry.ts` (561 lines, MIT-clean, almost type-only) — port wholesale, rename `IntegrationPlugin` → `Block`.
- `scripts/discover-plugins.ts` (864 lines, AST-based) — port the discovery + step-registry generation. Drop the WDK-specific `"use step"` weaving in `generateCodegenTemplate`.
- `app/api/ai/generate/route.ts` (374 lines) — port the NDJSON op streaming + system prompt structure. Keep the dynamic action prompt; reconsider hard-coding `gpt-5.1-instant`.
- `lib/api-client.ts:185-317` — port the client-side stream parser + op handlers.
- `components/ai-elements/*` — these are explicitly "AI elements" primitives from Vercel and may already be available standalone via `@ai-sdk/elements`. Worth checking before re-implementing.
- `lib/credential-fetcher.ts` + `lib/db/integrations.ts` (the encrypt/decrypt helpers) — port wholesale; trivial to lift.
- `lib/steps/step-handler.ts` — the `withStepLogging` + `StepInput`/`StepContext` pattern is the right shape. Drop the WDK-specific bits.

Bundle-cost thought: the canvas alone (`@xyflow/react` + `motion` + `react-resizable-panels` + `monaco-editor` + `vaul` + the various Radix primitives + `lucide-react`) is the largest single addition. If Thodare wants a lightweight builder shell, we may want to lazy-load Monaco and consider a smaller flow library, but `@xyflow/react` is the de-facto choice for this kind of canvas and the ergonomics are hard to beat.

---

## Executive summary

This Apache-2.0 template is the most coherent reference implementation of "LLM-driven visual workflow builder" we have seen in the wild. Three architectural decisions are particularly load-bearing and worth Thodare's attention.

First, the **plugin registry is the source of truth for everything**: the canvas action grid, the side-panel form fields, the runtime step dispatcher, the LLM's tool catalog, and the standalone-project codegen are all driven from one declarative `IntegrationPlugin` per integration plus an auto-discovery script that emits five generated files. Adding a plugin extends every layer at once. Second, the **AI route streams NDJSON of seven simple `Operation` types** (`setName`, `setDescription`, `addNode`, `addEdge`, `removeNode`, `removeEdge`, `updateNode`); the client applies them incrementally to a Jotai store and the camera tracks the growing graph. This is the closest analogue to Thodare's EditOp loop in the wild, and it works without any CRDT or transactional grouping. Third, **credentials are referenced by `integrationId` only** in the workflow JSON; AES-256-GCM-encrypted blobs live in a per-user `integrations` table and are fetched at step runtime, never logged, never seen by the LLM.

The downsides for Thodare adoption: no teams/RBAC, no version history (autosave overwrites), the interpreter and codegen disagree on condition semantics, and the runtime is locked to Vercel's WDK via `"use workflow"`/`"use step"` SWC directives. The right move is to **deliberately re-implement** the canvas, plugin registry, and op-log route in Thodare's repo (with attribution) rather than fork — the un-portable 30% (teams, history, WDK) is exactly what Thodare differentiates on.

File: `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/workflow-builder-template.md`
