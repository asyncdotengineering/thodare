/**
 * Cron / scheduled-trigger support.
 *
 * Schedule-dispatch pattern:
 *   - Schedules live in the caller's data store (we ship an in-memory
 *     reference impl; production wires Postgres rows).
 *   - A periodic dispatcher tick claims due schedules and spawns the target
 *     workflow with `runWorkflow({ idempotencyKey })`. Idempotency on the
 *     `(scheduleId, cutoffMinute)` tuple guarantees we never double-fire
 *     even if the cron fires twice.
 *   - `cron2quartz`-style minute resolution is enough for 99% of agent-ops
 *     use cases. Sub-second cadences are out of scope (use `wait_duration`
 *     blocks instead).
 *
 * Anti-pattern explicitly avoided: NO new "scheduled job" first-class
 * concept. wfkit conv 08 #12 stands: a scheduled email is a one-block
 * workflow that pauses immediately. Same primitive, one set of bugs.
 */

import { randomUUID } from "node:crypto";

export interface ScheduleSpec {
  /** Stable id used for idempotency key derivation. */
  id: string;
  /** Minute-resolution cron expression. Subset: `m h d M w` with `*`, step (asterisk-slash-N), comma lists, and ranges. */
  cron: string;
  /** Workflow to run on each tick. Receives the schedule's `payload` as input. */
  workflowName: string;
  payload: unknown;
  /** Optional: hard end date (ISO). After this, the dispatcher stops firing. */
  endAt?: string;
  /** Optional: timezone (IANA). Defaults to UTC. */
  timezone?: string;
}

export interface ScheduleStore {
  /** All schedules currently active. */
  list(): Promise<ScheduleSpec[]>;
  /**
   * Atomic claim: returns true exactly once for a given
   * `(scheduleId, cutoffMinuteIso)`. Subsequent calls return false. This is
   * the single concurrency invariant the dispatcher relies on — even if two
   * dispatchOnce calls race for the same cutoff, only the winner gets to
   * fire the workflow.
   *
   * Postgres impl: `INSERT ... ON CONFLICT (schedule_id, cutoff_minute)
   * DO NOTHING RETURNING 1` — true if the row was inserted, false if it
   * already existed.
   */
  tryClaim(scheduleId: string, cutoffMinuteIso: string): Promise<boolean>;
}

/** Reference in-memory impl. Production should wire Postgres or Redis. */
export class InMemoryScheduleStore implements ScheduleStore {
  private schedules: ScheduleSpec[] = [];
  private fired = new Set<string>();

  add(schedule: ScheduleSpec): void {
    this.schedules.push(schedule);
  }
  remove(id: string): void {
    this.schedules = this.schedules.filter((s) => s.id !== id);
  }
  async list(): Promise<ScheduleSpec[]> {
    return [...this.schedules];
  }
  async tryClaim(scheduleId: string, cutoffMinuteIso: string): Promise<boolean> {
    // Synchronous Set add IS atomic in the single-threaded JS event loop —
    // any other dispatchOnce in this process sees the result before its own
    // claim attempt runs. For a multi-process Postgres deployment, replace
    // with `INSERT ... ON CONFLICT DO NOTHING`.
    const key = `${scheduleId}@${cutoffMinuteIso}`;
    if (this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }
}

/* ──────────────  Cron evaluation (minute resolution)  ────────────── */

/** Parse a single cron field with star, step (asterisk-slash-N), comma-separated lists, and ranges. */
function parseField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    const [base, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (Number.isNaN(step) || step <= 0) throw new Error(`bad cron step: ${part}`);
    if (base === "*") {
      for (let i = min; i <= max; i += step) out.add(i);
      continue;
    }
    if (base!.includes("-")) {
      const [a, b] = base!.split("-").map(Number);
      if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b))
        throw new Error(`bad cron range: ${part}`);
      for (let i = a; i <= b; i += step) out.add(i);
      continue;
    }
    const v = Number(base);
    if (Number.isNaN(v)) throw new Error(`bad cron value: ${part}`);
    out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

/** Parse `m h d M w` (standard 5-field cron). */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields: ${expr}`);
  const [m, h, d, M, w] = fields;
  return {
    minute: new Set(parseField(m!, 0, 59)),
    hour: new Set(parseField(h!, 0, 23)),
    dayOfMonth: new Set(parseField(d!, 1, 31)),
    month: new Set(parseField(M!, 1, 12)),
    dayOfWeek: new Set(parseField(w!, 0, 6)),
  };
}

export function isCronMatch(parsed: ParsedCron, when: Date): boolean {
  return (
    parsed.minute.has(when.getUTCMinutes()) &&
    parsed.hour.has(when.getUTCHours()) &&
    parsed.dayOfMonth.has(when.getUTCDate()) &&
    parsed.month.has(when.getUTCMonth() + 1) &&
    parsed.dayOfWeek.has(when.getUTCDay())
  );
}

/* ──────────────  Dispatcher  ────────────── */

export interface DispatchTickInput {
  /** The minute boundary this tick claims (truncated to :00 seconds). */
  cutoffMinute: Date;
}

export interface DispatchTickOutput {
  fired: Array<{ scheduleId: string; runId: string }>;
  /**
   * Schedules whose `runWorkflow` threw. Each entry pinpoints which
   * schedule failed so the dispatcher can keep going for the rest. The
   * caller is responsible for retry / alerting; the schedule itself is
   * already claimed for this minute, so a future tick won't redo it
   * (you have to clear the claim or wait for the next match).
   */
  failed: Array<{ scheduleId: string; error: string }>;
  skippedAlreadyFired: number;
  skippedNotMatching: number;
  skippedExpired: number;
}

export interface CronDispatcherOptions {
  store: ScheduleStore;
  /** A function that runs the named workflow with the given input + idempotency key. */
  runWorkflow: (
    workflowName: string,
    input: unknown,
    options: { idempotencyKey: string },
  ) => Promise<{ workflowRun: { id: string } }>;
  /** Tick interval; defaults to 60_000 (one minute). */
  tickIntervalMs?: number;
  /** Override clock for tests. */
  clock?: () => Date;
  /**
   * Whether the loop fires one tick immediately on startup before its first
   * `tickIntervalMs` wait. Production: true (catch up due schedules on
   * boot). Tests: false (so test-driven `tickNow()` is the only firing).
   * Default: true.
   */
  tickOnStart?: boolean;
}

/**
 * Run the dispatcher tick once for the given cutoff minute. Production
 * code should call this from a cron / setInterval at a 1-minute cadence.
 *
 * Idempotency: dedupes on `(scheduleId, cutoffMinute)` via the store.
 */
export async function dispatchOnce(
  opts: CronDispatcherOptions,
  cutoffMinute: Date,
): Promise<DispatchTickOutput> {
  const out: DispatchTickOutput = {
    fired: [],
    failed: [],
    skippedAlreadyFired: 0,
    skippedNotMatching: 0,
    skippedExpired: 0,
  };
  // Truncate cutoff minute to :00 seconds so the idempotency key is stable.
  const cutoff = new Date(
    Date.UTC(
      cutoffMinute.getUTCFullYear(),
      cutoffMinute.getUTCMonth(),
      cutoffMinute.getUTCDate(),
      cutoffMinute.getUTCHours(),
      cutoffMinute.getUTCMinutes(),
      0,
      0,
    ),
  );
  const cutoffIso = cutoff.toISOString();
  const schedules = await opts.store.list();
  for (const schedule of schedules) {
    // End-of-schedule check.
    if (schedule.endAt && new Date(schedule.endAt).getTime() < cutoff.getTime()) {
      out.skippedExpired += 1;
      continue;
    }
    // Cron-match check.
    let parsed: ParsedCron;
    try {
      parsed = parseCron(schedule.cron);
    } catch {
      out.skippedNotMatching += 1;
      continue;
    }
    if (!isCronMatch(parsed, cutoff)) {
      out.skippedNotMatching += 1;
      continue;
    }
    // Atomic claim — single-flighted across concurrent dispatchOnce calls.
    const claimed = await opts.store.tryClaim(schedule.id, cutoffIso);
    if (!claimed) {
      out.skippedAlreadyFired += 1;
      continue;
    }
    // FIRE. Each call wrapped so a single throwing schedule doesn't
    // poison the rest of the tick. Belt-and-suspenders idempotency: pass
    // the key to openworkflow as well, so the runtime dedupes too.
    const idempotencyKey = `cron:${schedule.id}:${cutoffIso}`;
    try {
      const handle = await opts.runWorkflow(schedule.workflowName, schedule.payload, {
        idempotencyKey,
      });
      out.fired.push({ scheduleId: schedule.id, runId: handle.workflowRun.id });
    } catch (e: unknown) {
      out.failed.push({
        scheduleId: schedule.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/**
 * Start a dispatcher that ticks every `tickIntervalMs` (default 60s). Returns
 * a `stop()` function. Each tick is single-flighted; if a tick takes longer
 * than `tickIntervalMs`, the next one is skipped (fires at +2 intervals).
 */
export function startCronDispatcher(opts: CronDispatcherOptions): {
  stop: () => Promise<void>;
  /** Force a tick immediately; useful for tests. Returns the result. */
  tickNow: (when?: Date) => Promise<DispatchTickOutput>;
} {
  const tickMs = opts.tickIntervalMs ?? 60_000;
  const clock = opts.clock ?? (() => new Date());
  const tickOnStart = opts.tickOnStart ?? true;
  let stopped = false;
  let inFlight = false;

  const tickInLoop = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await dispatchOnce(opts, clock());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[cron] dispatchOnce failed:", e);
    } finally {
      inFlight = false;
    }
  };

  const loop = async (): Promise<void> => {
    if (tickOnStart) await tickInLoop();
    while (!stopped) {
      await new Promise((r) => setTimeout(r, tickMs));
      if (stopped) break;
      await tickInLoop();
    }
  };
  loop().catch(() => {});

  return {
    stop: async () => {
      stopped = true;
    },
    tickNow: (when?: Date) => dispatchOnce(opts, when ?? clock()),
  };
}

/* ──────────────  Conventional helpers  ────────────── */

export function newScheduleId(): string {
  return `sch_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
