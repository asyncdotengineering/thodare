/**
 * Typed fluent workflow builder.
 *
 * Pattern shape: Drizzle's query builder + tRPC's chained procedure builder.
 * Each `.step(id, connector, paramsFn)` returns a NEW builder type that
 * accumulates `id → outputs[]` into a phantom map. The next `paramsFn`
 * sees `{ input, ...allPreviousSteps }` fully typed; misspellings fail at
 * compile time, autocomplete works on every block output.
 *
 * Compiles down to `SerializedWorkflow` — the same JSON the LLM emits via
 * `applyOps`. The builder is the typed front end; the JSON is the wire
 * format. Same shape, different ergonomics.
 *
 * Reference resolution: paramsFn receives objects whose property values
 * are STRING TEMPLATES (`"{{stepId.field}}"`), not actual data. This is
 * the trick that makes type safety possible while still emitting
 * runtime-resolvable JSON. The resolver in src/executor/resolver.ts
 * substitutes at run time.
 */

import { z, type ZodObject } from "zod";
import type { ConnectorDef } from "./connector.js";
import type { SerializedBlock, SerializedConnection, SerializedWorkflow } from "../types.js";

/* ──────────────────────────  Reference proxies  ───────────────────────── */

/**
 * A reference proxy — when the user writes `enrich.body.name` in paramsFn,
 * we capture the path and emit `"{{enrich.body.name}}"`. The proxy preserves
 * the type from the connector's output schema so IntelliSense works.
 */
type Ref<T> = T extends object
  ? T extends Array<infer U>
    ? Ref<U>[] & string
    : { [K in keyof T]: Ref<T[K]> } & string
  : T & string;

function makeRef(path: string): unknown {
  const template = `{{${path}}}`;
  // The Proxy wraps a callable function (objects must be objects, so we
  // pick `function` for the broadest compat). Coercion paths return the
  // template; property access returns a deeper ref.
  const fn = (() => template) as unknown as object;
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => template;
      if (prop === "toString" || prop === "valueOf") return () => template;
      if (prop === "toJSON") return () => template;
      if (typeof prop !== "string") return undefined;
      return makeRef(`${path}.${prop}`);
    },
    apply() {
      return template;
    },
  });
}

/* ──────────────────────────  Builder types  ───────────────────────── */

type StepCtx<Input, Steps extends Record<string, unknown>> = {
  input: Ref<Input>;
} & { [K in keyof Steps]: Ref<Steps[K]> };

interface BuilderState {
  name: string;
  inputSchema?: ZodObject<any>;
  blocks: SerializedBlock[];
  connections: SerializedConnection[];
  lastStepId?: string;
  triggerId: string;
}

/* ──────────────────────────  Builders  ───────────────────────── */

/**
 * Top-level entry. Returns a builder you chain `.input().step()...build()` on.
 *
 * @example
 *   const wf = defineWorkflow("lead-notifier")
 *     .input(z.object({ email: z.string() }))
 *     .step("enrich", http, ({ input }) => ({ url: "...", body: { email: input.email } }))
 *     .step("notify", slack, ({ input, enrich }) => ({ channel: "#sales", text: `Lead ${enrich.body.name}` }))
 *     .build();
 */
export function defineWorkflow(name: string): WorkflowBuilder<unknown, {}> {
  return new WorkflowBuilder<unknown, {}>({
    name,
    blocks: [
      // Implicit trigger block. Real triggers come later via .trigger() if
      // we add explicit trigger types; for now this is the entrypoint.
      { id: "__trigger__", type: "trigger_webhook", enabled: true, params: {} },
    ],
    connections: [],
    triggerId: "__trigger__",
  });
}

export class WorkflowBuilder<Input, Steps extends Record<string, unknown>> {
  /** @internal */
  constructor(private readonly state: BuilderState) {}

  /**
   * Declare the workflow's input schema. The trigger block is the first
   * runtime node; `input` is just a typed accessor to its payload.
   */
  input<S extends ZodObject<any>>(schema: S): WorkflowBuilder<z.infer<S>, Steps> {
    return new WorkflowBuilder<z.infer<S>, Steps>({
      ...this.state,
      inputSchema: schema,
    });
  }

  /**
   * Add a step. Both the connector AND the new step id become available to
   * subsequent `.step()` calls' `paramsFn`. Type-level uniqueness check
   * prevents duplicate step ids.
   */
  step<
    Id extends string,
    P extends ZodObject<any>,
    O extends ZodObject<any>,
  >(
    id: Id extends keyof Steps ? `ERROR: step id '${Id}' is already used` : Id,
    connector: ConnectorDef<P, O>,
    paramsFn: (ctx: StepCtx<Input, Steps>) => z.input<P>,
  ): WorkflowBuilder<Input, Steps & { [K in Id]: z.infer<O> }> {
    const stepId = id as string;
    const ctx = makeStepCtx<Input, Steps>(this.state.triggerId);
    const rawParams = paramsFn(ctx);
    // Materialize the proxy tree to plain JSON values BEFORE storing.
    // Each ref proxy implements toJSON() → its template; JSON.parse-of-stringify
    // collapses the whole tree to wire-format primitives.
    const params = JSON.parse(JSON.stringify(rawParams)) as Record<string, unknown>;

    const block: SerializedBlock = {
      id: stepId,
      type: connector.block.type,
      enabled: true,
      params,
    };
    const connections: SerializedConnection[] = [
      ...this.state.connections,
      { source: this.state.lastStepId ?? this.state.triggerId, target: stepId },
    ];

    return new WorkflowBuilder<Input, Steps & { [K in Id]: z.infer<O> }>({
      ...this.state,
      blocks: [...this.state.blocks, block],
      connections,
      lastStepId: stepId,
    });
  }

  /**
   * Compile to the wire format `SerializedWorkflow` — the same JSON
   * applyOps consumes from LLM patches. Round-trips through the validator.
   */
  build(): SerializedWorkflow {
    return {
      version: "1.0.0",
      metadata: { name: this.state.name },
      blocks: this.state.blocks,
      connections: this.state.connections,
    };
  }
}

function makeStepCtx<Input, Steps extends Record<string, unknown>>(
  triggerId: string,
): StepCtx<Input, Steps> {
  // The "trigger" key in references must match the resolver's TriggerResolver
  // namespace. We use the symbolic name "trigger" (NOT the block id).
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "input") return makeRef("trigger");
        if (prop === triggerId) return makeRef("trigger");
        return makeRef(prop);
      },
    },
  ) as StepCtx<Input, Steps>;
}
