import { describe } from "vitest";
import type { ThodareBackend } from "@thodare/backend";
import type { ContractTestOptions } from "./options.js";
import { packPredicate } from "./options.js";

import {
  registerCoreHappyPath,
  registerCoreReplayDeterminism,
  registerCoreSleepPrecision,
  registerCoreSignalDelivery,
  registerCoreCancellation,
  registerCoreMultiTenantIsolation,
  registerCoreIdempotency,
  registerCoreCapabilityHonesty,
  registerCoreTombstoneReplay,
  registerCoreRawConfigRoundTrip,
} from "./packs/core.js";

import {
  registerHeadlessLiveSubscription,
  registerHeadlessStepIOInspection,
  registerHeadlessResumeFromStep,
  registerHeadlessRecover,
  registerHeadlessConnectorMetadata,
  registerHeadlessCredentialRoundTrip,
  registerHeadlessNdjsonOpStream,
} from "./packs/headless-builder.js";

import {
  registerPushMode,
  registerPullMode,
  registerEmbeddedMode,
} from "./packs/mode-specific.js";

import {
  registerContainerForeachSequential,
  registerContainerForeachParallel,
  registerContainerParallelAll,
  registerContainerBranchOne,
  registerContainerWhileLoop,
} from "./packs/container-blocks.js";

import {
  registerVisibilityHiddenFromDisplay,
  registerVisibilityLlmOnly,
} from "./packs/visibility.js";

import {
  registerDynamicSchemasHappyPath,
  registerDynamicSchemasCredentialInjection,
} from "./packs/dynamic-schemas.js";

import {
  registerTimezoneHappyPath,
  registerTimezoneDstTransition,
  registerTimezoneSkipWeekends,
} from "./packs/timezone.js";

import {
  registerDiffBlockAdd,
  registerDiffBlockDeleteWithTombstone,
  registerDiffRoundTrip,
} from "./packs/diff.js";

import {
  registerSyncBlockResult,
  registerSyncBlockTimeout,
} from "./packs/sync-block-result.js";

export function runContractTests(
  backend: ThodareBackend,
  options?: ContractTestOptions,
): void {
  // ── Core (1-10, every adapter) ──

  if (packPredicate("core/happy-path", options)) {
    registerCoreHappyPath(backend);
  }
  if (packPredicate("core/replay-determinism", options)) {
    registerCoreReplayDeterminism(backend);
  }
  if (packPredicate("core/sleep-precision", options)) {
    registerCoreSleepPrecision(backend);
  }
  if (packPredicate("core/signal-delivery", options)) {
    registerCoreSignalDelivery(backend);
  }
  if (packPredicate("core/cancellation", options)) {
    registerCoreCancellation(backend);
  }
  if (packPredicate("core/multi-tenant-isolation", options)) {
    registerCoreMultiTenantIsolation(backend);
  }
  if (packPredicate("core/idempotency", options)) {
    registerCoreIdempotency(backend);
  }
  if (packPredicate("core/capability-honesty", options)) {
    registerCoreCapabilityHonesty(backend);
  }
  if (packPredicate("core/tombstone-replay", options)) {
    registerCoreTombstoneReplay(backend);
  }
  if (packPredicate("core/raw-config-round-trip", options)) {
    registerCoreRawConfigRoundTrip(backend);
  }

  // ── Headless-builder (11-17, gated by capability flags) ──

  describe
    .skipIf(!backend.capabilities.supportsLiveSubscription)(
      "headless-builder/live-subscription",
      () => {
        if (packPredicate("headless-builder/live-subscription", options)) {
          registerHeadlessLiveSubscription(backend);
        }
      },
    );

  describe
    .skipIf(!backend.capabilities.supportsStepIOInspection)(
      "headless-builder/step-io-inspection",
      () => {
        if (packPredicate("headless-builder/step-io-inspection", options)) {
          registerHeadlessStepIOInspection(backend);
        }
      },
    );

  describe
    .skipIf(!backend.capabilities.supportsResumeFromStep)(
      "headless-builder/resume-from-step",
      () => {
        if (packPredicate("headless-builder/resume-from-step", options)) {
          registerHeadlessResumeFromStep(backend);
        }
      },
    );

  describe
    .skipIf(!backend.capabilities.supportsRecover)(
      "headless-builder/recover",
      () => {
        if (packPredicate("headless-builder/recover", options)) {
          registerHeadlessRecover(backend);
        }
      },
    );

  if (packPredicate("headless-builder/connector-metadata", options)) {
    registerHeadlessConnectorMetadata(backend);
  }

  if (packPredicate("headless-builder/credential-round-trip", options)) {
    registerHeadlessCredentialRoundTrip(backend);
  }

  if (packPredicate("headless-builder/ndjson-op-stream", options)) {
    registerHeadlessNdjsonOpStream(backend);
  }

  // ── Mode-specific (18-20, gated by Queue.mode) ──

  describe
    .skipIf(backend.mode !== "push")(
      `mode/push (mode = ${backend.mode})`,
      () => {
        if (packPredicate("mode/push", options)) {
          registerPushMode(backend);
        }
      },
    );

  describe
    .skipIf(backend.mode !== "pull")(
      `mode/pull (mode = ${backend.mode})`,
      () => {
        if (packPredicate("mode/pull", options)) {
          registerPullMode(backend);
        }
      },
    );

  describe
    .skipIf(backend.mode !== "embedded")(
      `mode/embedded (mode = ${backend.mode})`,
      () => {
        if (packPredicate("mode/embedded", options)) {
          registerEmbeddedMode(backend);
        }
      },
    );

  // ── Container blocks (21-25, gated by supportsContainerBlocks) ──

  describe
    .skipIf(!backend.capabilities.supportsContainerBlocks)(
      "container-blocks",
      () => {
        if (packPredicate("container-blocks/foreach-sequential", options)) {
          registerContainerForeachSequential(backend);
        }
        if (packPredicate("container-blocks/foreach-parallel", options)) {
          registerContainerForeachParallel(backend);
        }
        if (packPredicate("container-blocks/parallel-all", options)) {
          registerContainerParallelAll(backend);
        }
        if (packPredicate("container-blocks/branch-one", options)) {
          registerContainerBranchOne(backend);
        }
        if (packPredicate("container-blocks/while-loop", options)) {
          registerContainerWhileLoop(backend);
        }
      },
    );

  // ── Visibility (26-27, always-on) ──

  if (packPredicate("visibility/hidden-from-display", options)) {
    registerVisibilityHiddenFromDisplay(backend);
  }
  if (packPredicate("visibility/llm-only", options)) {
    registerVisibilityLlmOnly(backend);
  }

  // ── Dynamic schemas (28-29, gated by supportsDynamicSchemas) ──

  describe
    .skipIf(!backend.capabilities.supportsDynamicSchemas)(
      "dynamic-schemas",
      () => {
        if (packPredicate("dynamic-schemas/happy-path", options)) {
          registerDynamicSchemasHappyPath(backend);
        }
        if (packPredicate("dynamic-schemas/credential-injection", options)) {
          registerDynamicSchemasCredentialInjection(backend);
        }
      },
    );

  // ── Timezone (30-32, always-on) ──

  if (packPredicate("timezone/happy-path", options)) {
    registerTimezoneHappyPath(backend);
  }
  if (packPredicate("timezone/dst-transition", options)) {
    registerTimezoneDstTransition(backend);
  }
  if (packPredicate("timezone/skip-weekends", options)) {
    registerTimezoneSkipWeekends(backend);
  }

  // ── Diff (33-35, always-on) ──

  if (packPredicate("diff/block-add", options)) {
    registerDiffBlockAdd(backend);
  }
  if (packPredicate("diff/block-delete-with-tombstone", options)) {
    registerDiffBlockDeleteWithTombstone(backend);
  }
  if (packPredicate("diff/round-trip", options)) {
    registerDiffRoundTrip(backend);
  }

  // ── Sales-funnel router / sync block result (36-37, gated) ──

  describe
    .skipIf(!backend.capabilities.supportsAwaitFirstBlockResult)(
      "sync-block-result",
      () => {
        if (packPredicate("sync-block-result/first-block-result", options)) {
          registerSyncBlockResult(backend);
        }
        if (packPredicate("sync-block-result/first-block-timeout", options)) {
          registerSyncBlockTimeout(backend);
        }
      },
    );
}
