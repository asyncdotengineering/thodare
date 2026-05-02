import { describe, it, expect } from "vitest";
import { packPredicate } from "../src/options.js";
import type { ContractTestOptions } from "../src/options.js";

describe("packPredicate", () => {
  it("returns true when no options are provided", () => {
    expect(packPredicate("core/happy-path")).toBe(true);
  });

  it("returns false when packId is in skip list (exact match)", () => {
    const opts: ContractTestOptions = { skip: ["core/happy-path"] };
    expect(packPredicate("core/happy-path", opts)).toBe(false);
  });

  it("returns false when packId is in skip list (prefix match)", () => {
    const opts: ContractTestOptions = { skip: ["core"] };
    expect(packPredicate("core/happy-path", opts)).toBe(false);
    expect(packPredicate("core/sleep-precision", opts)).toBe(false);
  });

  it("returns true when packId is NOT in skip list", () => {
    const opts: ContractTestOptions = { skip: ["core/happy-path"] };
    expect(packPredicate("timezone/happy-path", opts)).toBe(true);
  });

  it("only option includes only the named pack (exact)", () => {
    const opts: ContractTestOptions = { only: ["timezone/happy-path"] };
    expect(packPredicate("timezone/happy-path", opts)).toBe(true);
    expect(packPredicate("core/happy-path", opts)).toBe(false);
  });

  it("only option includes packs under a prefix", () => {
    const opts: ContractTestOptions = { only: ["core"] };
    expect(packPredicate("core/happy-path", opts)).toBe(true);
    expect(packPredicate("core/sleep-precision", opts)).toBe(true);
    expect(packPredicate("timezone/happy-path", opts)).toBe(false);
  });

  it("only overrides skip when both are set", () => {
    const opts: ContractTestOptions = {
      skip: ["core/happy-path"],
      only: ["core/happy-path"],
    };
    // only takes priority over skip
    expect(packPredicate("core/happy-path", opts)).toBe(true);
    // packs not in only are excluded
    expect(packPredicate("core/sleep-precision", opts)).toBe(false);
  });

  it("only with empty array is treated as absent", () => {
    const opts: ContractTestOptions = { skip: ["core/happy-path"], only: [] };
    // empty only means no filter → skip applies
    expect(packPredicate("core/happy-path", opts)).toBe(false);
    expect(packPredicate("timezone/happy-path", opts)).toBe(true);
  });
});
