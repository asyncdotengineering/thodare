import type { Run, Step } from "@thodare/backend";

export function mapOwRunStatus(s: string): Run["status"] {
  if (s === "pending") return "pending";
  if (s === "running" || s === "sleeping") return "running";
  if (s === "completed" || s === "succeeded") return "completed";
  if (s === "failed") return "failed";
  if (s === "canceled") return "canceled";
  return "pending";
}

export function mapOwStepStatus(s: string): Step["status"] {
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  return "pending";
}

export function mapRunStatusToOw(s: Run["status"]): string {
  if (s === "pending") return "pending";
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "canceled") return "canceled";
  return "pending";
}
