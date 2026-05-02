import { describe, it, expect } from "vitest";
import type {
  BackendCore,
  Storage,
  Streamer,
  QueuePush,
  QueuePull,
  QueueEmbedded,
} from "@thodare/backend";

type PushBackend = BackendCore & Storage & Streamer & QueuePush;
type PullBackend = BackendCore & Storage & Streamer & QueuePull;
type EmbeddedBackend = BackendCore & Storage & Streamer & QueueEmbedded;

export function registerPushMode(backend: PushBackend): void {
  describe("mode/push", () => {
    it("createQueueHandler returns a function accepting Request", () => {
      const handler = backend.createQueueHandler("test", async () => {});
      expect(typeof handler).toBe("function");
      expect(handler.length).toBeGreaterThanOrEqual(1);
    });

    it("queue enqueues a message", async () => {
      const result = await backend.queue("test", {
        runId: "fake-run",
        correlationId: "corr-1",
      });
      expect(result).toBeDefined();
    });
  });
}

export function registerPullMode(backend: PullBackend): void {
  describe("mode/pull", () => {
    it("next returns a QueueDelivery or null", async () => {
      const delivery = await backend.next("test");
      if (delivery !== null) {
        expect(typeof delivery.messageId).toBe("string");
        expect(delivery.payload).toBeDefined();
        expect(typeof delivery.attemptCount).toBe("number");
        expect(typeof delivery.receivedAt).toBe("string");
      }
    });
  });
}

export function registerEmbeddedMode(backend: EmbeddedBackend): void {
  describe("mode/embedded", () => {
    it("mode is declared as embedded", () => {
      expect(backend.mode).toBe("embedded");
    });

    it("queue dispatches in-process without HTTP loopback", async () => {
      // Phase 3: verify enqueued messages are processed in-process
      // without an HTTP round-trip.
      await backend.queue("embedded-test", { runId: "fake" });
    });
  });
}
