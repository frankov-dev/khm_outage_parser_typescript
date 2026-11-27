import {
  ALL_SUBQUEUES,
  type DateIso,
  type DaySchedule,
  type MinuteInterval,
  type QueuesMap,
  type SparseQueuesDiff,
  type SubqueueId,
} from "../types/domain";

export function areIntervalsEqual(
  a: readonly MinuteInterval[],
  b: readonly MinuteInterval[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((interval, i) => interval[0] === b[i]?.[0] && interval[1] === b[i]?.[1]);
}

export function areQueuesEqual(a: QueuesMap, b: QueuesMap): boolean {
  return ALL_SUBQUEUES.every((q) => areIntervalsEqual(a[q].intervals, b[q].intervals));
}

export function hasAnyOutages(queues: QueuesMap): boolean {
  return ALL_SUBQUEUES.some((q) => queues[q].offMinutes > 0);
}

/** Number of subqueues that have at least one outage interval. */
export function countActiveQueues(queues: QueuesMap): number {
  return ALL_SUBQUEUES.filter((q) => queues[q].intervals.length > 0).length;
}

/**
 * Sparse diff between two revisions. For the first revision (`prev === null`) every queue is
 * included in `diff`, while `changedQueues` stays empty (there is nothing to compare against).
 */
export function computeSparseQueuesDiff(
  prev: QueuesMap | null,
  next: QueuesMap,
): { diff: SparseQueuesDiff; changedQueues: SubqueueId[] } {
  const diff: SparseQueuesDiff = {};
  const changedQueues: SubqueueId[] = [];
  for (const q of ALL_SUBQUEUES) {
    if (prev === null) {
      diff[q] = { intervals: next[q].intervals.map((i): MinuteInterval => [i[0], i[1]]), offMinutes: next[q].offMinutes };
    } else if (!areIntervalsEqual(prev[q].intervals, next[q].intervals)) {
      diff[q] = { intervals: next[q].intervals.map((i): MinuteInterval => [i[0], i[1]]), offMinutes: next[q].offMinutes };
      changedQueues.push(q);
    }
  }
  return { diff, changedQueues };
}

/** Headline of an operational message normalised for matching across minor edits. */
export function normalizeMessageKey(message: string | null): string | null {
  if (!message) return null;
  const first = message
    .split("\n")
    .map((line) => line.replace(/[\u00A0\s]+/g, " ").trim())
    .find((line) => line.length > 0);
  if (!first) return null;
  return first.toLowerCase().replace(/[.:;]+$/, "");
}

const ENCODER = new TextEncoder();

/** First 16 lowercase hex characters of the SHA-256 digest (Web Crypto, no dependencies). */
export async function sha256Hex16(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(input));
  let hex = "";
  for (const byte of new Uint8Array(digest).subarray(0, 8)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function canonicalQueues(queues: QueuesMap): MinuteInterval[][] {
  return ALL_SUBQUEUES.map((q) => queues[q].intervals.map((i): MinuteInterval => [i[0], i[1]]));
}

export function computeDayContentHash(
  day: Pick<DaySchedule, "date" | "status" | "operationalMessage" | "queues" | "revisionCount">,
): Promise<string> {
  return sha256Hex16(
    JSON.stringify([
      day.date,
      day.status,
      day.operationalMessage,
      canonicalQueues(day.queues),
      day.revisionCount,
    ]),
  );
}

export function computeDataHash(days: readonly DaySchedule[]): Promise<string> {
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  return sha256Hex16(
    JSON.stringify(
      sorted.map((d) => [d.date, d.status, d.operationalMessage, d.revisionCount, d.contentHash]),
    ),
  );
}

/** Includes today/tomorrow so clients also notice the midnight rollover (fixes legacy hash desync). */
export function computeStateHash(
  dataHash: string,
  todayDate: DateIso,
  tomorrowDate: DateIso,
): Promise<string> {
  return sha256Hex16(`${dataHash}|${todayDate}|${tomorrowDate}`);
}
