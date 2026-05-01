/**
 * Reference resolution. Sim/wfkit's chain-of-responsibility pattern:
 * an array of Resolvers, each implementing canResolve(ref) → bool.
 *
 * Reference syntax:
 *   {{ trigger.body.email }}      → trigger payload
 *   {{ env.SLACK_TOKEN }}         → env vars
 *   {{ vars.tenant_id }}          → workflow-level variables
 *   {{ <blockNameOrId>.foo.bar }} → another block's output
 */

export interface ResolutionContext {
  blockOutputs: Record<string, unknown>;
  trigger: unknown;
  env: Record<string, string>;
  workflowVars: Record<string, unknown>;
  blockIdsByName: Map<string, string>;
  currentBlockId?: string;
}

export interface Resolver {
  canResolve(ref: string): boolean;
  resolve(ref: string, ctx: ResolutionContext): unknown;
}

export function navigatePath(obj: unknown, path: string[]): unknown {
  let cur: any = obj;
  for (const part of path) {
    if (cur == null) return undefined;
    if (/^\d+$/.test(part) && Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = cur[part];
    else return undefined;
  }
  return cur;
}

export class TriggerResolver implements Resolver {
  canResolve(ref: string): boolean {
    return ref === "trigger" || ref.startsWith("trigger.");
  }
  resolve(ref: string, ctx: ResolutionContext): unknown {
    if (ref === "trigger") return ctx.trigger;
    return navigatePath(ctx.trigger, ref.slice("trigger.".length).split("."));
  }
}

export class EnvResolver implements Resolver {
  canResolve(ref: string): boolean {
    return ref.startsWith("env.");
  }
  resolve(ref: string, ctx: ResolutionContext): unknown {
    return ctx.env[ref.slice("env.".length)];
  }
}

export class VarsResolver implements Resolver {
  canResolve(ref: string): boolean {
    return ref.startsWith("vars.");
  }
  resolve(ref: string, ctx: ResolutionContext): unknown {
    return navigatePath(ctx.workflowVars, ref.slice("vars.".length).split("."));
  }
}

export class BlockResolver implements Resolver {
  canResolve(_ref: string): boolean {
    return true;
  }
  resolve(ref: string, ctx: ResolutionContext): unknown {
    const [head, ...rest] = ref.split(".");
    const id =
      ctx.blockOutputs[head!] !== undefined
        ? head!
        : ctx.blockIdsByName.get(head!);
    if (!id || ctx.blockOutputs[id] === undefined) return undefined;
    return navigatePath(ctx.blockOutputs[id], rest);
  }
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export class VariableResolver {
  constructor(private resolvers: Resolver[]) {}

  resolveValue(value: unknown, ctx: ResolutionContext): unknown {
    if (typeof value === "string") return this.resolveString(value, ctx);
    if (Array.isArray(value)) return value.map((v) => this.resolveValue(v, ctx));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.resolveValue(v, ctx);
      return out;
    }
    return value;
  }

  private resolveString(s: string, ctx: ResolutionContext): unknown {
    const matches = [...s.matchAll(TEMPLATE)];
    if (matches.length === 0) return s;
    if (matches.length === 1 && matches[0]![0] === s.trim()) {
      return this.resolveSingle(matches[0]![1]!.trim(), ctx);
    }
    return s.replace(TEMPLATE, (_, ref) => {
      const v = this.resolveSingle((ref as string).trim(), ctx);
      if (v == null) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    });
  }

  private resolveSingle(ref: string, ctx: ResolutionContext): unknown {
    for (const r of this.resolvers) {
      if (r.canResolve(ref)) return r.resolve(ref, ctx);
    }
    return undefined;
  }

  static extractRefs(value: unknown): string[] {
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        for (const m of v.matchAll(TEMPLATE)) refs.push(m[1]!.trim());
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === "object") {
        Object.values(v).forEach(walk);
      }
    };
    walk(value);
    return refs;
  }
}
