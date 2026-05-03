import { describe, it, expect } from "vitest";
import { isThodareMetadata } from "../src/types.js";
import { CAPABILITIES } from "../src/capabilities.js";
import {
  createCloudflareDispatcher,
  DynamicWorkflowBinding,
} from "../src/dispatcher.js";

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
    expect(CAPABILITIES.supportsLiveSubscription).toBe(false);
    // No code path writes step rows in v1 alpha — must remain false.
    expect(CAPABILITIES.supportsStepIOInspection).toBe(false);
    expect(CAPABILITIES.supportsResumeFromStep).toBe(false);
    expect(CAPABILITIES.supportsRecover).toBe(false);
    expect(CAPABILITIES.liveSubscriptionLatencyMs).toBe(0);
    expect(CAPABILITIES.supportsRemovedTombstone).toBe(false);
    expect(CAPABILITIES.supportsContainerBlocks).toBe(false);
    expect(CAPABILITIES.supportsDynamicSchemas).toBe(false);
    expect(CAPABILITIES.supportsAwaitFirstBlockResult).toBe(false);
  });

  it("declares no `true` for any unsupported feature", () => {
    const unsupported: Array<keyof typeof CAPABILITIES> = [
      "supportsLiveSubscription",
      "supportsStepIOInspection",
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
      }),
    ).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(isThodareMetadata({ organizationId: "o", workflowVersion: "1" })).toBe(false);
    expect(isThodareMetadata({ workflowId: "w", workflowVersion: "1" })).toBe(false);
    expect(isThodareMetadata({ workflowId: "w", organizationId: "o" })).toBe(false);
  });

  it("rejects null and non-object", () => {
    expect(isThodareMetadata(null as never)).toBe(false);
    expect(isThodareMetadata("not-an-object" as never)).toBe(false);
  });
});

describe("createCloudflareDispatcher", () => {
  it("returns DynamicWorkflowBinding identical to the upstream export", () => {
    const factory = createCloudflareDispatcher();
    expect(factory.DynamicWorkflowBinding).toBe(DynamicWorkflowBinding);
  });

  it("returns a ThodareWorkflow class with its own run method", () => {
    const factory = createCloudflareDispatcher();
    expect(typeof factory.ThodareWorkflow).toBe("function");
    // The class returned by createDynamicWorkflowEntrypoint extends
    // WorkflowEntrypoint and overrides run(); we cannot instantiate it
    // outside a real RPC context (per upstream tests entrypoint.test.ts:211),
    // but it must declare its own `run` on the prototype.
    expect(typeof factory.ThodareWorkflow.prototype.run).toBe("function");
  });

  it("accepts a custom d1BindingName without altering surface", () => {
    const factory = createCloudflareDispatcher({ d1BindingName: "MY_DB" });
    expect(factory.DynamicWorkflowBinding).toBe(DynamicWorkflowBinding);
    expect(typeof factory.ThodareWorkflow).toBe("function");
  });
});
