// Test worker entry point for the workerd pool. Re-exports
// DynamicWorkflowBinding so wrapWorkflowBinding can find it on
// `cloudflare:workers` exports during integration tests.
// Also re-exports LogSession (DO) and ThodareWorkflow (CF Workflows
// entrypoint) so the workerd pool can dispatch via the [[workflows]] block.
import { createCloudflareDispatcher } from "../src/dispatcher.js";
import { BlockRegistry, ToolRegistry } from "@thodare/engine/registry";
import { ECHO_BLOCK, ECHO_TOOL } from "./_fixtures.js";

const blockRegistry = new BlockRegistry();
blockRegistry.register(ECHO_BLOCK);
const toolRegistry = new ToolRegistry();
toolRegistry.register(ECHO_TOOL);

export const { DynamicWorkflowBinding, ThodareWorkflow } =
  createCloudflareDispatcher({ blockRegistry, toolRegistry });

export { LogSession } from "../src/log-session.js";

export default {
  fetch: () => new Response("Test worker"),
};
