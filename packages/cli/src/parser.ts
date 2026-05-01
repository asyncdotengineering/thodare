/**
 * Tiny argv parser. ~60 LoC, no dependencies. Deliberately limited to
 * what the CLI actually uses: subcommand, named flags (`--name value`,
 * `--flag`), and positional arguments. No abbreviations, no aliases, no
 * config files — anything fancier and we'd want a real parser; anything
 * we ship now stays trivial to audit.
 */

export interface ParsedCommand {
  /** The subcommand path: e.g. ["login"], ["key","create"], or [] for bare `thodare`. */
  command: string[];
  /** Named flags: `--api foo` → { api: "foo" }; `--non-interactive` → { "non-interactive": true }. */
  flags: Record<string, string | boolean>;
  /** Positional arguments after the subcommand. */
  positional: string[];
  /** Was --version passed? */
  version: boolean;
  /** Was --help / -h passed (or "help" subcommand)? */
  help: boolean;
}

const KNOWN_TWO_WORD_COMMANDS = new Set(["key create", "key list", "key revoke"]);

export function parseArgv(argv: string[]): ParsedCommand {
  const out: ParsedCommand = {
    command: [],
    flags: {},
    positional: [],
    version: false,
    help: false,
  };

  // Walk argv, sniffing flags from positionals.
  const tokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--version" || t === "-v") {
      out.version = true;
      continue;
    }
    if (t === "--help" || t === "-h" || t === "help") {
      out.help = true;
      continue;
    }
    if (t.startsWith("--")) {
      const name = t.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[name] = next;
        i += 1;
      } else {
        out.flags[name] = true;
      }
      continue;
    }
    tokens.push(t);
  }

  // The command is the first 1–2 tokens, depending on whether
  // "<a> <b>" is a known two-word subcommand.
  if (tokens.length >= 2 && KNOWN_TWO_WORD_COMMANDS.has(`${tokens[0]} ${tokens[1]}`)) {
    out.command = [tokens[0]!, tokens[1]!];
    out.positional = tokens.slice(2);
  } else if (tokens.length >= 1) {
    out.command = [tokens[0]!];
    out.positional = tokens.slice(1);
  }

  return out;
}
