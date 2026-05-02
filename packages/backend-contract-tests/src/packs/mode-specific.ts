import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerPushMode(backend: ThodareBackend): void {
  describe("mode/push", () => {
    it("createQueueHandler returns a function accepting Request", () => {
      const handler = backend.createQueueHandler("test", async () => {});
      expect(typeof handler).toBe("function");
      // handler should accept a web Request and return a Response
      expect(handler.length).toBeGreaterThanOrEqual(1);
    });

    it("queue enqueues a message", async () => {
      const result = await backend.queue("test", {
        runId: "fake-run",
        correlationId: "corr-1",
      });
      // messageId may be null for some adapters; both are valid
      expect(result).toBeDefined();
    });
  });
}

export function registerPullMode(backend: ThodareBackend): void {
  describe("mode/pull", () => {
    it("next returns a QueueDelivery or null", async () => {
      if (typeof backend.next !== "function") {
        throw new Error("Pull mode adapter must implement next()");
      }
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

export function registerEmbeddedMode(backend: ThodareBackend): void {
  describe("mode/embedded", () => {
    it("mode is declared as embedded", () => {
      expect(backend.mode).toBe("embedded");
    });

    it("queue dispatches in-process without HTTP loopback", async () => {
      // Phase 3: verify that enqueued messages are processed
      // in-process without an HTTP round-trip.
      await backend.queue("embedded-test", { runId: "fake" });
    });
  });
}
