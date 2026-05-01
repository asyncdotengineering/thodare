import type { SerializedWorkflow, SerializedConnection } from "../types.js";

export interface DAGNode {
  id: string;
  type: string;
  incoming: Set<string>;
  outgoing: Map<string, SerializedConnection>;
}

export interface DAG {
  nodes: Map<string, DAGNode>;
  entrypoints: string[];
}

export function buildDAG(wf: SerializedWorkflow): DAG {
  const nodes = new Map<string, DAGNode>();

  for (const block of wf.blocks) {
    if (block.enabled === false) continue;
    nodes.set(block.id, {
      id: block.id,
      type: block.type,
      incoming: new Set(),
      outgoing: new Map(),
    });
  }

  for (const conn of wf.connections) {
    const src = nodes.get(conn.source);
    const tgt = nodes.get(conn.target);
    if (!src || !tgt) continue;
    src.outgoing.set(conn.target, conn);
    tgt.incoming.add(conn.source);
  }

  const entrypoints = [...nodes.values()].filter((n) => n.incoming.size === 0).map((n) => n.id);

  if (hasCycle(nodes)) throw new Error("Workflow contains a cycle");

  return { nodes, entrypoints };
}

function hasCycle(nodes: Map<string, DAGNode>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes.keys()) color.set(id, WHITE);
  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    const n = nodes.get(id);
    if (!n) return false;
    for (const target of n.outgoing.keys()) {
      const c = color.get(target) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(target)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const id of nodes.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE && visit(id)) return true;
  }
  return false;
}

/** Kahn's algorithm. Returns block IDs in execution order. */
export function topoSort(dag: DAG): string[] {
  const inDeg = new Map<string, number>();
  for (const [id, n] of dag.nodes) inDeg.set(id, n.incoming.size);
  const ready = [...dag.entrypoints];
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    const node = dag.nodes.get(id);
    if (!node) continue;
    for (const target of node.outgoing.keys()) {
      const next = (inDeg.get(target) ?? 0) - 1;
      inDeg.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (order.length !== dag.nodes.size) {
    throw new Error("Topological sort failed");
  }
  return order;
}
