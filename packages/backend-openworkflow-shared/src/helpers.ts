import { randomUUID } from "node:crypto";

export function makeId(): string {
  return randomUUID();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function notImplemented(method: string): never {
  throw new Error(`${method}: not_implemented`);
}

export function resolveSleepDuration(
  duration: string | number | Date,
): string {
  if (typeof duration === "string") return duration;
  if (typeof duration === "number") return `${duration}ms`;
  const ms = duration.getTime() - Date.now();
  if (ms <= 0) return "0ms";
  return `${ms}ms`;
}

export function resolveErrorMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>)["message"] === "string"
  ) {
    return (error as Record<string, unknown>)["message"] as string;
  }
  return JSON.stringify(error);
}
