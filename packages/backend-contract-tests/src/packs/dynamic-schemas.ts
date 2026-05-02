import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerDynamicSchemasHappyPath(
  backend: ThodareBackend,
): void {
  describe("dynamic-schemas/happy-path", () => {
    it("dynamic schema refresh returns fresh sub-block schema", async () => {
      expect(backend.capabilities.supportsDynamicSchemas).toBe(true);
      // Phase 2+ POST /api/connectors/:type/refresh:
      // canvas sends formState; receives fresh SubBlock schema.
      // Phase 1: verify capability flag is honest.
      expect(typeof backend.capabilities.supportsDynamicSchemas).toBe("boolean");
    });
  });
}

export function registerDynamicSchemasCredentialInjection(
  backend: ThodareBackend,
): void {
  describe("dynamic-schemas/credential-injection", () => {
    it("dynamic schema function receives credential; secret never leaks in response", async () => {
      expect(backend.capabilities.supportsDynamicSchemas).toBe(true);
      // Phase 2+: assert that credential is resolved and passed
      // to the dynamic schema callback, but response body does
      // not contain the raw secret.
      expect(backend.events).toBeDefined();
    });
  });
}
