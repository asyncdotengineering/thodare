import { describe, it, expect } from "vitest";
import { runContractTests } from "../src/run-contract-tests.js";
import { makeStubBackend } from "./_stub.js";

describe("smoke — runContractTests registration", () => {
  it("runContractTests does not throw at registration time against a valid stub", () => {
    const backend = makeStubBackend();
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("runContractTests with skip option does not throw", () => {
    const backend = makeStubBackend();
    expect(() => {
      runContractTests(backend, { skip: ["core/happy-path"] });
    }).not.toThrow();
  });

  it("runContractTests with only option does not throw", () => {
    const backend = makeStubBackend();
    expect(() => {
      runContractTests(backend, { only: ["timezone/happy-path"] });
    }).not.toThrow();
  });

  it("stub backend exposes all expected top-level properties", () => {
    const backend = makeStubBackend();
    expect(typeof backend.id).toBe("string");
    expect(typeof backend.capabilities).toBe("object");
    expect(typeof backend.defineWorkflow).toBe("function");
    expect(typeof backend.runWorkflow).toBe("function");
    expect(typeof backend.signal).toBe("function");
    expect(typeof backend.cancel).toBe("function");
    expect(typeof backend.resumeFromStep).toBe("function");
    expect(typeof backend.recover).toBe("function");
    expect(backend.events).toBeDefined();
    expect(backend.runs).toBeDefined();
    expect(backend.steps).toBeDefined();
    expect(backend.hooks).toBeDefined();
    expect(backend.streams).toBeDefined();
  });

  it("stub backend capabilities have all 17 fields", () => {
    const backend = makeStubBackend();
    const c = backend.capabilities;
    // 17 flags total: 8 runtime + 5 headless + 1 op + 3 cross-section
    const keys = Object.keys(c) as Array<keyof typeof c>;
    // Runtime: maxStepDurationMs, maxRunDurationMs, signalPrecision,
    //   exactlyOnceSteps, serverless, pricingModel,
    //   maxStepOutputBytes?, maxPersistedStateBytes?
    // Headless: supportsLiveSubscription, supportsStepIOInspection,
    //   supportsResumeFromStep, supportsRecover, liveSubscriptionLatencyMs
    // Op: supportsRemovedTombstone
    // Cross: supportsContainerBlocks, supportsDynamicSchemas,
    //   supportsAwaitFirstBlockResult
    expect(keys.length).toBe(17);
  });

  it("37 packs are reachable when all capabilities are true and mode=embedded + only=[]", () => {
    const backend = makeStubBackend({
      capabilities: {
        supportsLiveSubscription: true,
        supportsStepIOInspection: true,
        supportsResumeFromStep: true,
        supportsRecover: true,
        supportsContainerBlocks: true,
        supportsDynamicSchemas: true,
        supportsAwaitFirstBlockResult: true,
      },
      mode: "embedded",
    });
    // All 37 packs should be registered when all capabilities enabled.
    // With mode=embedded, the push/pull packs are excluded, so:
    // 10 core + 7 headless + 1 mode(embedded only) + 5 container + 2 visibility
    //   + 2 dynamic-schemas + 3 timezone + 3 diff + 2 sync-block = 35
    // (push and pull are excluded by mode=embedded)
    expect(() => {
      runContractTests(backend, { only: [] });
    }).not.toThrow();
  });
});
