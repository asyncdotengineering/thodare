import type { BackendCapabilities } from "@thodare/backend";

// CF Workflows max sleep duration is 365 days per
// research/cloudflare-as-world.md:28 — set both step and run wall-clock
// caps to that value to avoid overstating durability.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000; // 31_536_000_000

export const CAPABILITIES: BackendCapabilities = {
  // Runtime (8)
  maxStepDurationMs: ONE_YEAR_MS,
  maxRunDurationMs: ONE_YEAR_MS,
  signalPrecision: "exact",
  // CF Workflows guarantees exactly-once *step replay dedup* — the engine will
  // not re-execute a completed step. Step *functions* must still be idempotent
  // because retries before completion replay the body. Same model as openworkflow.
  exactlyOnceSteps: true,
  serverless: true,
  pricingModel: "per-invocation",
  maxStepOutputBytes: 1_048_576,
  maxPersistedStateBytes: 1_073_741_824,

  // Headless-builder (5)
  supportsLiveSubscription: false,
  // No code path writes step rows in v1 alpha. The runtime walker bundle
  // (Phase 4.x) will populate the `steps` table; until then `steps.list`
  // returns []. Declared honestly as false.
  supportsStepIOInspection: false,
  supportsResumeFromStep: false,
  supportsRecover: false,
  liveSubscriptionLatencyMs: 0,

  // Op semantics (1)
  supportsRemovedTombstone: false,

  // Cross-section (3)
  supportsContainerBlocks: false,
  supportsDynamicSchemas: false,
  supportsAwaitFirstBlockResult: false,
} as const;
