/**
 * Visibility markers attached to Zod schemas as brands. The marker is read
 * at registration time to populate the underlying Tool's `params[k].visibility`.
 *
 * Why brand the schema vs. a separate metadata object: this keeps the
 * single-source-of-truth for the param (its Zod schema) co-located with
 * its security policy (the visibility flag). You can't accidentally
 * forget the visibility — it's part of the schema definition.
 *
 * Borrowed from Zod's own .describe() / .brand() pattern.
 */

import type { ZodTypeAny } from "zod";
import type { ParamVisibility } from "../types.js";

const VISIBILITY = Symbol.for("@thodare/engine.visibility");

/** Internal: read the visibility marker off a Zod schema, if any. Defaults to 'user-or-llm'. */
export function readVisibility(schema: ZodTypeAny): ParamVisibility {
  const v = (schema as unknown as Record<symbol, unknown>)[VISIBILITY];
  if (v === "hidden" || v === "user-only" || v === "user-or-llm") return v;
  return "user-or-llm";
}

function brand<T extends ZodTypeAny>(schema: T, vis: ParamVisibility): T {
  // Set on the schema instance so .parse() / .infer<> still work normally.
  (schema as unknown as Record<symbol, unknown>)[VISIBILITY] = vis;
  return schema;
}

/**
 * Mark a param as system-injected. The LLM cannot land it in workflow JSON;
 * applyOps strips it. Use for OAuth tokens, API keys, anything sensitive.
 *
 *     accessToken: hidden(z.string()),
 */
export function hidden<T extends ZodTypeAny>(schema: T): T {
  return brand(schema, "hidden");
}

/**
 * Mark a param as user-form only (not LLM-fillable). Use for auth method
 * choices, environment selection, anything where you want a human in the loop.
 *
 *     authMethod: userOnly(z.enum(["oauth", "apikey"])),
 */
export function userOnly<T extends ZodTypeAny>(schema: T): T {
  return brand(schema, "user-only");
}

/** The default — explicit if you want it. Mostly for readability. */
export function userOrLlm<T extends ZodTypeAny>(schema: T): T {
  return brand(schema, "user-or-llm");
}
