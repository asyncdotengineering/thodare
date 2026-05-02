/**
 * `defineConnector` — collapses wfkit's Tool + Block split into one declaration.
 *
 * Inputs:
 *   - Zod schemas for params and outputs (single source of truth)
 *   - A `run({...params}, ctx)` function that's FULLY TYPED from those schemas
 *
 * Outputs (via internal accessors): the underlying Tool and Block compatible
 * with the existing registries. The visibility flag is read from the param's
 * Zod schema brand (see `./visibility.ts`).
 *
 * Pattern lifted from Zod's `.describe()` and tRPC's `procedure.input(zod).query(handler)`
 * — schemas drive both runtime validation and TS-level inference.
 */

import { z, type ZodObject, type ZodTypeAny } from "zod";
import type {
  Block,
  BlockKind,
  ParamType,
  SubBlock,
  Tool,
  ToolContext,
  ToolOutputDef,
  ToolParamDef,
} from "../types.js";
import type { ToolCredentialBinding } from "../credentials/types.js";
import { readVisibility } from "./visibility.js";

export interface DefineConnectorOptions<
  P extends ZodObject<any>,
  O extends ZodObject<any>,
> {
  /** Block.type — the LLM-facing identifier ("slack", "http", "summarize"). */
  type: string;
  /** Optional human name; defaults to `type`. */
  name?: string;
  /** Markdown-ish one-line description shown to the LLM. */
  description?: string;
  /** Block category. */
  category?: "trigger" | "action" | "logic" | "tools" | "wait";
  /** Block kind: 'compute' | 'wait' | 'trigger'. Defaults to 'compute'. */
  kind?: BlockKind;
  /** Zod schema for params. Brand individual schemas with `hidden()` / `userOnly()` to set visibility. */
  params: P;
  /** Zod schema for outputs. Properties become declared block outputs. */
  outputs: O;
  /** Declare a credential binding. When set, the runtime injects ctx.credential
   * at execute time if the block params include a credentialId. */
  credential?: ToolCredentialBinding;
  /** The actual implementation. Fully typed: `params` is `z.infer<P>`. */
  run: (params: z.infer<P>, ctx: ToolContext) => Promise<z.infer<O>>;
}

export interface ConnectorDef<
  P extends ZodObject<any> = ZodObject<any>,
  O extends ZodObject<any> = ZodObject<any>,
> {
  readonly type: string;
  readonly tool: Tool;
  readonly block: Block;
  /** Reflective access to the source Zod schemas — useful for advanced flows. */
  readonly schemas: { params: P; outputs: O };
}

/**
 * Define a connector. Returns an object exposing the underlying Tool and Block,
 * plus the source Zod schemas for power users.
 *
 * @example
 *   const slack = defineConnector({
 *     type: "slack",
 *     params: z.object({
 *       channel: z.string(),
 *       text: z.string(),
 *       accessToken: hidden(z.string()),
 *     }),
 *     outputs: z.object({ ok: z.boolean(), ts: z.string() }),
 *     async run({ channel, text }, ctx) {
 *       return { ok: true, ts: String(Date.now()) };
 *     },
 *   });
 */
export function defineConnector<
  P extends ZodObject<any>,
  O extends ZodObject<any>,
>(opts: DefineConnectorOptions<P, O>): ConnectorDef<P, O> {
  const { type } = opts;
  const name = opts.name ?? type;
  const description = opts.description ?? "";
  const category = opts.category ?? "tools";
  const kind: BlockKind = opts.kind ?? "compute";

  const toolId = `${type}__tool`;
  const params = paramsFromZod(opts.params);
  const outputs = outputsFromZod(opts.outputs);

  const tool: Tool = {
    id: toolId,
    name,
    description,
    params,
    outputs,
    ...(opts.credential ? { credential: opts.credential } : {}),
    async execute(rawParams, ctx) {
      // Validate at the boundary. Surface a structured error if the
      // workflow JSON disagrees with the connector's declared schema.
      const parsed = opts.params.safeParse(rawParams);
      if (!parsed.success) {
        throw new Error(
          `[${type}] params validation failed: ${parsed.error.errors
            .map((e) => `${e.path.join(".")} — ${e.message}`)
            .join("; ")}`,
        );
      }
      return opts.run(parsed.data, ctx);
    },
  };

  const subBlocks: SubBlock[] = subBlocksFromZod(opts.params);

  const block: Block = {
    type,
    name,
    description,
    category,
    kind,
    subBlocks,
    outputs,
    tools: {
      access: [toolId],
      config: { tool: () => toolId },
    },
  };

  return {
    type,
    tool,
    block,
    schemas: { params: opts.params, outputs: opts.outputs },
  };
}

/* ──────────────  Zod → Tool/Block schema mapping  ────────────── */

function paramsFromZod(schema: ZodObject<any>): Record<string, ToolParamDef> {
  const out: Record<string, ToolParamDef> = {};
  const shape = schema.shape as Record<string, ZodTypeAny>;
  for (const [k, fieldSchema] of Object.entries(shape)) {
    out[k] = {
      type: zodToParamType(fieldSchema),
      required: !fieldSchema.isOptional(),
      visibility: readVisibility(fieldSchema),
      ...(fieldSchema.description ? { description: fieldSchema.description } : {}),
    };
  }
  return out;
}

function outputsFromZod(schema: ZodObject<any>): Record<string, ToolOutputDef> {
  const out: Record<string, ToolOutputDef> = {};
  const shape = schema.shape as Record<string, ZodTypeAny>;
  for (const [k, fieldSchema] of Object.entries(shape)) {
    out[k] = {
      type: zodToParamType(fieldSchema),
      ...(fieldSchema.description ? { description: fieldSchema.description } : {}),
    };
  }
  return out;
}

function subBlocksFromZod(schema: ZodObject<any>): SubBlock[] {
  const subBlocks: SubBlock[] = [];
  const shape = schema.shape as Record<string, ZodTypeAny>;
  for (const [k, fieldSchema] of Object.entries(shape)) {
    if (readVisibility(fieldSchema) === "hidden") continue;
    const t = zodToParamType(fieldSchema);
    let inputType: SubBlock["type"];
    if (t === "string") {
      inputType = isLongInput(fieldSchema) ? "long-input" : "short-input";
    } else if (t === "object" || t === "array") {
      inputType = "json";
    } else {
      inputType = "short-input";
    }
    const sb: SubBlock = {
      id: k,
      title: k,
      type: inputType,
      ...(fieldSchema.isOptional() ? {} : { required: true }),
      ...(fieldSchema.description ? { description: fieldSchema.description } : {}),
    };
    subBlocks.push(sb);
  }
  return subBlocks;
}

function zodToParamType(schema: ZodTypeAny): ParamType {
  // Unwrap optional / nullable / default to find the underlying type.
  let inner: ZodTypeAny = schema;
  while (true) {
    const td = (inner as unknown as { _def?: { typeName?: string; innerType?: ZodTypeAny } })._def;
    if (
      td?.typeName === "ZodOptional" ||
      td?.typeName === "ZodNullable" ||
      td?.typeName === "ZodDefault" ||
      td?.typeName === "ZodEffects"
    ) {
      if (td.innerType) {
        inner = td.innerType;
        continue;
      }
    }
    break;
  }
  const td = (inner as unknown as { _def?: { typeName?: string } })._def;
  switch (td?.typeName) {
    case "ZodString":  return "string";
    case "ZodNumber":  return "number";
    case "ZodBigInt":  return "number";
    case "ZodBoolean": return "boolean";
    case "ZodArray":   return "array";
    case "ZodObject":
    case "ZodRecord":
    case "ZodMap":     return "object";
    case "ZodEnum":    return "string";
    default:           return "object";
  }
}

function isLongInput(schema: ZodTypeAny): boolean {
  // Heuristic: any string with a min/max ≥ 200 or .describe() containing
  // "long" hints at a long-input field. Mostly cosmetic for UIs.
  const desc = schema.description ?? "";
  if (/multiline|long|paragraph|description|body/i.test(desc)) return true;
  return false;
}
