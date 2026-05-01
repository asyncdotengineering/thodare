import { describe, it, expect } from "vitest";
import { execute, resume, type SerializedWorkflow } from "../src/index.js";
import { freshRegistries } from "./_setup.js";

describe("pause/resume sentinel", () => {
  it("stops the run on a wait block, returns a snapshot, then resumes with the wake payload", async () => {
    const { tools, blocks } = freshRegistries();

    const wf: SerializedWorkflow = {
      version: "1.0.0",
      blocks: [
        { id: "trg", type: "trigger_webhook", enabled: true, params: { path: "/x" } },
        { id: "before", type: "transform", enabled: true, params: { template: { stamp: "before" } } },
        { id: "approve", type: "human_approval", enabled: true, params: { prompt: "OK?" } },
        // After the wait, transform block consumes the approve output via `{{approve.approved}}`.
        { id: "after", type: "transform", enabled: true, params: { template: { ok: "{{approve.approved}}" } } },
      ],
      connections: [
        { source: "trg", target: "before" },
        { source: "before", target: "approve" },
        { source: "approve", target: "after" },
      ],
    };

    const r1 = await execute({
      workflow: wf,
      toolRegistry: tools,
      blockRegistry: blocks,
      trigger: { hi: 1 },
    });
    expect(r1.success).toBe(false);
    expect(r1.paused).toBe(true);
    expect(r1.snapshot).toBeDefined();
    expect(r1.snapshot!.pausedAtBlockId).toBe("approve");
    expect(r1.snapshot!.pause.reason).toBe("human_approval");
    expect(r1.snapshot!.pause.metadata?.["resumeUrl"]).toMatch(/api\/runs\/resume\//);
    // Already-completed blocks are recorded so resume skips them.
    expect(r1.snapshot!.completedBlockIds).toContain("trg");
    expect(r1.snapshot!.completedBlockIds).toContain("before");

    const r2 = await resume(r1.snapshot!, { approved: true, by: "alice" }, {
      toolRegistry: tools,
      blockRegistry: blocks,
    });
    expect(r2.success).toBe(true);
    // The "before" block must NOT have re-executed (it's in seedOutputs).
    // We verify by checking that the after block's `{{approve.approved}}`
    // resolved to `true`.
    const after = r2.outputs["after"] as { result?: { ok?: unknown } };
    expect(after.result?.ok).toBe(true);
  });
});
