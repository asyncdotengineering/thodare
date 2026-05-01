import type { Block } from "../types.js";

export class BlockRegistry {
  private blocks = new Map<string, Block>();

  register(block: Block): void {
    if (this.blocks.has(block.type)) throw new Error(`Block already registered: ${block.type}`);
    this.blocks.set(block.type, block);
  }

  get(type: string): Block | undefined {
    return this.blocks.get(type);
  }

  has(type: string): boolean {
    return this.blocks.has(type);
  }

  list(): Block[] {
    return [...this.blocks.values()];
  }

  /** Tiny catalog the LLM gets in its system prompt: type + one-line description. */
  catalog(): Array<{ type: string; name: string; description: string; category: string; kind: string }> {
    return this.list().map((b) => ({
      type: b.type,
      name: b.name,
      description: b.description,
      category: b.category,
      kind: b.kind,
    }));
  }
}
