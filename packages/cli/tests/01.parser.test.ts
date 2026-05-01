/**
 * Argv parser — tiny, predictable, dependency-free.
 */

import { describe, expect, it } from "vitest";
import { parseArgv } from "../src/parser.js";

describe("parseArgv", () => {
  it("returns empty command for no args", () => {
    const r = parseArgv([]);
    expect(r.command).toEqual([]);
    expect(r.flags).toEqual({});
    expect(r.positional).toEqual([]);
    expect(r.help).toBe(false);
    expect(r.version).toBe(false);
  });

  it("recognises --version and -v", () => {
    expect(parseArgv(["--version"]).version).toBe(true);
    expect(parseArgv(["-v"]).version).toBe(true);
  });

  it("recognises --help, -h, and the `help` subcommand", () => {
    expect(parseArgv(["--help"]).help).toBe(true);
    expect(parseArgv(["-h"]).help).toBe(true);
    expect(parseArgv(["help"]).help).toBe(true);
  });

  it("parses single-word commands with named flags", () => {
    const r = parseArgv(["login", "--api", "http://x", "--non-interactive"]);
    expect(r.command).toEqual(["login"]);
    expect(r.flags).toEqual({ api: "http://x", "non-interactive": true });
  });

  it("parses two-word commands like `key create`", () => {
    const r = parseArgv(["key", "create", "--name", "ci"]);
    expect(r.command).toEqual(["key", "create"]);
    expect(r.flags).toEqual({ name: "ci" });
    expect(r.positional).toEqual([]);
  });

  it("parses positional arguments after a two-word command", () => {
    const r = parseArgv(["key", "revoke", "abc123", "--api", "http://x"]);
    expect(r.command).toEqual(["key", "revoke"]);
    expect(r.positional).toEqual(["abc123"]);
    expect(r.flags["api"]).toBe("http://x");
  });

  it("does NOT collapse unknown two-token sequences as commands", () => {
    const r = parseArgv(["whoami", "extra"]);
    expect(r.command).toEqual(["whoami"]);
    expect(r.positional).toEqual(["extra"]);
  });

  it("handles flag-without-value before another flag", () => {
    const r = parseArgv(["login", "--non-interactive", "--api", "http://x"]);
    expect(r.flags).toEqual({ "non-interactive": true, api: "http://x" });
  });
});
