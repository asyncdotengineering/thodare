import type { DispatcherMetadata } from "@cloudflare/dynamic-workflows";

// Required Worker bindings for the dispatcher + adapter.
// These names are convention, not configuration: the user must declare them
// with these exact identifiers in their wrangler.jsonc.
export interface CFEnv {
  WORKFLOWS: Workflow;
  THODARE_DB: D1Database;
}

export interface CloudflareDispatcherOptions {
  // Override only if the user genuinely cannot use the convention name
  // (rare). Defaults to "THODARE_DB".
  d1BindingName?: string;
}

export interface ThodareMetadata {
  readonly workflowId: string;
  readonly organizationId: string;
  readonly workflowVersion: string;
  // Index signature so type predicate works against DispatcherMetadata
  // (Record<string, unknown>). Keys above are load-bearing for routing;
  // the upstream library forwards any extras verbatim per its contract.
  readonly [key: string]: unknown;
}

export function isThodareMetadata(
  m: DispatcherMetadata,
): m is ThodareMetadata {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as Record<string, unknown>)["workflowId"] === "string" &&
    typeof (m as Record<string, unknown>)["organizationId"] === "string" &&
    typeof (m as Record<string, unknown>)["workflowVersion"] === "string"
  );
}
