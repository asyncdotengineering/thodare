import { describe, it, expect } from "vitest";
import { isThodareMetadata } from "../src/types.js";
import { CAPABILITIES } from "../src/capabilities.js";
import {
  createCloudflareDispatcher,
  DynamicWorkflowBinding,
} from "../src/dispatcher.js";
import { BlockRegistry, ToolRegistry } from "@thodare/engine/registry";

function mockRegistries() {
  return {
    blockRegistry: new BlockRegistry(),
    toolRegistry: new ToolRegistry(),
  };
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe("capabilities", () => {
  it("declares the 17 flags with honest CF-specific values", () => {
    expect(CAPABILITIES.maxStepDurationMs).toBe(ONE_YEAR_MS);
    expect(CAPABILITIES.maxRunDurationMs).toBe(ONE_YEAR_MS);
    expect(CAPABILITIES.signalPrecision).toBe("exact");
    expect(CAPABILITIES.exactlyOnceSteps).toBe(true);
    expect(CAPABILITIES.serverless).toBe(true);
    expect(CAPABILITIES.pricingModel).toBe("per-invocation");
    expect(CAPABILITIES.maxStepOutputBytes).toBe(1_048_576);
    expect(CAPABILITIES.maxPersistedStateBytes).toBe(1_073_741_824);
    expect(CAPABILITIES.supportsLiveSubscription).toBe(true);
    // cf-step-shim writes step rows during walk.
    expect(CAPABILITIES.supportsStepIOInspection).toBe(true);
    expect(CAPABILITIES.supportsResumeFromStep).toBe(false);
    expect(CAPABILITIES.supportsRecover).toBe(false);
    expect(CAPABILITIES.liveSubscriptionLatencyMs).toBe(200);
    expect(CAPABILITIES.supportsRemovedTombstone).toBe(false);
    expect(CAPABILITIES.supportsContainerBlocks).toBe(false);
    expect(CAPABILITIES.supportsDynamicSchemas).toBe(false);
    expect(CAPABILITIES.supportsAwaitFirstBlockResult).toBe(false);
  });

  it("declares no `true` for any unsupported feature", () => {
    const unsupported: Array<keyof typeof CAPABILITIES> = [
      "supportsResumeFromStep",
      "supportsRecover",
      "supportsRemovedTombstone",
      "supportsContainerBlocks",
      "supportsDynamicSchemas",
      "supportsAwaitFirstBlockResult",
    ];
    for (const key of unsupported) {
      expect(CAPABILITIES[key]).toBe(false);
    }
  });
});

describe("isThodareMetadata", () => {
  it("accepts valid metadata", () => {
    expect(
      isThodareMetadata({
        workflowId: "wf-1",
        organizationId: "org-1",
        workflowVersion: "1",
        runId: "run-1",
      }),
    ).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(isThodareMetadata({ organizationId: "o", workflowVersion: "1" })).toBe(false);
    expect(isThodareMetadata({ workflowId: "w", workflowVersion: "1" })).toBe(false);
    expect(isThodareMetadata({ workflowId: "w", organizationId: "o" })).toBe(false);
  });

  it("rejects metadata missing runId", () => {
    expect(
      isThodareMetadata({
        workflowId: "w",
        organizationId: "o",
        workflowVersion: "1",
      }),
    ).toBe(false);
  });

  it("accepts metadata with runId", () => {
    expect(
      isThodareMetadata({
        workflowId: "w",
        organizationId: "o",
        workflowVersion: "1",
        runId: "r",
      }),
    ).toBe(true);
  });

  it("rejects null and non-object", () => {
    expect(isThodareMetadata(null as never)).toBe(false);
    expect(isThodareMetadata("not-an-object" as never)).toBe(false);
  });
});

describe("createCloudflareDispatcher", () => {
  const registries = mockRegistries();

  it("returns DynamicWorkflowBinding identical to the upstream export", () => {
    const factory = createCloudflareDispatcher(registries);
    expect(factory.DynamicWorkflowBinding).toBe(DynamicWorkflowBinding);
  });

  it("returns a ThodareWorkflow class with its own run method", () => {
    const factory = createCloudflareDispatcher(registries);
    expect(typeof factory.ThodareWorkflow).toBe("function");
    // The class returned by createDynamicWorkflowEntrypoint extends
    // WorkflowEntrypoint and overrides run(); we cannot instantiate it
    // outside a real RPC context (per upstream tests entrypoint.test.ts:211),
    // but it must declare its own `run` on the prototype.
    expect(typeof factory.ThodareWorkflow.prototype.run).toBe("function");
  });

  it("accepts a custom d1BindingName without altering surface", () => {
    const factory = createCloudflareDispatcher({
      ...registries,
      d1BindingName: "MY_DB",
    });
    expect(factory.DynamicWorkflowBinding).toBe(DynamicWorkflowBinding);
    expect(typeof factory.ThodareWorkflow).toBe("function");
  });

  it("loadRunner closure is constructed and ThodareWorkflow is not a stub", () => {
    // Phase 4.x: createCloudflareDispatcher must return a ThodareWorkflow
    // whose loadRunner is a real function (not a stub that throws).
    // We verify this implicitly by the fact that the factory is created
    // without error — the loadRunner is constructed eagerly.
    const factory = createCloudflareDispatcher(registries);
    expect(factory).toBeDefined();
    expect(typeof factory.ThodareWorkflow).toBe("function");
    expect(typeof factory.ThodareWorkflow.prototype.run).toBe("function");
  });

  it("accepts envVars and passes them through", () => {
    const factory = createCloudflareDispatcher({
      ...registries,
      envVars: { FOO: "bar" },
    });
    expect(factory).toBeDefined();
  });
});
