// Test worker entry point for the workerd pool. Re-exports
// DynamicWorkflowBinding so wrapWorkflowBinding can find it on
// `cloudflare:workers` exports during integration tests.
// Also re-exports LogSession so the DO is registered via migrations.
export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";
export { LogSession } from "../src/log-session.js";

export default {
  fetch: () => new Response("Test worker"),
};
