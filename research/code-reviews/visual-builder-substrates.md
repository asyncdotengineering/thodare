# Visual-Builder Substrates: Can Thodare's Primitives Host n8n / ActivePieces / Sim Studio?

**Status:** code review, alpha. **Read date:** 2026-05-02. **Reviewer brief:** "is Thodare's `Block` / `Tool` / `hidden()` / `EditOp` substrate sufficient to be the headless durable backend for visual workflow builders, or is there impedance mismatch we have to fix before claiming that?"

The bar for this review is **the source code, not marketing**. Every structural claim cites file:line. Every connector/property/op type is quoted verbatim. The sources read live as siblings of `thodare/` at:

- `n8n-io/n8n` — Sustainable Use License (n8n Inc.). Source: `n8n/LICENSE.md:1-16`. n8n forbids use as a "hosted or managed service" without a commercial license; ports of the *interfaces* (e.g. reading `INodeProperties` to design our own loader) are fine, but redistributing n8n nodes inside a hosted Thodare service is not.
- `activepieces/activepieces` — MIT for community pieces (Apache 2.0 wrapper at the top of the monorepo, but `packages/pieces/community/*` are MIT); the framework package is MIT-compatible. Source: `activepieces/LICENSE:1-3`.
- `simstudioai/sim` — Apache-2.0. Source: `sim/LICENSE:1-3`. This is the project Thodare's `EditOp` model was forked from; the inheritance verification section below is the heart of the review.

The Thodare pieces being measured against these:

- `thodare/packages/engine/src/types.ts` — the canonical `Block`, `Tool`, `SubBlock`, `EditOp`, `SerializedWorkflow` definitions
- `thodare/packages/engine/src/operations/apply.ts` — the skip-don't-reject patch loop
- `thodare/packages/engine/src/define/visibility.ts` — `hidden()` / `userOnly()` / `userOrLlm()` brand markers
- `thodare/packages/engine/src/runner/walk.ts` — the runtime walker

---

## §1 Sim Studio — the direct ancestor

Sim Studio is the source Thodare's connector model was lifted from, so this section is longer and goes first. **The headline finding: Thodare's documented "5-op set" is wrong both in the user's brief and in the doc-comments. Both Sim and Thodare have 5 ops, but the sets do not match.**

### §1.1 Sim's connector primitive — `BlockConfig`

`sim/apps/sim/blocks/types.ts:338-373`:

```ts
export interface BlockConfig<T extends ToolResponse = ToolResponse> {
  type: string
  name: string
  description: string
  category: BlockCategory                    // 'blocks' | 'tools' | 'triggers'
  integrationType?: IntegrationType
  tags?: IntegrationTag[]
  longDescription?: string
  bestPractices?: string
  docsLink?: string
  bgColor: string
  icon: BlockIcon
  subBlocks: SubBlockConfig[]
  triggerAllowed?: boolean
  authMode?: AuthMode                        // OAuth | ApiKey | BotToken
  singleInstance?: boolean
  tools: {
    access: string[]
    config?: {
      tool: (params: Record<string, any>) => string
      params?: (params: Record<string, any>) => Record<string, any>
    }
  }
  inputs: Record<string, ParamConfig>        // typed param schema (separate from subBlocks)
  outputs: Record<string, OutputFieldDefinition> & { ... }
  hideFromToolbar?: boolean
  triggers?: { enabled: boolean; available: string[] }
}
```

A few things to absorb:

1. **`subBlocks` is the UI render schema; `inputs` is the typed param schema.** They live side by side. Thodare collapses these — Thodare's `Block.subBlocks` is the only schema, and it does double duty as both UI spec and param contract (`thodare/packages/engine/src/types.ts:61-69`). The defineConnector helper at `thodare/packages/engine/src/define/connector.ts:75` builds both the Tool and the Block from one Zod schema.
2. **`tools.access` is a list of tool ids the block can dispatch to**, and `tools.config.tool(params)` resolves which one based on the `operation` subBlock value. Thodare keeps this verbatim — `thodare/packages/engine/src/types.ts:89-95`.
3. **`triggers.available: string[]`** — a block can declare a list of trigger types it can be morphed into. Thodare has no equivalent; trigger-vs-compute is fixed at `Block.kind` (`thodare/packages/engine/src/types.ts:79`).
4. **`integrationType`, `tags`, `authMode`, `bgColor`, `icon`, `docsLink`, `bestPractices`, `longDescription`** — all UI/discovery metadata. Thodare's `Block` has `name` and `description` and that's it.

### §1.2 Sim's `SubBlockConfig` — the UI render schema

`sim/apps/sim/blocks/types.ts:176-336` is 160 lines of detail. Highlights:

```ts
export interface SubBlockConfig {
  id: string
  title?: string
  type: SubBlockType                         // 28+ types: oauth-input, channel-selector, ...
  mode?: 'basic' | 'advanced' | 'both' | 'trigger' | 'trigger-advanced'
  canonicalParamId?: string                  // multiple subBlocks can map to the same param
  paramVisibility?: 'user-or-llm' | 'user-only' | 'llm-only' | 'hidden'
  required?: boolean | { field: string; value: ...; not?: boolean; and?: { ... } }
                       | ((values?) => { ... })
  defaultValue?: ...
  options?: Array<{ label: string; id: string; ... }> | (() => ...)
  // ... 40+ more fields ...
  reactiveCondition?: { watchFields: string[]; requiredType: 'oauth' | 'service_account' }
  fetchOptions?: (blockId: string) => Promise<Array<{ label: string; id: string }>>
  fetchOptionById?: (blockId: string, optionId: string) => Promise<...>
  wandConfig?: { enabled: boolean; prompt: string; ... }    // AI assistance per-field
  dependsOn?: string[] | { all?: string[]; any?: string[] }
  condition?: { field: string; value: ...; not?: boolean; and?: { ... } } | ((values) => ...)
}
```

Thodare's `SubBlock` (`thodare/packages/engine/src/types.ts:61-69`):

```ts
export interface SubBlock {
  id: string;
  title: string;
  type: "short-input" | "long-input" | "dropdown" | "json" | "oauth-input";
  required?: boolean;
  options?: Array<{ id: string; label: string }>;
  condition?: { field: string; value: string | string[]; not?: boolean };
  description?: string;
}
```

The diff is severe:

- **Sim has 28+ `SubBlockType` values** vs. Thodare's 5. Sim has `channel-selector`, `user-selector`, `file-selector`, `sheet-selector`, `folder-selector`, `project-selector`, `knowledge-base-selector`, `workflow-selector`, `document-selector`, `variables-input`, `mcp-server-selector`, `mcp-tool-selector`, `table-selector`, `table`, `code`, `slider`, `combobox`, `multi-select`, `file-upload`, `copyable-text`, `modal`, etc. (`sim/apps/sim/blocks/types.ts:124-139`, `sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/types.ts:5-16`).
- **Sim's `condition` accepts a function** — runtime conditional display computed against current form values. Thodare's `condition` is a static object only.
- **Sim has `mode` (basic/advanced)** for progressive disclosure. Thodare has nothing equivalent.
- **Sim has `reactiveCondition`** — gates a subBlock based on an asynchronously-fetched credential type. Thodare has nothing equivalent.
- **Sim has `fetchOptions` / `fetchOptionById`** — dropdowns can pull options dynamically (e.g., "list of channels for this Slack workspace"). Thodare has only a static `options` array.
- **Sim has `paramVisibility` with 4 values** — `'user-or-llm' | 'user-only' | 'llm-only' | 'hidden'`. Thodare has 3 — the `'llm-only'` (LLM-must-fill, not user-fillable; computed values) brand is missing.
- **Sim has `canonicalParamId`** — multiple UI-level subBlocks can write to the same logical param (e.g., the OAuth-input vs. the manual-bot-token-input both write to `oauthCredential`). Thodare has no equivalent; one subBlock = one param.

### §1.3 Sim's tool — `ToolConfig`

`sim/apps/sim/tools/types.ts:90-182`. The shape (verbatim, abridged):

```ts
export interface ToolConfig<P = any, R = any> {
  id: string; name: string; description: string; version: string;
  params: Record<string, {
    type: string;
    required?: boolean;
    visibility?: ParameterVisibility;        // 'user-or-llm'|'user-only'|'llm-only'|'hidden'
    default?: any;
    description?: string;
    items?: { type: string; description?: string; properties?: ... };
  }>;
  outputs?: Record<string, { type: OutputType; description?: string; optional?: boolean;
                              fileConfig?: { mimeType?; extension? }; items?: ...; properties?: ... }>;
  oauth?: OAuthConfig;                       // { required, provider, requiredScopes? }
  errorExtractor?: string;
  request: {
    url: string | ((params: P) => string);
    method: HttpMethod | ((params: P) => HttpMethod);
    headers: (params: P) => Record<string, string>;
    body?: (params: P) => Record<string, any> | string | FormData | undefined;
    retry?: ToolRetryConfig;                 // { enabled; maxRetries; initialDelayMs; ... }
  };
  postProcess?: (...);
  transformResponse?: (response: Response, params?: P) => Promise<R>;
  directExecution?: (params: P) => Promise<ToolResponse>;
  schemaEnrichment?: Record<string, SchemaEnrichmentConfig>;
  toolEnrichment?: ToolEnrichmentConfig;
  hosting?: ToolHostingConfig<P>;
}
```

Thodare's `Tool` (`thodare/packages/engine/src/types.ts:50-57`):

```ts
export interface Tool<TParams = any, TOut = any> {
  id: string;
  name: string;
  description: string;
  params: Record<string, ToolParamDef>;
  outputs: Record<string, ToolOutputDef>;
  execute: (params: TParams, ctx: ToolContext) => Promise<TOut>;
}
```

Notable Thodare gaps vs. Sim:

- **No declarative HTTP request builder.** Sim's `tools.config.request` lets a tool be entirely declarative — no JS in the action — which makes them serializable and portable. Thodare has only `execute()` (imperative). This matters for "import an n8n declarative node" — n8n's `requestDefaults` (`n8n/packages/workflow/src/interfaces.ts:2507`) is the same pattern.
- **No `oauth` config on the tool.** Thodare expects you to handle OAuth in `execute()` by reading from `ctx.env`. There's no field declaring "this tool requires Slack OAuth with scopes X, Y."
- **No retry config** (`ToolRetryConfig`).
- **No `directExecution` vs. HTTP path** — Sim distinguishes "no HTTP" vs. "HTTP + transformResponse." Thodare collapses both into `execute()`.
- **No schema enrichment** — Sim can rewrite a tool's parameter schema at LLM-call time based on a runtime value (e.g., once `tableId` is set, the `row` param's schema becomes the table's actual columns). Thodare has nothing equivalent.

### §1.4 Sim's visibility / hidden-from-display

The visibility brands are TS-string types, not Zod brands. There is also a separate `isHiddenFromDisplay` for **outputs** (so an output field can be hidden from the LLM but still populated):

`sim/packages/workflow-types/src/blocks.ts:75-88`:

```ts
export type OutputFieldDefinition =
  | PrimitiveValueType
  | {
      type: PrimitiveValueType
      description?: string
      condition?: OutputCondition
      hiddenFromDisplay?: boolean
    }

export function isHiddenFromDisplay(def: unknown): boolean {
  return Boolean(
    def && typeof def === 'object' && 'hiddenFromDisplay' in def && def.hiddenFromDisplay
  )
}
```

This is used at `sim/apps/sim/lib/copilot/tools/server/blocks/get-blocks-metadata-tool.ts:256` and `:280` to filter outputs before showing the LLM the catalog. Thodare has no equivalent for **outputs**: every declared output is shown to the LLM. This is a real gap if you want secrets to flow through the workflow data plane (e.g., a `getCredentials` block whose output you want to plumb to the next block but never let the LLM reason about).

### §1.5 Sim's EditOp — verbatim

`sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/types.ts:95-99`:

```ts
export interface EditWorkflowOperation {
  operation_type: 'add' | 'edit' | 'delete' | 'insert_into_subflow' | 'extract_from_subflow'
  block_id: string
  params?: Record<string, any>
}
```

That is the **complete** op-type set in current Sim. The handler dispatch table at `sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/engine.ts:26-32`:

```ts
const OPERATION_HANDLERS: Record<EditWorkflowOperation['operation_type'], OperationHandler> = {
  delete: handleDeleteOperation,
  extract_from_subflow: handleExtractFromSubflowOperation,
  add: handleAddOperation,
  insert_into_subflow: handleInsertIntoSubflowOperation,
  edit: handleEditOperation,
}
```

Connections in Sim are **embedded inside the `add`/`edit` op's `params.connections`**, not surfaced as separate `connect`/`disconnect` ops. Confirm at `sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/operations.ts:811-817`:

```ts
// Defer connection processing to ensure all blocks exist first (pass 2)
if (params.connections) {
  deferredConnections.push({
    blockId: block_id,
    connections: params.connections,
  })
}
```

And the wire format on disk is also "connections embedded in blocks":

`sim/apps/sim/lib/workflows/sanitization/json-sanitizer.ts:11-29`:

```ts
export interface CopilotWorkflowState {
  blocks: Record<string, CopilotBlockState>
}

export interface CopilotBlockState {
  type: string
  name: string
  inputs?: Record<string, string | number | string[][] | object>
  connections?: Record<string, string | string[]>      // ← embedded edges
  nestedNodes?: Record<string, CopilotBlockState>
  enabled: boolean
  advancedMode?: boolean
  triggerMode?: boolean
}
```

`connections` is keyed by **source handle name** (e.g., `'success'`, `'error'`, `'condition-uuid'`) → target block id(s). The flat `edges[]` array is a denormalization derived from this.

### §1.6 EditOp inheritance verification — the diff

| Op type | Sim | Thodare | Status |
|---|---|---|---|
| `add` | ✓ (with embedded connections + nestedNodes) | ✓ (no embedded connections, no nesting) | **diverged** |
| `edit` | ✓ | ✓ | match |
| `delete` | ✓ | ✓ | match |
| `insert_into_subflow` | ✓ | ✗ | **missing in Thodare** |
| `extract_from_subflow` | ✓ | ✗ | **missing in Thodare** |
| `connect` | ✗ | ✓ | **Thodare-original** |
| `disconnect` | ✗ | ✓ | **Thodare-original** |

The user's brief said "Thodare's 5-op set (`add` / `update` / `remove` / `connect` / `disconnect`)." That description is wrong on three counts:

1. The actual Thodare ops in `thodare/packages/engine/src/types.ts:211-241` are `'add' | 'edit' | 'delete' | 'connect' | 'disconnect'`. Not `update`/`remove`. (The doc-comment in `thodare/packages/SPEC.md:48-51` *also* uses the wrong words — "update / remove" — and should be fixed.)
2. Sim has `add` / `edit` / `delete` / `insert_into_subflow` / `extract_from_subflow`. **Sim does not have `connect`/`disconnect` at all.** Connections in Sim are embedded inside the block's `add`/`edit` `params.connections`, not separate edge ops.
3. Thodare did not inherit Sim's subflow ops at all. **There is no way in Thodare to express "move this block into the body of a loop block" or "extract this block out of a loop body."**

So Thodare's lineage is more "inspired by the *idea* of skip-don't-reject patches" than "ported from Sim's op set." The actual op set diverged by 4 of 5 ops (only `add` matches in name, and even there the param shape differs).

### §1.7 What Sim primitives Thodare hasn't adopted

In rough priority order:

1. **Container / nesting primitive.** Sim's `nestedNodes: Record<string, CopilotBlockState>` and the `loop` / `parallel` block types. Thodare has no notion of a block containing other blocks. This blocks expressing for-each, while-loops, parallel branches.
2. **Output `hiddenFromDisplay` flag.** Per §1.4 above. Thodare has the input-side `hidden()` brand but no output-side equivalent.
3. **`paramVisibility: 'llm-only'`.** A param the LLM must fill but the user can't see in the form. Thodare omits this.
4. **`canonicalParamId`.** Multiple subBlocks → one logical param.
5. **`subBlock.condition` as a function** (vs. static object). Real Sim integrations use closures because conditions get complex (`condition.field` itself depends on form state).
6. **`fetchOptions` / `fetchOptionById`** — dynamic dropdowns (channel pickers, table pickers).
7. **`reactiveCondition`** — credential-type gates.
8. **`mode: 'basic'|'advanced'`** progressive disclosure on subBlocks.
9. **`triggerMode` on a block** — a single block (e.g., Slack) flipping between trigger-mode and compute-mode at workflow-build time. Thodare's `kind` is fixed at definition.
10. **`singleInstance: boolean`** on a block — "you can only put one Response block in a workflow." Thodare has no equivalent (skip-reason `duplicate_single_instance_block` doesn't exist).
11. **`triggerAllowed: boolean`** per-block opt-in to trigger conversion.
12. **`authMode: AuthMode`** declared on the block (not just the tool).
13. **Reserved block names** — `RESERVED_BLOCK_NAMES` enforced via skip reason `reserved_block_name` (`sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/operations.ts:700-708`).
14. **`tags` / `integrationType` / `bgColor` / `icon` / `docsLink` / `longDescription` / `bestPractices`** — discovery + UI metadata.
15. **`block.locked: boolean`** — Sim refuses edits/deletes on locked blocks (skip reason `block_locked`, `sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/operations.ts:349-358`). Thodare has no concept of immutable blocks.
16. **`compute-edit-sequence.ts` — the diff-to-ops algorithm.** Sim has a documented module that takes "before workflow JSON" and "after workflow JSON" and produces a minimal `EditOp[]` to express the difference (`sim/apps/sim/lib/workflows/training/compute-edit-sequence.ts:1-32`). Thodare has no inverse direction; you can apply ops, but you can't synthesize the ops from a desired end-state. This is the missing half of the loop for "user dragged a block on the canvas → emit ops → server replays them."

---

## §2 n8n — the typed-properties flagship

n8n's Sustainable Use License (`n8n/LICENSE.md:1-16`) forbids running it as a hosted service for third parties, but reading its TypeScript interfaces and reimplementing them is fine. This section measures impedance mismatch on the schema level only.

### §2.1 Connector primitive — `INodeType` and `INodeTypeDescription`

`n8n/packages/workflow/src/interfaces.ts:1973-1990` is the runtime contract:

```ts
export interface INodeType {
  description: INodeTypeDescription;
  supplyData?(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData>;
  execute?(this: IExecuteFunctions, response?: EngineResponse): Promise<NodeOutput>;
  // ...
}
```

`n8n/packages/workflow/src/interfaces.ts:2492-2538` is the description (the schema part):

```ts
export interface INodeTypeDescription extends INodeTypeBaseDescription {
  version: number | number[];
  defaults: NodeDefaults;
  eventTriggerDescription?: string;
  activationMessage?: string;
  inputs: Array<NodeConnectionType | INodeInputConfiguration> | ExpressionString;
  requiredInputs?: string | number[] | number;
  inputNames?: string[];
  outputs: Array<NodeConnectionType | INodeOutputConfiguration> | ExpressionString;
  outputNames?: string[];
  properties: INodeProperties[];
  credentials?: INodeCredentialDescription[];
  maxNodes?: number;
  polling?: true | undefined;
  supportsCORS?: true | undefined;
  requestDefaults?: DeclarativeRestApiSettings.HttpRequestOptions;
  requestOperations?: IN8nRequestOperations;
  hooks?: { [key: string]: INodeHookDescription[] | undefined; activate?: ...; deactivate?: ... };
  webhooks?: IWebhookDescription[];
  triggerPanel?: TriggerPanelDefinition | boolean;
  hints?: NodeHint[];
  features?: NodeFeaturesDefinition;
  builderHint?: IBuilderHint;
  sensitiveOutputFields?: string[];     // dot-notation paths to redact from outputs
}
```

n8n's connector is more declarative than Thodare's: `inputs` and `outputs` are **arrays of typed connection ports** (not just a flat outputs schema), `webhooks: IWebhookDescription[]` lives on the node itself, `polling: true` flags it as a polling trigger, `hooks` declares `activate`/`deactivate` lifecycle methods, `sensitiveOutputFields: string[]` is the n8n equivalent of Sim's `hiddenFromDisplay` (and also missing in Thodare).

### §2.2 UI rendering schema — `INodeProperties`

`n8n/packages/workflow/src/interfaces.ts:1761-1795`:

```ts
export interface INodeProperties {
  displayName: string;
  name: string;
  type: NodePropertyTypes;          // 'string' | 'number' | 'boolean' | 'options' | 'multiOptions'
                                    // | 'collection' | 'fixedCollection' | 'json' | 'dateTime'
                                    // | 'color' | 'hidden' | 'notice' | 'credentialsSelect'
                                    // | 'resourceLocator' | 'resourceMapper' | 'filter' | 'assignmentCollection'
  typeOptions?: INodePropertyTypeOptions;
  default: NodeParameterValueType;
  description?: string;
  hint?: string;
  builderHint?: IParameterBuilderHint;
  disabledOptions?: IDisplayOptions;
  displayOptions?: IDisplayOptions;
  options?: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection>;
  placeholder?: string;
  isNodeSetting?: boolean;
  noDataExpression?: boolean;
  required?: boolean;
  routing?: INodePropertyRouting;
  credentialTypes?: Array<'extends:oAuth2Api' | 'extends:oAuth1Api' | 'has:authenticate' | 'has:genericAuth'>;
  extractValue?: INodePropertyValueExtractor;
  modes?: INodePropertyMode[];      // for resourceLocator: 'list' | 'url' | 'id'
  requiresDataPath?: 'single' | 'multiple';
  validateType?: FieldType;
  ignoreValidationDuringExecution?: boolean;
  allowArbitraryValues?: boolean;
  resolvableField?: boolean;
}
```

`INodeProperties` is *recursive* via `options?: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection>`. A `fixedCollection` is a list-of-grouped-fields — this is how the HTTP Request node does pagination config, the IF node does conditions, etc. **Thodare's `SubBlock` is flat — you cannot nest a SubBlock inside a SubBlock.** That makes IF/Filter conditions non-portable without flattening into `type: 'json'`.

### §2.3 Conditional field display — `IDisplayOptions`

`n8n/packages/workflow/src/interfaces.ts:1718-1748`:

```ts
export type DisplayCondition =
  | { _cnd: { eq: NodeParameterValue } }
  | { _cnd: { not: NodeParameterValue } }
  | { _cnd: { gte: number | string } }
  | { _cnd: { lte: number | string } }
  | { _cnd: { gt: number | string } }
  | { _cnd: { lt: number | string } }
  | { _cnd: { between: { from: number | string; to: number | string } } }
  | { _cnd: { startsWith: string } }
  | { _cnd: { endsWith: string } }
  | { _cnd: { includes: string } }
  | { _cnd: { regex: string } }
  | { _cnd: { exists: true } };

export interface IDisplayOptions {
  hide?: { [key: string]: Array<NodeParameterValue | DisplayCondition> | undefined; };
  show?: {
    '@version'?: Array<number | DisplayCondition>;
    '@feature'?: Array<string | DisplayCondition>;
    '@tool'?: boolean[];
    [key: string]: Array<NodeParameterValue | DisplayCondition> | undefined;
  };
  hideOnCloud?: boolean;
}
```

n8n's conditional system is **far richer than Thodare's `condition`**: regex, `gte`/`lte`/`between`, exists, plus version- and feature-flag conditions. Plus separate `show` and `hide` clauses. Thodare's `SubBlock.condition` (`thodare/packages/engine/src/types.ts:67`) supports only `{ field, value | value[], not? }` — i.e. equality check + negation. Porting an n8n IF node's display rules into Thodare is **lossy**.

### §2.4 Credentials

`n8n/packages/nodes-base/credentials/SlackApi.credentials.ts` shows the model (verbatim):

```ts
export class SlackApi implements ICredentialType {
  name = 'slackApi';
  displayName = 'Slack API';
  documentationUrl = 'slack';
  properties: INodeProperties[] = [
    { displayName: 'Access Token', name: 'accessToken', type: 'string',
      typeOptions: { password: true }, default: '', required: true },
    { displayName: 'Signature Secret', name: 'signatureSecret', type: 'string',
      typeOptions: { password: true }, default: '', description: '...' },
    { displayName: '...', name: 'notice', type: 'notice', default: '',
      displayOptions: { show: { signatureSecret: [''] } } },
  ];
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } },
  };
  test: ICredentialTestRequest = {
    request: { baseURL: 'https://slack.com', url: '/api/users.profile.get' },
    rules: [ { type: 'responseSuccessBody',
                 properties: { key: 'error', value: 'invalid_auth', message: 'Invalid access token' } } ],
  };
}
```

n8n's credential system is a separate first-class artifact:

- `ICredentialType` has its own `properties: INodeProperties[]` (UI schema for credential entry).
- `authenticate` is **declarative request signing** — `'=Bearer {{$credentials.accessToken}}'` is interpolated into headers at runtime by the engine, the node never sees the token.
- `test` is a declarative ping — n8n auto-validates credentials by issuing this request.
- A node references a credential type by name (`credentials: [{ name: 'slackApi', required: true }]` at `n8n/packages/nodes-base/nodes/Slack/SlackTrigger.node.ts:39-43`).

Thodare has **no** credential model. There's only:

- `ToolContext.env: Record<string, string>` (`thodare/packages/engine/src/types.ts:39-48`) — every tool sees the same env bag.
- The `hidden()` Zod brand on params, which the LLM can't fill but the system caller can.

For visual builders that have to surface "create a Slack connection" in their UI, Thodare's tools have to handle credential lookup themselves. There is no per-org credential store, no OAuth flow, no per-tool scope declaration. **This is a significant gap.**

### §2.5 Webhooks / triggers

n8n's `IWebhookDescription` (`n8n/packages/workflow/src/interfaces.ts:2576-2591`):

```ts
export interface IWebhookDescription {
  [key: string]: IHttpRequestMethods | WebhookResponseMode | boolean | string | undefined;
  httpMethod: IHttpRequestMethods | string;
  isFullPath?: boolean;
  name: WebhookType;                              // 'default' | 'setup'
  path: string;
  responseBinaryPropertyName?: string;
  responseContentType?: string;
  responsePropertyName?: string;
  responseMode?: WebhookResponseMode | string;    // 'onReceived' | 'lastNode' | 'responseNode'
  responseData?: WebhookResponseData | string;
  restartWebhook?: boolean;
  nodeType?: 'webhook' | 'form' | 'mcp';
  ndvHideUrl?: string | boolean;
  ndvHideMethod?: string | boolean;
}
```

Concrete usage in the Slack trigger (`n8n/packages/nodes-base/nodes/Slack/SlackTrigger.node.ts:33-39`):

```ts
webhooks: [
  { name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
],
```

n8n's trigger model is "the node declares a webhook + lifecycle hooks (`activate`/`deactivate`)" and the engine auto-registers webhook URLs against the workflow id. Cron triggers use `polling: true | undefined` plus `cronTrigger` machinery. Thodare's trigger model is "a block with `kind: 'trigger'` that the runtime walker treats as the entrypoint and pipes `triggerData` into" (`thodare/packages/engine/src/runner/walk.ts:75-78`); the actual webhook listener / cron registration happens externally via `packages/api/src/routes/webhooks.ts` and `packages/engine/src/runner/cron.ts`. **Thodare has cron and webhook plumbing**, but no in-block declarative `webhooks: [...]` schema; Block authors have to register externally.

### §2.6 Workflow JSON wire format

`n8n/packages/workflow/src/interfaces.ts:91-100` and `:417-430`:

```ts
export interface IConnection {
  node: string;                      // name of destination node
  type: NodeConnectionType;          // 'main' | 'ai_tool' | 'ai_languageModel' | ...
  index: number;
}

export type NodeInputConnections = Array<IConnection[] | null>;
export interface INodeConnections { [key: string]: NodeInputConnections; }
export interface IConnections { [key: string]: INodeConnections; }
```

n8n's connection map is keyed by **source node name → connection-type → source-output-index → IConnection[]**. Multiple typed output ports per node, multiple targets per port. Thodare's edge (`thodare/packages/engine/src/types.ts:111-116`):

```ts
export const SerializedConnectionSchema = z.object({
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  condition: z.string().optional(),
});
```

flat list of edges with optional `sourceHandle`. Mapping n8n's typed connections (multiple connection types like `main`, `ai_tool`) onto Thodare's `sourceHandle` is possible but loses the **input-side index** information (n8n's `index`, used for nodes with multiple inputs of the same type — IF node has 2 outputs but only 1 input; merge node has 2 inputs).

### §2.7 EditOp / patch primitive in n8n

**n8n has no LLM-shaped patch primitive in the source tree.** Workflow editing in the UI is full-document PUT (`PUT /workflows/:id` takes the whole `IWorkflow`). The AI-builder feature uses a different route. There is no `skipped_items` concept and no fine-grained op set. From a Thodare-substrate standpoint, this means: **n8n nodes are valuable as connectors, but n8n's wire format and patch model don't constrain Thodare's design** — Thodare's EditOp is well ahead.

### §2.8 Three-node walk-through

- **HttpRequestV3** (`n8n/packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts:62-90`): `version: [3, 4, 4.1, 4.2, 4.3, 4.4]` (multi-versioned), declarative `credentials: [{ name: 'httpSslAuth', required: true, displayOptions: { show: { provideSslCertificates: [true] } } }]` — credential **conditionally required** based on form state. Thodare can't express that.
- **IfV2** (`n8n/packages/nodes-base/nodes/If/V2/IfV2.node.ts:17-89`): two outputs `outputNames: ['true', 'false']`, properties dominated by a single `type: 'filter'` field that's a recursive condition tree. Porting requires Thodare to add a `filter` SubBlock type or fall back to a JSON blob.
- **SlackTrigger** (`n8n/packages/nodes-base/nodes/Slack/SlackTrigger.node.ts`): `group: ['trigger']`, `webhooks: [...]`, **no `execute` method** — instead `webhook(this: IWebhookFunctions): Promise<IWebhookResponseData>`.

---

## §3 ActivePieces — MIT, the cleanest port target

ActivePieces is closest to "Thodare can probably eat this directly," because it's MIT-licensed, the framework is small, and the connector primitive is closer to Thodare's collapsed Tool+Block shape than n8n's split.

### §3.1 Connector primitive — `Piece` (with `actions` and `triggers`)

`activepieces/packages/pieces/framework/src/lib/piece.ts:16-75`:

```ts
export class Piece<PieceAuth extends PieceAuthProperty | PieceAuthProperty[] | undefined = PieceAuthProperty>
  implements Omit<PieceBase, 'version' | 'name'>
{
  private readonly _actions: Record<string, Action> = {};
  private readonly _triggers: Record<string, Trigger> = {};
  constructor(
    public readonly displayName: string,
    public readonly logoUrl: string,
    public readonly authors: string[],
    public readonly events: PieceEventProcessors | undefined,
    actions: Action[],
    triggers: Trigger[],
    public readonly categories: PieceCategory[],
    public readonly auth?: PieceAuth,
    public readonly minimumSupportedRelease: string = MINIMUM_SUPPORTED_RELEASE_AFTER_LATEST_CONTEXT_VERSION,
    public readonly maximumSupportedRelease?: string,
    public readonly description = '',
  ) { ... }
  // ...
}
```

A Piece has many actions and many triggers. An action (`activepieces/packages/pieces/framework/src/lib/action/action.ts:41-52`):

```ts
export class IAction<PieceAuth extends PieceAuthProperty | PieceAuthProperty[] | undefined = any,
                     ActionProps extends InputPropertyMap = InputPropertyMap>
  implements ActionBase {
  constructor(
    public readonly name: string,
    public readonly displayName: string,
    public readonly description: string,
    public readonly props: ActionProps,
    public readonly run: ActionRunner<...>,
    public readonly test: ActionRunner<...>,
    public readonly requireAuth: boolean,
    public readonly errorHandlingOptions: ErrorHandlingOptionsParam,  // { retryOnFailure, continueOnFailure }
  ) { }
}
```

`ActionRunner` (line 7-8): `(ctx: ActionContext<PieceAuth, ActionProps>) => Promise<unknown | void>`.

This maps almost 1:1 onto Thodare's `defineConnector`: `props` is Thodare's params, `run` is Thodare's `execute`, `auth` is the missing first-class concept that Thodare fakes with `hidden()`+`ctx.env`.

### §3.2 UI rendering schema — `Property` types

`activepieces/packages/pieces/framework/src/lib/property/input/index.ts:25-43` is the union:

```ts
export const InputProperty = z.union([
  ShortTextProperty, LongTextProperty, MarkDownProperty,
  CheckboxProperty,
  StaticDropdownProperty, StaticMultiSelectDropdownProperty,
  DropdownProperty, MultiSelectDropdownProperty,    // dynamic — fetched at runtime
  DynamicProperties,                                  // schema-changes-at-runtime
  NumberProperty, ArrayProperty, ObjectProperty, JsonProperty,
  DateTimeProperty, FileProperty, ColorProperty,
]);
```

15 property types vs. Thodare's 5. Each has a **`required`** flag and a **`defaultValue`**. `Property.ShortText` etc. are factory functions (line ~70+ of the same file).

### §3.3 Conditional field display — **`DynamicProperties`**

`activepieces/packages/pieces/framework/src/lib/property/input/dynamic-prop.ts:31-56`:

```ts
export const DynamicProperties = z.object({
  refreshers: z.array(z.string()),
  ...BasePropertySchema.shape,
  ...TPropertyValue(z.unknown(), PropertyType.DYNAMIC).shape,
})

export type DynamicProperties<R extends boolean,
                              PieceAuth extends PieceAuthProperty | PieceAuthProperty[] | undefined = undefined>
  = BasePropertySchema & {
    auth: PieceAuth
    props: DynamicPropertiesOptions<PieceAuth>
    refreshers: string[];
  } & TPropertyValue<DynamicPropsValue, PropertyType.DYNAMIC, R>;

type DynamicPropertiesOptions<PieceAuth extends ... = undefined> = (
  propsValue: Record<string, unknown> & { auth?: ... },
  ctx: PropertyContext,
) => Promise<InputPropertyMap>;
```

Concrete usage in the HTTP send-request piece (`activepieces/packages/pieces/core/http/src/lib/actions/send-http-request-action.ts:59-96`):

```ts
authFields: Property.DynamicProperties({
  displayName: 'Authentication Fields',
  required: false,
  auth: PieceAuth.None(),
  refreshers: ['authType'],
  props: async ({ authType }) => {
    const authTypeEnum = authType.toString() as AuthType;
    let fields: DynamicPropsValue = {};
    switch (authTypeEnum) {
      case AuthType.NONE: fields = {}; break;
      case AuthType.BASIC:
        fields = {
          username: Property.ShortText({ displayName: 'Username', required: true }),
          password: Property.ShortText({ displayName: 'Password', required: true }),
        }; break;
      case AuthType.BEARER_TOKEN:
        fields = { token: Property.ShortText({ displayName: 'Token', required: true }) };
        break;
    }
    return fields;
  },
}),
```

ActivePieces's conditional-field model is **inversion of n8n's**: instead of the property declaring "show me when X has value Y," the property is a **function from form state → schema**. The UI fires `props()` whenever any field in `refreshers` changes. Thodare cannot express this — `SubBlock.condition` is static at definition time.

### §3.4 Credentials — `PieceAuth`

`activepieces/packages/pieces/framework/src/lib/property/authentication/index.ts:10-74`:

```ts
export type PieceAuthProperty =
  | BasicAuthProperty
  | CustomAuthProperty<any>
  | OAuth2Property<any>
  | SecretTextProperty<boolean>;

export const PieceAuth = {
  SecretText<R>(request: ...): SecretTextProperty<...> { ... },
  OAuth2<T>(request: ...): OAuth2Property<T> { ... },
  BasicAuth(request: ...): BasicAuthProperty { ... },
  CustomAuth<T>(request: ...): CustomAuthProperty<T> { ... },
  None() { return undefined; },
};
```

Auth is declared **on the Piece**, not on each action. Action `run(ctx)` receives `ctx.auth` typed against the piece's auth shape. Thodare's `defineConnector` has no `auth` field — auth is each connector's problem to figure out.

### §3.5 Trigger model — `TriggerStrategy`

`activepieces/packages/pieces/framework/src/lib/trigger/trigger.ts:13-57`:

```ts
export enum WebhookRenewStrategy { CRON = 'CRON', NONE = 'NONE' }

type BaseTriggerParams<...> = {
  name: string; displayName: string; description: string;
  requireAuth?: boolean; auth?: PieceAuth;
  props: TriggerProps;
  type: TS;                                   // TriggerStrategy.WEBHOOK | POLLING | MANUAL | APP_WEBHOOK
  onEnable: (context: TriggerHookContext<...>) => Promise<void>;
  onDisable: (context: TriggerHookContext<...>) => Promise<void>;
  run: (context: TestOrRunHookContext<...>) => Promise<unknown[]>;
  test?: (context: TestOrRunHookContext<...>) => Promise<unknown[]>;
  onStart?: OnStartRunner<...>;
  sampleData: unknown;
}

type WebhookTriggerParams<...> = BaseTriggerParams<...> & {
  handshakeConfiguration?: WebhookHandshakeConfiguration;
  onHandshake?: (...) => Promise<WebhookResponse>;
  renewConfiguration?: WebhookRenewConfiguration;
  onRenew?(context: ...): Promise<void>;
}
```

A trigger has lifecycle hooks (`onEnable`, `onDisable`), a `run` for receiving polling/webhook events, optional `onHandshake` for webhook setup, and `sampleData` for test-fire UI. Thodare's trigger blocks have none of this; a `kind: 'trigger'` block is just an entrypoint marker (`thodare/packages/engine/src/runner/walk.ts:75-78`) and webhook URL routing is handled outside the block at `packages/api/src/routes/webhooks.ts`.

### §3.6 Execution model + waitpoints

`activepieces/packages/pieces/core/approval/src/lib/actions/wait-for-approval.ts:23-38`:

```ts
async run(ctx) {
  if (ctx.executionType === ExecutionType.BEGIN) {
    const waitpoint = await ctx.run.createWaitpoint({ type: 'WEBHOOK' });
    ctx.run.waitForWaitpoint(waitpoint.id);
    return { approved: true };
  } else {
    return { approved: ctx.resumePayload.queryParams['action'] === 'approve' };
  }
}
```

ActivePieces's pause primitive is `ctx.run.createWaitpoint({ type: 'WEBHOOK' })` + `ctx.run.waitForWaitpoint(id)`, with a re-entrant `executionType: BEGIN | RESUME` and `ctx.resumePayload`. Thodare's wait blocks return a `PauseInfo` sentinel (`thodare/packages/engine/src/types.ts:135-170`):

```ts
export interface PauseInfo {
  __paused: true;
  reason: 'wait_duration' | 'wait_until' | 'wait_for_event' | 'human_approval';
  resumeAt?: string;
  resumeOnEvent?: string;
  correlationKey?: string;
  resumeToken: string;
  metadata?: Record<string, unknown>;
}
```

These are equivalent in expressive power — a Thodare adapter for AP's `createWaitpoint` would translate to a `wait_for_event` PauseInfo and back. Good news.

### §3.7 Workflow JSON wire format — linked-list

`activepieces/packages/shared/src/lib/automation/flows/actions/action.ts:285-343`:

```ts
| (BaseActionProps & { type: FlowActionType.CODE,         settings: ..., nextAction?: FlowAction })
| (BaseActionProps & { type: FlowActionType.PIECE,        settings: ..., nextAction?: FlowAction })
| (BaseActionProps & { type: FlowActionType.LOOP_ON_ITEMS,settings: ..., nextAction?: FlowAction, firstLoopAction?: FlowAction })
| (BaseActionProps & { type: FlowActionType.ROUTER,       settings: ..., nextAction?: FlowAction, children: (FlowAction | null)[] })
```

ActivePieces's workflow is a **linked list** (every action has `nextAction?: FlowAction`), with `LOOP_ON_ITEMS.firstLoopAction` and `ROUTER.children` for branching. The executor (`activepieces/packages/server/engine/src/lib/handler/flow-executor.ts:77-110`) walks this linked list:

```ts
while (!isNil(currentAction)) {
  if (currentAction.skip && !testSingleStepMode) {
    previousAction = currentAction
    currentAction = currentAction.nextAction
    ...
```

Thodare's wire format is a flat blocks+connections graph (DAG), not a linked list. **This is a real impedance mismatch:** an AP flow imported into Thodare needs to be flattened to a DAG, and an arbitrary Thodare DAG (with multiple outputs converging or fanning out) cannot always be expressed as an AP linked list. AP's `ROUTER` with N children maps to N `sourceHandle` values on Thodare; AP's `LOOP_ON_ITEMS` has no Thodare equivalent (Thodare lacks loops).

### §3.8 EditOp / patch primitive in AP — 26-op enum

`activepieces/packages/shared/src/lib/automation/flows/operations/index.ts:28-55`:

```ts
export enum FlowOperationType {
  LOCK_AND_PUBLISH = 'LOCK_AND_PUBLISH', CHANGE_STATUS = 'CHANGE_STATUS',
  LOCK_FLOW = 'LOCK_FLOW', CHANGE_FOLDER = 'CHANGE_FOLDER', CHANGE_NAME = 'CHANGE_NAME',
  MOVE_ACTION = 'MOVE_ACTION', IMPORT_FLOW = 'IMPORT_FLOW',
  UPDATE_TRIGGER = 'UPDATE_TRIGGER',
  ADD_ACTION = 'ADD_ACTION', UPDATE_ACTION = 'UPDATE_ACTION', DELETE_ACTION = 'DELETE_ACTION',
  DUPLICATE_ACTION = 'DUPLICATE_ACTION', USE_AS_DRAFT = 'USE_AS_DRAFT',
  DELETE_BRANCH = 'DELETE_BRANCH', ADD_BRANCH = 'ADD_BRANCH', DUPLICATE_BRANCH = 'DUPLICATE_BRANCH',
  SET_SKIP_ACTION = 'SET_SKIP_ACTION', UPDATE_METADATA = 'UPDATE_METADATA',
  MOVE_BRANCH = 'MOVE_BRANCH', SAVE_SAMPLE_DATA = 'SAVE_SAMPLE_DATA',
  UPDATE_MINUTES_SAVED = 'UPDATE_MINUTES_SAVED', UPDATE_OWNER = 'UPDATE_OWNER',
  UPDATE_NOTE = 'UPDATE_NOTE', DELETE_NOTE = 'DELETE_NOTE', ADD_NOTE = 'ADD_NOTE',
  UPDATE_SAMPLE_DATA_INFO = 'UPDATE_SAMPLE_DATA_INFO',
}
```

26 ops, but **no skip-don't-reject semantics** — each op is a transactional update that throws on failure. AP's op set is broader (file/note/owner ops, draft/publish, sample data) but lacks Thodare's structured `skipped_items[]`. This is the area where Thodare is *ahead* of AP.

---

## §4 Synthesis — can Thodare host these UIs?

### §4.1 Can a developer port n8n nodes into Thodare connectors?

**Partly.** A loader that takes an `INodeType` and produces a Thodare `Block`+`Tool` would have to:

- Map `INodeProperties[]` → `SubBlock[]`. **Lossy:** nested `fixedCollection` properties have no Thodare equivalent (need flattening to `type: 'json'`); rich `displayOptions` (regex, gte, between, exists) collapse to Thodare's equality-only `condition`.
- Map `INodeTypeDescription.credentials` to… nothing. Thodare has no credential model. The loader would have to either (a) inline credentials as `hidden()` params and rely on the runtime to inject them, or (b) refuse to import nodes that need credentials.
- Map `IWebhookDescription` → a Thodare `kind: 'trigger'` block + side-channel registration in `packages/api/src/routes/webhooks.ts`.
- Map `polling: true` → a cron registration in `packages/engine/src/runner/cron.ts`. Thodare has the plumbing but no declarative tie from block to cron.
- Map `INodeType.execute` → Thodare's `execute(params, ctx)`. Compatible in shape but n8n's `IExecuteFunctions` ctx is huge (`getInputData`, `getNodeParameter`, `getCredentials`, `helpers.*`, expression evaluation) — a real adapter is a 1000-line shim.

**Verdict: feasible for ~30% of n8n nodes (simple HTTP-shaped ones), heavy lossy-translation for triggers and credential-heavy nodes.**

### §4.2 Can a developer port ActivePieces pieces into Thodare?

**Mostly yes**, with the same caveats. AP's `Action.props` map cleanly onto Thodare's params (more types than Thodare supports, but mappable), and AP's `run(ctx)` signature is shape-compatible with Thodare's `execute(params, ctx)`. The hard parts:

- **`PieceAuth`** has no Thodare home. Either inline as `hidden()` params or build a credentials package.
- **`Property.DynamicProperties`** — Thodare cannot express this. A piece using `DynamicProperties` would degrade to a single `type: 'json'` SubBlock.
- **AP triggers' lifecycle** (`onEnable`/`onDisable`/`onHandshake`/`onRenew`) has no Thodare lifecycle. Thodare assumes triggers are stateless webhook listeners.
- **`LOOP_ON_ITEMS`** and **`ROUTER`** have no Thodare equivalent.
- **Linked-list wire format** must be flattened to DAG.

**Verdict: feasible for action-heavy pieces without dynamic props or complex triggers.**

### §4.3 Can a developer port Sim blocks into Thodare?

**Partly — with significant fidelity loss on the modern Sim blocks.** Sim's `BlockConfig` is the closest cousin to Thodare's `Block`, but Thodare omits:

- `inputs: Record<string, ParamConfig>` (typed param schema separate from subBlocks).
- `triggers: { enabled, available[] }` — a block being morph-able into multiple trigger types.
- `singleInstance` enforcement.
- `authMode` declaration.
- The 28+ `SubBlockType` variants — channel-selectors, mcp-tool-selectors, etc.
- `condition` as a function, `paramVisibility: 'llm-only'`, `canonicalParamId`, `mode`, `reactiveCondition`, `fetchOptions`/`fetchOptionById`, `wandConfig`, `dependsOn`, `hideFromPreview`/`hideWhenHosted`/`hideWhenEnvSet`.
- Nesting via `nestedNodes` (loop / parallel containers).
- `block.locked` immutability.

Of all three projects, Sim is the one Thodare claims direct lineage with — and the **Sim blocks shipped in the current source tree depend on at least 8 of these missing primitives**, so even Sim's own block files cannot be loaded into Thodare verbatim today.

**Verdict: ~50% of Sim blocks port without loss; the more sophisticated ones (Slack, Google Sheets, dynamic forms) need Thodare to grow.**

### §4.4 Can a developer build a visual UI on top of `@thodare/api`?

The current API surface is `GET /api/connectors`, `GET /api/connectors/:type`, `POST /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows/:id/operations`, plus runs/schedules/webhooks routes.

`GET /api/connectors/:type` (`thodare/packages/api/src/routes/connectors.ts:26-33`) returns `{ type, name, description, category, kind, subBlocks, outputs }`. **What's missing for a credible UI to render against**:

- **No credentials catalog endpoint.** The UI can't show "you need to connect Slack first."
- **No tool catalog endpoint.** The UI can't tell the user which tools a block delegates to.
- **No icon / category / tag / authMode metadata** on connectors. The toolbar/sidebar that visual builders show ("Communication", "AI", "Databases") can't be built.
- **No schema-enrichment endpoint.** AP's `DynamicProperties.props()` callback or Sim's `fetchOptions` need a server endpoint that takes current form state + auth and returns sub-schema. None exists.
- **No webhook URL endpoint per workflow.** A trigger block's "URL to call" is computed at workflow-publish time; the UI needs a way to ask the server.
- **No reverse direction on operations** — given two `SerializedWorkflow`s, no `compute-edit-sequence` endpoint.

`POST /api/workflows/:id/operations` is well-shaped — it returns `ApplyOpsResult` with `validation_errors[]` and `skipped_items[]` (`thodare/packages/engine/src/types.ts:272-278`). This is the **best-shaped surface in the codebase** for a UI to consume; it's what gives the user immediate visual feedback when they drop an invalid block.

### §4.5 Concrete gap list, prioritized

1. **(P0) Credential / Connection model.** Add a `Credential` first-class artifact: `id`, `type` (oauth2/api-key/basic/custom), `properties: SubBlock[]` for entry, optional `authenticate: { type, properties }` declarative request signing, optional `test` ping, scopes. Tools opt in via `auth: { type: 'slack', requiredScopes: [...] }`. Lives in `thodare/packages/engine/src/credentials/`. Without this, none of the three projects' connectors port without inlining credentials as `hidden()` params and shoving them through `ctx.env`.
2. **(P0) Output `hiddenFromDisplay` flag.** Add `outputs: Record<string, ToolOutputDef & { hiddenFromDisplay?: boolean }>` so block outputs can be plumbed forward without being reasoned about by the LLM. Sim has it (`sim/packages/workflow-types/src/blocks.ts:81`); Thodare does not.
3. **(P0) `paramVisibility: 'llm-only'`.** Three-value visibility is incomplete. Add the fourth: a param the user form must hide but the LLM must fill.
4. **(P1) Container blocks / nesting.** Loop, parallel, branch. This means: `Block.kind: 'container'`, `SerializedBlock.parentId?: string`, `EditOp.operation_type: 'insert_into_subflow' | 'extract_from_subflow'`. Without this, no for-each, no while, no parallel — and no AP `LOOP_ON_ITEMS` import.
5. **(P1) Richer `SubBlock.condition`.** At minimum: `gte`/`lte`/`exists`/`includes`/`regex` operators. Ideally: `condition` as a function (Sim/AP-style closure). Without this, IF-node-style filters and dynamic credential gates don't port.
6. **(P1) Dynamic property schema (`DynamicProperties` / `fetchOptions`).** Need an HTTP endpoint `POST /api/connectors/:type/refresh` that takes form state and returns a partial SubBlock list. Without this, Slack channel pickers, Sheets sheet pickers, Airtable table pickers — i.e. the bread-and-butter of every visual builder — don't work.
7. **(P1) `compute-edit-sequence` (diff → ops) module.** When a user drags a block on the canvas, the UI needs to emit a minimal `EditOp[]`, not re-PUT the whole document. Sim has this; Thodare doesn't (`sim/apps/sim/lib/workflows/training/compute-edit-sequence.ts`).
8. **(P2) `SubBlock` types: at least add `code` (with `language`), `slider`, `combobox` (searchable + dynamic), `multi-select`, `file-upload`, `oauth-connection-selector`, `mcp-tool-selector`.** The current 5 are inadequate.
9. **(P2) Single-instance / locked / reserved-name enforcement.** New skip reasons: `duplicate_single_instance_block`, `block_locked`, `reserved_block_name`, `duplicate_block_name`, `duplicate_trigger`. Sim has them all (`sim/apps/sim/lib/copilot/tools/server/workflow/edit-workflow/types.ts:34-53`); Thodare's `SkipReason` union (`thodare/packages/engine/src/types.ts:245-254`) has 9 values where Sim has 21.
10. **(P2) Connection embedding inside `add` op.** Currently Thodare requires separate `connect`/`disconnect` ops. Sim attaches `params.connections` directly to the `add` op so creating-and-wiring is one transaction. Either accept this as input or add an alternate op shape.
11. **(P2) Trigger lifecycle hooks.** `onEnable` / `onDisable` declared on trigger blocks; engine calls them at publish/unpublish. Plus `onHandshake` for webhook providers that require challenge-response.
12. **(P2) Tool-level declarative request builder.** Ports AP's `request: (params) => HttpRequest` and n8n's `requestDefaults`. Makes connectors serializable / portable / inspectable.
13. **(P3) Connector metadata: `tags`, `category` taxonomy, `authMode`, `bgColor`, `icon`, `docsLink`, `longDescription`, `bestPractices`.** The toolbar UI needs these. Currently you can shoehorn them into `description` but a visual builder wants them typed.
14. **(P3) Multi-versioning on a connector.** n8n's `version: number | number[]` lets one node have multiple parallel versions; Sim has `pieceVersion` on the action settings. Thodare has no version on `Block`.
15. **(P3) Workflow-id-scoped webhook URLs / per-block runtime URLs.** The UI needs `GET /api/workflows/:id/blocks/:blockId/webhook-url`. Currently not exposed.

### §4.6 Runtime gaps (vs. block-design gaps)

The block-design gaps above are the bulk of the work. Runtime gaps are smaller:

- **Loops / branches.** Thodare's walker (`thodare/packages/engine/src/runner/walk.ts:43-48`) does a single topo-sort of the DAG. Loop and parallel container blocks would need re-entrant evaluation — feasible because openworkflow supports it, but the walker has to grow.
- **Per-step retry semantics.** AP's `errorHandlingOptions: { retryOnFailure, continueOnFailure }` and n8n's `retryOnFail` / `maxTries` / `waitBetweenTries` (`n8n/packages/workflow/src/interfaces.ts:1365-1367`) — Thodare delegates retry to openworkflow's `step.run` which handles this transparently, but there's no per-block declarative way to say "retry 3 times with exponential backoff." Block authors have to call `ctx.log` and throw; the engine retries by default.
- **Item-level fan-out.** n8n's `INodeExecutionData[]` model (one node operates on N items, returning N items per output port) is the entire reason n8n's expression syntax exists. Thodare's `walk.ts` operates on **whole-block outputs**, not per-item arrays. Porting an n8n node that loops over items requires emulating n8n's item model inside `execute()`.
- **Multiple typed input/output ports.** n8n nodes can have ports of types `main`, `ai_tool`, `ai_languageModel`, etc. (`NodeConnectionType` enum). Thodare has only one connection type; multiple output ports are encoded via `sourceHandle: string`. For most visual-builder use cases, single-typed ports + `sourceHandle` is fine.

---

## Executive summary

I read the canonical primitive files of **n8n** (Sustainable Use License — readable, hosting-restricted), **ActivePieces** (MIT/Apache-2.0 — fully usable), and **Sim Studio** (Apache-2.0 — Thodare's direct ancestor). I compared each against Thodare's `Block` / `Tool` / `SubBlock` / `EditOp` / `hidden()` primitives in `thodare/packages/engine/src/types.ts`, `define/visibility.ts`, and `operations/apply.ts`.

**Three findings dominate.** First, Thodare's "5-op set" does not match Sim's. Sim's ops are `add` / `edit` / `delete` / `insert_into_subflow` / `extract_from_subflow` — connections are embedded in the `add` op's `params.connections`, not separate edge ops. Thodare's ops are `add` / `edit` / `delete` / `connect` / `disconnect`. Both the user's brief and Thodare's own SPEC.md/types.ts doc-comments incorrectly claim parity. Three of five ops diverged. (Thodare's `connect`/`disconnect` are arguably better for a flat-graph wire format; Sim's subflow ops are required for nesting.)

**Second, the largest substrate gap is credentials.** None of the three projects can be ported without a Thodare credentials artifact. Currently Thodare hides credentials via `hidden()` Zod brand and assumes injection through `ToolContext.env`. n8n/AP/Sim all have first-class credential types with declarative auth, scope declarations, and a credentials store. Without this, only the simplest connectors port, and visual UIs cannot render "Connect Slack" flows against `@thodare/api`.

**Third, the `SubBlock` type set and conditional system are inadequate.** Thodare has 5 SubBlock types and equality-only conditions; Sim has 28+ types and function-typed conditions; AP has dynamic schema generation via `DynamicProperties`. Visual builders rely on dynamic dropdowns (`fetchOptions`), conditional reveal beyond equality, and progressive disclosure (`mode: basic|advanced`) — Thodare has none of these.

**Verdict:** Thodare's primitives are sufficient to host **simple action-node connectors** (HTTP, transform, internal blocks), and its `EditOp` skip-don't-reject loop is genuinely ahead of n8n (which has none) and AP (which throws-not-skips). It is **not yet** sufficient to be the headless backend for the connectors n8n / AP / Sim ship today: credentials, dynamic-schema endpoints, container blocks, output-hidden flags, and richer SubBlocks are all required first.

**File path:** `/Users/mithushancj/Documents/asyncdot/openscoped/agent-control-panel/thodare/research/code-reviews/visual-builder-substrates.md`

**One-line answer:** Thodare is ready to be a headless backend for *internal* visual builders against Thodare-native blocks today; to host UIs that import n8n / ActivePieces / Sim connectors, ship in this order — credentials artifact → output `hiddenFromDisplay` + `llm-only` visibility → container blocks + subflow ops → dynamic-schema endpoint → richer SubBlock types and conditional system.
