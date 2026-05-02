// BackendCapabilities — exactly 17 flags.
//
// Runtime (8):
//   1. maxStepDurationMs
//   2. maxRunDurationMs
//   3. signalPrecision
//   4. exactlyOnceSteps
//   5. serverless
//   6. pricingModel
//   7. maxStepOutputBytes?
//   8. maxPersistedStateBytes?
//
// Headless-builder (5):
//   9.  supportsLiveSubscription
//   10. supportsStepIOInspection
//   11. supportsResumeFromStep
//   12. supportsRecover
//   13. liveSubscriptionLatencyMs
//
// Op semantics (1):
//   14. supportsRemovedTombstone
//
// Cross-section (3):
//   15. supportsContainerBlocks
//   16. supportsDynamicSchemas
//   17. supportsAwaitFirstBlockResult

export interface BackendCapabilities {
  readonly maxStepDurationMs: number;
  readonly maxRunDurationMs: number;
  readonly signalPrecision: "exact" | "best-effort";
  readonly exactlyOnceSteps: boolean;
  readonly serverless: boolean;
  readonly pricingModel:
    | "self-host"
    | "per-invocation"
    | "per-second"
    | "managed-flat";
  readonly maxStepOutputBytes?: number;
  readonly maxPersistedStateBytes?: number;

  readonly supportsLiveSubscription: boolean;
  readonly supportsStepIOInspection: boolean;
  readonly supportsResumeFromStep: boolean;
  readonly supportsRecover: boolean;
  readonly liveSubscriptionLatencyMs: number;

  readonly supportsRemovedTombstone: boolean;

  readonly supportsContainerBlocks: boolean;
  readonly supportsDynamicSchemas: boolean;
  readonly supportsAwaitFirstBlockResult: boolean;
}
