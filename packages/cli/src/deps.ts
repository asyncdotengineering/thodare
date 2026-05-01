/**
 * Injectable dependencies for the CLI. The binary entry wires real
 * implementations; tests pass in-memory + harness-fetch versions.
 */

import { createInterface } from "node:readline/promises";
import type { CredentialsStore } from "./credentials.js";

export interface CliDeps {
  fetch: typeof fetch;
  prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  credentials: CredentialsStore;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Default API URL when neither `--api` nor `THODARE_API` is set. */
  defaultApi: string;
  /** Mockable clock. */
  now: () => Date;
}

export function defaultPrompt(): CliDeps["prompt"] {
  return async (question, opts) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      if (opts?.mask) {
        process.stdout.write(question);
        return await new Promise<string>((resolve) => {
          let answer = "";
          const onData = (buf: Buffer) => {
            const s = buf.toString("utf-8");
            for (const ch of s) {
              if (ch === "\n" || ch === "\r") {
                process.stdin.removeListener("data", onData);
                process.stdin.pause();
                process.stdout.write("\n");
                resolve(answer);
                return;
              }
              if (ch === "" || ch === "\b") {
                answer = answer.slice(0, -1);
              } else if (ch === "") {
                process.exit(130);
              } else {
                answer += ch;
              }
            }
          };
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          process.stdin.on("data", onData);
        });
      }
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
