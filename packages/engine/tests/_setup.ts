/**
 * Shared registry setup for tests. Every test gets fresh registries so
 * registration tests are isolated.
 */
import {
  BlockRegistry,
  ToolRegistry,
  registerBuiltinBlocks,
  registerBuiltinTools,
  registerWaitTools,
} from "../src/index.js";

export function freshRegistries(): { tools: ToolRegistry; blocks: BlockRegistry } {
  const tools = new ToolRegistry();
  const blocks = new BlockRegistry();
  registerBuiltinTools(tools);
  registerWaitTools(tools);
  registerBuiltinBlocks(blocks);
  return { tools, blocks };
}
