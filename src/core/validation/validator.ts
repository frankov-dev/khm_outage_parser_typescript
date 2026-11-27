import { calculateOffMinutes } from "../normalizing/interval-normalizer";
import { diffCalendarDays } from "../time/kyiv-clock";
import { ALL_SUBQUEUES, type DateIso, type DaySchedule } from "../types/domain";
import { areQueuesEqual, hasAnyOutages } from "../versioning/schedule-differ";
import { dayScheduleSchema } from "./schemas";

export type ValidationFailureCode =
  | "SCHEMA_INVALID"
  | "DATE_OUT_OF_RANGE"
  | "INTERVAL_ORDER_OR_OVERLAP"
  | "OFF_MINUTES_MISMATCH"
  | "STATUS_MISMATCH"
  | "REVISION_INVARIANT_VIOLATION"
  | "SUSPICIOUS_ZEROING";

export type ValidationResult =
  | { ok: true; day: DaySchedule }
  | { ok: false; code: ValidationFailureCode; message: string };

export interface ValidateOptions {
  todayDate: DateIso;
  existingDay?: DaySchedule | null | undefined;
  hasExplicitCancellation?: boolean | undefined;
  maxPastDays?: number | undefined;
  maxFutureDays?: number | undefined;
}

function fail(code: ValidationFailureCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

/** Structural (Zod) + domain-invariant validation of a day before it may be published. */
export function validateDaySchedule(candidate: DaySchedule, options: ValidateOptions): ValidationResult {
  const parsed = dayScheduleSchema.safeParse(candidate);
  if (!parsed.success) {
    return fail("SCHEMA_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  const maxPast = options.maxPastDays ?? 30;
  const maxFuture = options.maxFutureDays ?? 7;
  const delta = diffCalendarDays(candidate.date, options.todayDate);
  if (delta < -maxPast || delta > maxFuture) {
    return fail("DATE_OUT_OF_RANGE", `${candidate.date} is ${delta} days from ${options.todayDate}`);
  }

  for (const q of ALL_SUBQUEUES) {
    const { intervals, offMinutes } = candidate.queues[q];
    for (let i = 1; i < intervals.length; i++) {
      const prev = intervals[i - 1];
      const curr = intervals[i];
      if (prev && curr && prev[1] >= curr[0]) {
        return fail("INTERVAL_ORDER_OR_OVERLAP", `Queue ${q} has unsorted, overlapping or unmerged intervals`);
      }
    }
    if (offMinutes !== calculateOffMinutes(intervals)) {
      return fail("OFF_MINUTES_MISMATCH", `Queue ${q} offMinutes ${offMinutes} does not match intervals`);
    }
  }

  const expectedStatus = hasAnyOutages(candidate.queues) ? "ACTIVE" : "NO_OUTAGES";
  if (candidate.status !== expectedStatus) {
    return fail("STATUS_MISMATCH", `Status ${candidate.status} but queues imply ${expectedStatus}`);
  }

  const { revisions } = candidate;
  if (revisions.length !== candidate.revisionCount) {
    return fail("REVISION_INVARIANT_VIOLATION", "revisionCount does not match revisions length");
  }
  for (let i = 0; i < revisions.length; i++) {
    const rev = revisions[i];
    if (!rev || rev.revNo !== i + 1) {
      return fail("REVISION_INVARIANT_VIOLATION", "Revisions must be numbered 1..N");
    }
    const prev = revisions[i - 1];
    if (prev && areQueuesEqual(prev.fullQueues, rev.fullQueues)) {
      return fail("REVISION_INVARIANT_VIOLATION", `Revision ${rev.revNo} duplicates the previous one`);
    }
  }
  const lastRevision = revisions[revisions.length - 1];
  if (!lastRevision || !areQueuesEqual(lastRevision.fullQueues, candidate.queues)) {
    return fail("REVISION_INVARIANT_VIOLATION", "Last revision must equal the active queues");
  }

  if (
    options.existingDay?.status === "ACTIVE" &&
    candidate.status === "NO_OUTAGES" &&
    options.hasExplicitCancellation !== true
  ) {
    return fail(
      "SUSPICIOUS_ZEROING",
      `Refusing to replace an active schedule for ${candidate.date} with an empty one without an explicit cancellation`,
    );
  }

  return { ok: true, day: candidate };
}
