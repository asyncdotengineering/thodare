import type { ThodareLogger } from "@thodare/backend";

export function createLogger(): ThodareLogger {
  const noopFn = () => {};
  return { debug: noopFn, info: noopFn, warn: noopFn, error: noopFn };
}
