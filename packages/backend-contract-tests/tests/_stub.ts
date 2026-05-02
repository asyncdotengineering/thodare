import type {
  ThodareBackend,
  BackendCore,
  BackendCapabilities,
  Storage,
  Streamer,
  QueuePush,
  QueuePull,
  QueueEmbedded,
  RunId,
  EventId,
} from "@thodare/backend";
import { SPEC_VERSION_CURRENT } from "@thodare/backend";

type StubOverrides = {
  id?: string;
  capabilities?: Partial<BackendCapabilities>;
  mode?: "push" | "pull" | "embedded";
};

function nullAsync<T>(): Promise<T | null> {
  return Promise.resolve(null);
}

function emptyArrayAsync<T>(): Promise<T[]> {
  return Promise.resolve([]);
}

function buildCore(
  caps: BackendCapabilities,
  id: string,
): BackendCore & Storage & Streamer {
  return {
    id,
    capabilities: caps,
    specVersion: SPEC_VERSION_CURRENT,

    events: {
      create: (_e) =>
        Promise.resolve({
          event: {
            id: "stub-evt" as EventId,
            type: "run_started",
            runId: "stub-run",
            payload: {
              type: "run_started",
              runId: "stub-run",
              workflowName: "stub",
              input: undefined,
              startedAt: new Date(0).toISOString(),
            },
            createdAt: new Date(0).toISOString(),
          },
        }),
      get: (_id) => nullAsync(),
      list: (_f) => emptyArrayAsync(),
      listByCorrelationId: (_c) => emptyArrayAsync(),
    },
    runs: {
      get: (_id) => nullAsync(),
      list: (_f) => emptyArrayAsync(),
    },
    steps: {
      get: (_id) => nullAsync(),
      list: (_id) => emptyArrayAsync(),
    },
    hooks: {
      get: (_id) => nullAsync(),
      getByToken: (_t) => nullAsync(),
      list: (_f) => emptyArrayAsync(),
    },

    streams: {
      write: (_c, _r, _ch) => Promise.resolve(),
      close: (_c, _r) => Promise.resolve(),
      get: (_c, _r) => nullAsync(),
      list: (_r) => emptyArrayAsync(),
      getChunks: (_c, _r, _s) => emptyArrayAsync(),
      getInfo: (_c, _r) => nullAsync(),
    },

    defineWorkflow: (_s, _h) =>
      Promise.resolve({ name: _s.name, specVersion: SPEC_VERSION_CURRENT }),
    runWorkflow: (_n, _i, _o) =>
      Promise.resolve({ runId: "stub-run-id" as RunId }),
    signal: (_r, _s, _p) => Promise.resolve(),
    cancel: (_r) => Promise.resolve(),
    resumeFromStep: (_r, _s) => Promise.resolve({ runId: _r }),
    recover: (_r) => Promise.resolve({ runId: _r }),
  };
}

function defaultCaps(overrides?: Partial<BackendCapabilities>): BackendCapabilities {
  return {
    maxStepDurationMs: 900_000,
    maxRunDurationMs: 3_600_000,
    signalPrecision: "exact",
    exactlyOnceSteps: true,
    serverless: false,
    pricingModel: "self-host",
    maxStepOutputBytes: 1_048_576,
    maxPersistedStateBytes: 1_073_741_824,
    supportsLiveSubscription: true,
    supportsStepIOInspection: true,
    supportsResumeFromStep: true,
    supportsRecover: true,
    liveSubscriptionLatencyMs: 50,
    supportsRemovedTombstone: true,
    supportsContainerBlocks: true,
    supportsDynamicSchemas: true,
    supportsAwaitFirstBlockResult: true,
    ...overrides,
  };
}

const queueCommon = {
  queue: (_n: string, _p: unknown, _o?: unknown) =>
    Promise.resolve({ messageId: null }),
};

export function makeStubBackend(overrides?: StubOverrides): ThodareBackend {
  const caps = defaultCaps(overrides?.capabilities);
  const core = buildCore(caps, overrides?.id ?? "stub");
  const mode = overrides?.mode ?? "embedded";

  if (mode === "push") {
    const push: QueuePush = {
      mode: "push",
      ...queueCommon,
      createQueueHandler: (_prefix, _handler) =>
        (_req: Request) => Promise.resolve(new Response("ok")),
    };
    return { ...core, ...push };
  }
  if (mode === "pull") {
    const pull: QueuePull = {
      mode: "pull",
      ...queueCommon,
      next: (_prefix) => nullAsync(),
    };
    return { ...core, ...pull };
  }
  const embedded: QueueEmbedded = {
    mode: "embedded",
    ...queueCommon,
  };
  return { ...core, ...embedded };
}
