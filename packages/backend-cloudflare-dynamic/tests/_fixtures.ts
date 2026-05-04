/**
 * Shared test fixtures: block/tool definitions used by both the walker-e2e
 * test and the _worker.ts (which exports ThodareWorkflow for real-engine
 * dispatch by the CF Workflows engine).
 */
import type { Tool, ToolContext } from "@thodare/engine";

export const ECHO_TOOL: Tool = {
  id: "test.echo",
  name: "Echo",
  description: "Returns input unchanged",
  params: { message: { type: "string", visibility: "user-or-llm" } },
  outputs: { result: { type: "string" } },
  execute: async (params: unknown, _ctx: ToolContext) => {
    const p = params as { message: string };
    return { result: p.message };
  },
};

export const ECHO_BLOCK = {
  type: "test_echo",
  name: "Echo",
  description: "Echoes a message",
  category: "action" as const,
  kind: "compute" as const,
  subBlocks: [],
  outputs: { result: { type: "string" as const } },
  tools: {
    access: ["test.echo"],
    config: {
      tool: () => "test.echo",
    },
  },
};

export function buildTestWorkflowJson(
  blockOverrides?: Partial<Record<number, Record<string, unknown>>>,
) {
  const blocks = [
    {
      id: "block-1",
      type: "test_echo",
      name: "First",
      enabled: true,
      params: { message: "hello" },
    },
    {
      id: "block-2",
      type: "test_echo",
      name: "Second",
      enabled: true,
      params: { message: "world" },
    },
    {
      id: "block-3",
      type: "test_echo",
      name: "Third",
      enabled: true,
      params: { message: "done" },
    },
  ];

  if (blockOverrides) {
    for (const [idx, overrides] of Object.entries(blockOverrides)) {
      const i = Number(idx);
      if (blocks[i]) {
        Object.assign(blocks[i]!, overrides);
      }
    }
  }

  return {
    version: "1.0.0",
    blocks,
    connections: [
      { source: "block-1", target: "block-2" },
      { source: "block-2", target: "block-3" },
    ],
    metadata: { name: "test-workflow" },
  };
}

export function buildSingleStepWorkflowJson() {
  return {
    version: "1.0.0",
    blocks: [
      {
        id: "b1",
        type: "test_echo",
        name: "SingleStep",
        enabled: true,
        params: { message: "real-engine-test" },
      },
    ],
    connections: [],
    metadata: { name: "real-engine-e2e" },
  };
}
