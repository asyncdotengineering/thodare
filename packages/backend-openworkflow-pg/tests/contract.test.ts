import { afterAll } from "vitest";
import { runContractTests } from "@thodare/backend-contract-tests";
import { newHarness } from "./_harness.js";

const harness = await newHarness();

afterAll(async () => {
  await harness.dispose();
});

// Register the parameterized contract suite against the openworkflow-pg
// adapter. Packs that require capabilities the adapter doesn't support yet
// (Phase 5b features) are explicitly skipped via packPredicate.
runContractTests(harness.backend, {
  skip: [
    // Phase 5b features — not supported by the openworkflow substrate yet
    "headless-builder/live-subscription",   // supportsLiveSubscription: false
    "headless-builder/resume-from-step",    // supportsResumeFromStep: false (Phase 5b)
    "headless-builder/recover",             // supportsRecover: false (Phase 5b)
    "container-blocks",                     // supportsContainerBlocks: false (Phase 5b)
    "dynamic-schemas",                      // supportsDynamicSchemas: false (Phase 5b)
    "sync-block-result",                    // supportsAwaitFirstBlockResult: false (Phase 5b)
    "core/tombstone-replay",                // supportsRemovedTombstone: false (Phase 5b)
  ],
});
