/**
 * E2E test: walk a 3-block workflow through the dispatcher's loadRunner
 * using a mock CF step that captures do/sleep calls. Asserts step rows
 * and lifecycle events land in D1 scoped by organization_id.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { D1Storage } from "../src/d1-storage.js";
import { ddlStatements } from "./apply-migrations.js";
import type { CFEnv } from "../src/types.js";
import type { SerializedWorkflow } from "@thodare/engine/walk";
import { BlockRegistry } from "@thodare/engine/registry";
import { ToolRegistry } from "@thodare/engine/registry";
import type { Tool } from "@thodare/engine";
import {
  _buildLoadRunner,
  createCloudflareDispatcher,
  DynamicWorkflowBinding,
} from "../src/dispatcher.js";
import { BackendCloudflareDynamic } from "../src/adapter.js";
import {
  ECHO_TOOL,
  ECHO_BLOCK,
  buildTestWorkflowJson,
} from "./_fixtures.js";

const ORG_ID = "test-walker-org";

async function getEnv(): Promise<CFEnv> {
  const mod = await import("cloudflare:test");
  return (mod as unknown as { env: Record<string, unknown> }).env as unknown as CFEnv;
}

function buildWorkflowJson(
  blockOverrides?: Partial<Record<number, Record<string, unknown>>>,
): SerializedWorkflow {
  return buildTestWorkflowJson(blockOverrides) as SerializedWorkflow;
}

describe("walker E2E: 3-block workflow", () => {
  let env: CFEnv;
  let backend: BackendCloudflareDynamic;

  beforeAll(async () => {
    env = await getEnv();
    for (const stmt of ddlStatements()) {
      await env.THODARE_DB.prepare(stmt).run();
    }

    // Use production registration path: defineWorkflow + setWorkflowDefinition.
    backend = new BackendCloudflareDynamic({ env, organizationId: ORG_ID });
    await backend.defineWorkflow({ name: "e2e-wf" }, async () => {});
    await backend.setWorkflowDefinition("e2e-wf", 1, buildWorkflowJson());
  });

  it("loadRunner returns a runner with a run method", async () => {
    const blockRegistry = new BlockRegistry();
    blockRegistry.register(ECHO_BLOCK);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(ECHO_TOOL);

    const factory = createCloudflareDispatcher({
      blockRegistry,
      toolRegistry,
    });

    // The factory creates an entrypoint class whose loadRunner is the
    // callback we registered. We can't call it directly, but we can verify
    // the class shape — it extends WorkflowEntrypoint and has a run method.
    expect(typeof factory.ThodareWorkflow).toBe("function");
    expect(typeof factory.ThodareWorkflow.prototype.run).toBe("function");
  });

  it("walking the workflow via mocked step writes step rows + events to D1", async () => {
    const blockRegistry = new BlockRegistry();
    blockRegistry.register(ECHO_BLOCK);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(ECHO_TOOL);

    // Use production registration path: defineWorkflow + setWorkflowDefinition.
    const wf = buildWorkflowJson();
    const runId = "mock-run-" + crypto.randomUUID().slice(0, 8);
    const wfId = "wfx-" + crypto.randomUUID().slice(0, 8);

    await backend.defineWorkflow({ name: wfId }, async () => {});
    await backend.setWorkflowDefinition(wfId, 1, wf);

    // Insert a run row (simulating what adapter.runWorkflow does)
    await env.THODARE_DB
      .prepare(
        `INSERT INTO runs (id, workflow_name, organization_id, spec_version, input, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(runId, wfId, ORG_ID, 1, JSON.stringify({}), "running", new Date().toISOString())
      .run();

    // Create a mock CF step that tracks calls
    const stepCalls: Array<{ method: string; name: string }> = [];
    const mockStep = {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        stepCalls.push({ method: "do", name });
        return fn();
      },
      sleep: async (name: string, _duration: string): Promise<void> => {
        stepCalls.push({ method: "sleep", name });
      },
      waitForEvent: async (
        name: string,
        _eventType: string,
        _opts?: { timeout?: string },
      ): Promise<{ type: string; payload?: unknown } | undefined> => {
        stepCalls.push({ method: "waitForEvent", name });
        return { type: "test-event", payload: { arrived: true } };
      },
    };

    const factory = createCloudflareDispatcher({
      blockRegistry,
      toolRegistry,
    });

    // Access the loadRunner via the prototype constructor trick.
    // The ThodareWorkflow class was created with a loadRunner closure
    // that reads from D1. We can't easily invoke it in isolation —
    // but we can verify the structural invariants:
    // 1. The loader reaches D1 (it would throw if D1 binding missing)
    // 2. The runner shape has a `run` method

    // For full E2E: we use the internal dispatchWorkflow primitive
    // directly, bypassing the WorkflowEntrypoint wrapping.
    const { dispatchWorkflow } = await import("@cloudflare/dynamic-workflows");

    // We don't need the ThodareWorkflow class — we invoke dispatchWorkflow
    // directly with our metadata, which will exercise the loadRunner.
    // But we need a real env context for the loader.
    // Instead, let's test a simpler path: assert that the loader closure
    // can be verified to not throw when given valid metadata.

    // Use the actual production loadRunner from the dispatcher — no inline
    // replication. This exercises every line of the closure, including the
    // walkWorkflow try/catch that emits run_failed on walker errors.
    const loadRunner = _buildLoadRunner({ blockRegistry, toolRegistry });

    const result = await dispatchWorkflow(
      { env, ctx: {} as ExecutionContext },
      {
        payload: {
          __dispatcherMetadata: {
            workflowId: wfId,
            organizationId: ORG_ID,
            workflowVersion: "1",
            runId,
          },
          params: {},
        },
        timestamp: new Date(),
        instanceId: runId,
      },
      mockStep,
      loadRunner,
    );

    expect(result).toBeDefined();

    // Verify step.do was called 3 times (once per compute block)
    expect(stepCalls.filter((c) => c.method === "do").length).toBe(3);

    // Verify step rows in D1 (scoped by org)
    const storage = new D1Storage(env.THODARE_DB, ORG_ID);
    const steps = await storage.steps.list(runId as never);
    expect(steps.length).toBe(3);
    for (const step of steps) {
      // Engine's walkWorkflow names steps as `block.<id>.run` (see walk.ts:stepName)
      expect(step.name).toMatch(/^block\.(block-1|block-2|block-3)\.run$/);
      expect(step.status).toBe("completed");
      expect(step.output).toBeDefined();
    }

    // Verify events in D1: step_started + step_completed for each block = 6 events
    const events = await storage.events.list({ runId });
    const stepEvents = events.filter(
      (e) => e.type === "step_started" || e.type === "step_completed",
    );
    expect(stepEvents.length).toBe(6);

    // Verify org scoping: cross-org reads return nothing
    const storageB = new D1Storage(env.THODARE_DB, "other-org");
    const crossSteps = await storageB.steps.list(runId as never);
    expect(crossSteps.length).toBe(0);
  });

  it("emits run_failed and updates run status when walker throws", async () => {
    const blockRegistry = new BlockRegistry();
    blockRegistry.register(ECHO_BLOCK);

    const failingTool: Tool = {
      ...ECHO_TOOL,
      execute: async () => {
        throw new Error("simulated tool failure");
      },
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(failingTool);

    const wf = buildWorkflowJson();
    const runId = "fail-run-" + crypto.randomUUID().slice(0, 8);
    const wfId = "wff-" + crypto.randomUUID().slice(0, 8);

    await backend.defineWorkflow({ name: wfId }, async () => {});
    await backend.setWorkflowDefinition(wfId, 1, wf);

    await env.THODARE_DB
      .prepare(
        `INSERT INTO runs (id, workflow_name, organization_id, spec_version, input, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(runId, wfId, ORG_ID, 1, JSON.stringify({}), "running", new Date().toISOString())
      .run();

    const mockStep = {
      do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      sleep: async (): Promise<void> => {},
      waitForEvent: async (): Promise<undefined> => undefined,
    };

    const { dispatchWorkflow } = await import("@cloudflare/dynamic-workflows");
    const loadRunner = _buildLoadRunner({ blockRegistry, toolRegistry });

    let threw = false;
    try {
      await dispatchWorkflow(
        { env, ctx: {} as ExecutionContext },
        {
          payload: {
            __dispatcherMetadata: {
              workflowId: wfId,
              organizationId: ORG_ID,
              workflowVersion: "1",
              runId,
            },
            params: {},
          },
          timestamp: new Date(),
          instanceId: runId,
        },
        mockStep,
        loadRunner,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Verify run_failed event written + run row marked failed.
    const storage = new D1Storage(env.THODARE_DB, ORG_ID);
    const events = await storage.events.list({ runId });
    const runFailed = events.find((e) => e.type === "run_failed");
    expect(runFailed).toBeDefined();
    const failedPayload = runFailed?.payload as Record<string, unknown>;
    expect(typeof failedPayload["error"]).toBe("string");

    const run = await storage.runs.get(runId as never);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBeDefined();
  });

  it("defineWorkflow without setWorkflowDefinition: dispatcher loadRunner throws", async () => {
    const blockRegistry = new BlockRegistry();
    blockRegistry.register(ECHO_BLOCK);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(ECHO_TOOL);

    const wfId = `null-def-${crypto.randomUUID().slice(0, 8)}`;
    await backend.defineWorkflow({ name: wfId }, async () => {});
    // Intentionally do NOT call setWorkflowDefinition.

    const { dispatchWorkflow } = await import("@cloudflare/dynamic-workflows");
    const loadRunner = _buildLoadRunner({ blockRegistry, toolRegistry });

    let errorMessage = "";
    try {
      await dispatchWorkflow(
        { env, ctx: {} as ExecutionContext },
        {
          payload: {
            __dispatcherMetadata: {
              workflowId: wfId,
              organizationId: ORG_ID,
              workflowVersion: "1",
              runId: "null-def-run",
            },
            params: {},
          },
          timestamp: new Date(),
          instanceId: "null-def-run",
        },
        { do: async <T>(_n: string, fn: () => Promise<T>) => fn(), sleep: async () => {}, waitForEvent: async () => undefined },
        loadRunner,
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("no SerializedWorkflow attached");
    expect(errorMessage).toContain("setWorkflowDefinition");
  });
});
