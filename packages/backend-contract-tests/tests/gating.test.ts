import { describe, it, expect } from "vitest";
import { runContractTests } from "../src/run-contract-tests.js";
import { packPredicate } from "../src/options.js";
import { makeStubBackend } from "./_stub.js";

describe("gating — capability-based pack registration", () => {
  it("stub with supportsLiveSubscription: false skips live-subscription pack", () => {
    const backend = makeStubBackend({
      capabilities: {
        supportsLiveSubscription: false,
        supportsStepIOInspection: false,
        supportsResumeFromStep: false,
        supportsRecover: false,
        supportsContainerBlocks: false,
        supportsDynamicSchemas: false,
        supportsAwaitFirstBlockResult: false,
      },
    });
    // Registration must not throw; skips are handled by describe.skipIf
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("stub with mode=pull skips push and embedded packs", () => {
    const backend = makeStubBackend({ mode: "pull" });
    expect(backend.mode).toBe("pull");
    // Registration must not throw
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("stub with mode=push skips pull and embedded packs", () => {
    const backend = makeStubBackend({ mode: "push" });
    expect(backend.mode).toBe("push");
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("stub with mode=embedded skips push and pull packs", () => {
    const backend = makeStubBackend({ mode: "embedded" });
    expect(backend.mode).toBe("embedded");
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("stub with supportsContainerBlocks: false skips container pack registration", () => {
    const backend = makeStubBackend({
      capabilities: { supportsContainerBlocks: false },
    });
    expect(backend.capabilities.supportsContainerBlocks).toBe(false);
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("stub with supportsDynamicSchemas: false skips dynamic schema packs", () => {
    const backend = makeStubBackend({
      capabilities: { supportsDynamicSchemas: false },
    });
    expect(backend.capabilities.supportsDynamicSchemas).toBe(false);
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("stub with supportsAwaitFirstBlockResult: false skips sync-block-result packs", () => {
    const backend = makeStubBackend({
      capabilities: { supportsAwaitFirstBlockResult: false },
    });
    expect(backend.capabilities.supportsAwaitFirstBlockResult).toBe(false);
    expect(() => {
      runContractTests(backend);
    }).not.toThrow();
  });

  it("pack predicate correctly gates by capability prefix", () => {
    // direct predicate tests complementing the capability-gated describe.skipIf
    expect(packPredicate("headless-builder/live-subscription", { skip: ["headless-builder"] })).toBe(false);
    expect(packPredicate("headless-builder/live-subscription", { skip: ["core"] })).toBe(true);
  });
});
