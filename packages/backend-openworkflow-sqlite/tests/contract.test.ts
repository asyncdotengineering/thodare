import { afterAll } from "vitest";
import { runContractTests } from "@thodare/backend-contract-tests";
import { newHarness } from "./_harness.js";

const harness = await newHarness();

afterAll(async () => {
  await harness.dispose();
});

runContractTests(harness.backend, {
  skip: [
    "headless-builder/live-subscription",
    "headless-builder/resume-from-step",
    "headless-builder/recover",
    "container-blocks",
    "dynamic-schemas",
    "sync-block-result",
    "core/tombstone-replay",
  ],
});
