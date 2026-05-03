// Test worker entry point for the workerd pool. Re-exports
// DynamicWorkflowBinding so wrapWorkflowBinding can find it on
// `cloudflare:workers` exports during integration tests.
export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

export default {
  fetch: () => new Response("Test worker"),
};
