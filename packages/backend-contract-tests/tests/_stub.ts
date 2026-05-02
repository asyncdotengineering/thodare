import type {
  ThodareBackend,
  BackendCapabilities,
  RunId,
} from "@thodare/backend";
import { SPEC_VERSION_CURRENT } from "@thodare/backend";

type StubOverrides = {
  id?: string;
  capabilities?: Partial<BackendCapabilities>;
  mode?: "push" | "pull" | "embedded";
};

function noopAsync<T>(): Promise<T> {
  return Promise.resolve(undefined as unknown as T);
}

function nullAsync<T>(): Promise<T | null> {
  return Promise.resolve(null);
}

function emptyArrayAsync<T>(): Promise<T[]> {
  return Promise.resolve([]);
}

export function makeStubBackend(overrides?: StubOverrides): ThodareBackend {
  const caps: BackendCapabilities = {
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
    ...overrides?.capabilities,
  };

  return {
    id: overrides?.id ?? "stub",
    capabilities: caps,
    specVersion: SPEC_VERSION_CURRENT,
    mode: overrides?.mode ?? "embedded",

    events: {
      create: (_e) => noopAsync(),
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

    queue: (_name, _payload, _opts) =>
      Promise.resolve({ messageId: null }),
    createQueueHandler: (_prefix: string, _handler) => {
      return (_req: Request) => Promise.resolve(new Response("ok"));
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
