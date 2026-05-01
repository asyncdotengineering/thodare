/**
 * `defineWorkflowSpec` — declare a workflow's name + version + I/O schemas
 * WITHOUT the implementation.
 *
 * Why: the spec lives in a shared package that the API service can import
 * without bundling worker code. The worker imports the same spec and
 * provides the implementation via `wfkit.workflowFromSpec(spec, builderFn)`.
 *
 *     // packages/specs/src/index.ts (no runtime deps):
 *     export const SendEmailSpec = defineWorkflowSpec({
 *       name: "send-email",
 *       version: "1",
 *       input: z.object({ to: z.string() }),
 *       output: z.object({ delivered: z.boolean() }),
 *     });
 *
 *     // apps/worker:
 *     wfkit.workflowFromSpec(SendEmailSpec, (b) => b.step(...));
 *
 *     // apps/api (no worker code bundled):
 *     await wfkit.runSpec(SendEmailSpec, { to: "x@y" });
 *     //                              ^? input typed via z.infer<typeof spec.input>
 */

import type { z, ZodTypeAny } from "zod";

export interface WorkflowSpec<
  Input = unknown,
  Output = unknown,
  InputSchema extends ZodTypeAny | undefined = ZodTypeAny | undefined,
  OutputSchema extends ZodTypeAny | undefined = ZodTypeAny | undefined,
> {
  /** Logical workflow name. The runtime registers `${name}@${version}` to disambiguate versions. */
  readonly name: string;
  /** Stable version string. Bump it when changing the workflow's I/O contract. */
  readonly version: string;
  /** Optional Zod input schema; runSpec validates against it before creating a run. */
  readonly input: InputSchema;
  /** Optional Zod output schema. Used by webhook router and tooling for static checks. */
  readonly output: OutputSchema;
  /** Internal phantom carrying the inferred Input/Output types for type-only call sites. */
  readonly __types?: { input: Input; output: Output };
}

export interface DefineWorkflowSpecOptions<
  InputSchema extends ZodTypeAny | undefined = undefined,
  OutputSchema extends ZodTypeAny | undefined = undefined,
> {
  name: string;
  version: string;
  input?: InputSchema;
  output?: OutputSchema;
}

/**
 * Define a workflow spec. Returns a frozen `WorkflowSpec` whose `name` /
 * `version` / `input` / `output` are all read-only.
 *
 * Type inference: if you pass `input: z.object({...})`, callers get
 * `z.infer<...>` typing on `runSpec(spec, input)`. Same for output.
 */
export function defineWorkflowSpec<
  InputSchema extends ZodTypeAny | undefined = undefined,
  OutputSchema extends ZodTypeAny | undefined = undefined,
>(
  opts: DefineWorkflowSpecOptions<InputSchema, OutputSchema>,
): WorkflowSpec<
  InputSchema extends ZodTypeAny ? z.infer<InputSchema> : unknown,
  OutputSchema extends ZodTypeAny ? z.infer<OutputSchema> : unknown,
  InputSchema,
  OutputSchema
> {
  if (!opts.name) throw new Error("defineWorkflowSpec: name is required");
  if (!opts.version) throw new Error("defineWorkflowSpec: version is required");
  return Object.freeze({
    name: opts.name,
    version: opts.version,
    input: opts.input as InputSchema,
    output: opts.output as OutputSchema,
  }) as WorkflowSpec<
    InputSchema extends ZodTypeAny ? z.infer<InputSchema> : unknown,
    OutputSchema extends ZodTypeAny ? z.infer<OutputSchema> : unknown,
    InputSchema,
    OutputSchema
  >;
}

/** Compose a workflow registration name from a spec. Used by the runtime. */
export function specRuntimeName(spec: WorkflowSpec): string {
  return `${spec.name}@${spec.version}`;
}
