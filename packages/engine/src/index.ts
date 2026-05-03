/**
 * Public API.
 *
 * Two layers:
 *
 *   ┌── HIGH-LEVEL (recommended) ───────────────────────────────────────┐
 *   │  createWfkit({ backend })                                          │
 *   │  defineConnector({ params: z.object(...), outputs: z.object(...), │
 *   │                    async run({...}, ctx) { ... } })                │
 *   │  defineWorkflow("name").input(zod).step(...).step(...).build()    │
 *   │  hidden(z.string()) / userOnly(...) — visibility brands            │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 *   ┌── LOW-LEVEL (still supported) ────────────────────────────────────┐
 *   │  new ToolRegistry / new BlockRegistry / registerBuiltinTools(...)  │
 *   │  buildDurableWorkflow({ ow, backend, ... })                        │
 *   │  applyOperations({ workflow, ops, ... })                           │
 *   │  execute() / resume() — in-memory executor for unit tests          │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * The high-level API delegates to the low-level API; both produce the same
 * `SerializedWorkflow` JSON wire format that LLMs emit and the runner consumes.
 */

// ── Recommended high-level API ──
export { walkWorkflow } from "./runner/walk.js";
export type { WalkOptions } from "./runner/walk.js";
export { createWfkit } from "./client.js";
export type { CreateWfkitOptions, Wfkit } from "./client.js";
export { defineConnector } from "./define/connector.js";
export type { ConnectorDef, DefineConnectorOptions } from "./define/connector.js";
export { defineWorkflow, WorkflowBuilder } from "./define/workflow.js";
export { defineWorkflowSpec, specRuntimeName } from "./define/spec.js";
export type { WorkflowSpec, DefineWorkflowSpecOptions } from "./define/spec.js";
export { withTracing } from "./runner/tracing.js";
export type { TracingHooks } from "./runner/tracing.js";
export { createWebhookRouter } from "./runner/webhooks.js";
export type {
  CreateWebhookRouterOptions,
  RegisterRouteOptions,
  WebhookRequest,
  WebhookResponse,
  WebhookRouter,
} from "./runner/webhooks.js";
export { buildRuntimeWorkflow } from "./runner/runtime-workflow.js";
export type { BuildRuntimeWorkflowOptions, RuntimeWorkflow } from "./runner/runtime-workflow.js";
export { hidden, userOnly, userOrLlm } from "./define/visibility.js";

// ── Credentials ──
export type { CredentialType, ToolCredentialBinding, ResolvedCredential } from "./credentials/index.js";
export { deriveOrgKey, encryptSecret, decryptSecret, packEncrypted, unpackEncrypted } from "./credentials/index.js";

// ── Types ──
export * from "./types.js";
export { ToolRegistry } from "./tools/registry.js";
export { BlockRegistry } from "./blocks/registry.js";
export { applyOperations } from "./operations/apply.js";
export type { ApplyOpsOptions } from "./operations/apply.js";
export { execute, resume } from "./executor/executor.memory.js";
export type { ExecuteOptions, ExecutionEvent } from "./executor/executor.memory.js";
export {
  registerBuiltinBlocks,
  triggerWebhookBlock,
  httpBlock,
  slackBlock,
  transformBlock,
  waitDurationBlock,
  waitForEventBlock,
  humanApprovalBlock,
} from "./blocks/builtin.js";
export {
  registerBuiltinTools,
  httpRequestTool,
  slackSendMessageTool,
  transformTool,
} from "./tools/builtin.js";
export {
  registerWaitTools,
  waitDurationTool,
  waitForEventTool,
  humanApprovalTool,
} from "./tools/waits.js";
export { buildDurableWorkflow } from "./runner/openworkflow.js";
export type { BuildDurableOptions, DurableWorkflow } from "./runner/openworkflow.js";
export { createDurableHandle } from "./runner/handle.js";
export type {
  DurableHandle,
  DurableHandleOptions,
  DurableRunDescription,
  DurableRunState,
} from "./runner/handle.js";
export {
  InMemoryScheduleStore,
  dispatchOnce,
  isCronMatch,
  newScheduleId,
  parseCron,
  startCronDispatcher,
} from "./runner/cron.js";
export type {
  CronDispatcherOptions,
  DispatchTickInput,
  DispatchTickOutput,
  ScheduleSpec,
  ScheduleStore,
} from "./runner/cron.js";
