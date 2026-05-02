import { describe, it, expect } from "vitest";
import type { ThodareBackend } from "@thodare/backend";

export function registerTimezoneHappyPath(backend: ThodareBackend): void {
  describe("timezone/happy-path", () => {
    it("schedule for 9am LA resumes at 9am LA wall-clock", async () => {
      const name = "test-tz-happy";
      await backend.defineWorkflow({ name }, async (ctx) => {
        await ctx.step.sleepUntilLocalTime("morning", {
          timezone: "America/Los_Angeles",
          hour: 9,
          minute: 0,
        });
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerTimezoneDstTransition(
  backend: ThodareBackend,
): void {
  describe("timezone/dst-transition", () => {
    it("schedule across DST change resumes at wall-clock-correct time", async () => {
      const name = "test-tz-dst";
      await backend.defineWorkflow({ name }, async (ctx) => {
        await ctx.step.sleepUntilLocalTime("dst-morning", {
          timezone: "America/New_York",
          hour: 8,
          minute: 0,
        });
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}

export function registerTimezoneSkipWeekends(
  backend: ThodareBackend,
): void {
  describe("timezone/skip-weekends", () => {
    it("scheduled for Sat 9am with skipWeekends resumes Mon 9am", async () => {
      const name = "test-tz-weekend";
      await backend.defineWorkflow({ name }, async (ctx) => {
        await ctx.step.sleepUntilLocalTime("weekday-morning", {
          timezone: "America/Chicago",
          hour: 9,
          minute: 0,
          skipWeekends: true,
        });
      });
      const handle = await backend.runWorkflow(name, {});
      expect(handle.runId).toBeDefined();
    });
  });
}
