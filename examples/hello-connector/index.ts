/**
 * hello-connector — the smallest interesting Thodare example.
 *
 * Defines two connectors (a trigger and an action), wires them into a
 * workflow programmatically (no LLM, no API, no Postgres), runs it
 * in-memory, prints the output.
 *
 * If you want the full HTTP control plane + LLM repair loop, see
 * `examples/full-llm-loop` instead.
 */

import { z } from "zod";
import { defineConnector, defineWorkflow, executeInMemory } from "@thodare/engine";

// 1. A trigger that emits a fixed payload.
const trigger = defineConnector({
  type: "trigger_hello",
  description: "Emits { name } once.",
  params: z.object({ name: z.string() }),
  outputs: z.object({ name: z.string() }),
  kind: "trigger",
  async run({ name }) {
    return { name };
  },
});

// 2. An action that greets.
const greet = defineConnector({
  type: "greet",
  description: "Returns 'hello, <name>!'",
  params: z.object({ name: z.string() }),
  outputs: z.object({ message: z.string() }),
  async run({ name }) {
    return { message: `hello, ${name}!` };
  },
});

// 3. Wire a workflow without the API.
const wf = defineWorkflow("hello")
  .input(z.object({}))
  .step("trg", trigger, () => ({ name: "Ada" }))
  .step("g", greet, ({ trg }) => ({ name: trg.name }))
  .build();

// 4. Run it in-memory.
const result = await executeInMemory(wf, {});
console.log(result.outputs.g);  // → { message: "hello, Ada!" }
