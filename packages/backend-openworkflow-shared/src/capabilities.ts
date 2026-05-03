import type { BackendCapabilities } from "@thodare/backend";

export const CAPABILITIES: BackendCapabilities = {
  maxStepDurationMs: 1_800_000,
  maxRunDurationMs: Number.MAX_SAFE_INTEGER,
  signalPrecision: "exact",
  exactlyOnceSteps: true,
  serverless: false,
  pricingModel: "self-host",

  supportsLiveSubscription: false,
  supportsStepIOInspection: true,
  supportsResumeFromStep: false,
  supportsRecover: false,
  liveSubscriptionLatencyMs: 0,

  supportsRemovedTombstone: false,

  supportsContainerBlocks: false,
  supportsDynamicSchemas: false,
  supportsAwaitFirstBlockResult: false,
};
