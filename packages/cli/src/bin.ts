#!/usr/bin/env node
/**
 * Binary entry — wires real fs, real prompt, real fetch.
 */

import { runCli } from "./run.js";
import { defaultPrompt } from "./deps.js";
import { createCredentialsStore } from "./credentials.js";

const deps = {
  fetch,
  prompt: defaultPrompt(),
  credentials: createCredentialsStore(),
  stdout: process.stdout,
  stderr: process.stderr,
  defaultApi: "https://api.thodare.dev",
  now: () => new Date(),
};

const code = await runCli(process.argv.slice(2), deps);
process.exit(code);
