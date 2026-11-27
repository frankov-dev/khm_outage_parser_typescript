import type { OperationalChange } from "../parsing/changes-parser";
import {
  ALL_SUBQUEUES,
  type MinuteInterval,
  type QueuesMap,
  type SubqueueId,
} from "../types/domain";

type MutableInterval = [number, number];

export function intervalsOverlap(a: MinuteInterval, b: MinuteInterval): boolean {
  return !(a[1] <= b[0] || b[1] <= a[0]);
}

function isValid(i: MinuteInterval): boolean {
  return Number.isInteger(i[0]) && Number.isInteger(i[1]) && i[0] >= 0 && i[0] < i[1] && i[1] <= 1440;
}

/** Filters invalid intervals, sorts, and merges overlapping or contiguous ones. */
export function mergeOverlappingIntervals(intervals: readonly MinuteInterval[]): MinuteInterval[] {
  const sorted = intervals
    .filter(isValid)
    .map((i): MutableInterval => [i[0], i[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: MutableInterval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current[0] <= last[1]) {
      if (current[1] > last[1]) last[1] = current[1];
    } else {
      merged.push([current[0], current[1]]);
    }
  }
  return merged;
}

/** Removes the `cancel` range from every interval (splitting, trimming or dropping as needed). */
export function subtractInterval(
  intervals: readonly MinuteInterval[],
  cancel: MinuteInterval,
): MinuteInterval[] {
  if (cancel[0] >= cancel[1]) return intervals.map((i): MinuteInterval => [i[0], i[1]]);
  const result: MinuteInterval[] = [];
  for (const i of intervals) {
    if (i[1] <= cancel[0] || i[0] >= cancel[1]) {
      result.push([i[0], i[1]]);
      continue;
    }
    if (i[0] < cancel[0]) result.push([i[0], cancel[0]]);
    if (cancel[1] < i[1]) result.push([cancel[1], i[1]]);
  }
  return result;
}

export function calculateOffMinutes(intervals: readonly MinuteInterval[]): number {
  let total = 0;
  for (const i of intervals) {
    if (isValid(i)) total += i[1] - i[0];
  }
  return total;
}

/**
 * Picks the interval whose start/end is nearest to `targetMin` without producing start >= end.
 * `direction` penalises candidates that would move the boundary the "wrong way".
 */
export function findNearestIntervalIndex(
  intervals: readonly MinuteInterval[],
  targetMin: number,
  field: "start" | "end",
  direction: "earlier" | "later" | "any",
): number | null {
  let bestIndex: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  intervals.forEach((interval, index) => {
    if (field === "start" && targetMin >= interval[1]) return;
    if (field === "end" && targetMin <= interval[0]) return;

    const current = field === "start" ? interval[0] : interval[1];
    let score = Math.abs(current - targetMin);
    if (direction === "earlier" && targetMin > current) score += 1000;
    if (direction === "later" && targetMin < current) score += 1000;

    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export interface AppliedChanges {
  intervalsByQueue: Map<SubqueueId, MinuteInterval[]>;
  explicitlyClearedQueues: Set<SubqueueId>;
  unappliedChanges: OperationalChange[];
}

export function applyOperationalChanges(
  baseByQueue: ReadonlyMap<SubqueueId, readonly MinuteInterval[]>,
  changes: readonly OperationalChange[],
): AppliedChanges {
  const changesByQueue = new Map<SubqueueId, OperationalChange[]>();
  for (const change of changes) {
    const list = changesByQueue.get(change.queue);
    if (list) list.push(change);
    else changesByQueue.set(change.queue, [change]);
  }

  const intervalsByQueue = new Map<SubqueueId, MinuteInterval[]>();
  const explicitlyClearedQueues = new Set<SubqueueId>();
  const unappliedChanges: OperationalChange[] = [];

  for (const queue of ALL_SUBQUEUES) {
    const base = baseByQueue.get(queue);
    const queueChanges = changesByQueue.get(queue);
    if (base === undefined && queueChanges === undefined) continue;

    if (queueChanges?.some((c) => c.kind === "cancel_all")) {
      intervalsByQueue.set(queue, []);
      explicitlyClearedQueues.add(queue);
      continue;
    }

    let current: MutableInterval[] = (base ?? [])
      .filter(isValid)
      .map((i): MutableInterval => [i[0], i[1]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    for (const change of queueChanges ?? []) {
      if (change.kind === "shift_start") {
        const idx = findNearestIntervalIndex(current, change.newStartMin, "start", change.direction);
        const target = idx === null ? undefined : current[idx];
        if (target) target[0] = change.newStartMin;
        else unappliedChanges.push(change);
      } else if (change.kind === "shift_end") {
        const idx = findNearestIntervalIndex(current, change.newEndMin, "end", change.direction);
        const target = idx === null ? undefined : current[idx];
        if (target) target[1] = change.newEndMin;
        else unappliedChanges.push(change);
      }
    }

    for (const change of queueChanges ?? []) {
      if (change.kind !== "replace_range") continue;
      const [s, e] = change.interval;
      const idx = current.findIndex((i) => intervalsOverlap(i, change.interval));
      const target = idx < 0 ? undefined : current[idx];
      if (!target) {
        current.push([s, e]);
      } else if (change.mode === "shift") {
        target[0] = s;
        target[1] = e;
      } else {
        target[0] = Math.min(target[0], s);
        target[1] = Math.max(target[1], e);
      }
    }

    for (const change of queueChanges ?? []) {
      if (change.kind === "extra") current.push([change.interval[0], change.interval[1]]);
    }

    for (const change of queueChanges ?? []) {
      if (change.kind === "cancel_range") current = subtractInterval(current, change.interval).map(
        (i): MutableInterval => [i[0], i[1]],
      );
    }

    intervalsByQueue.set(queue, mergeOverlappingIntervals(current));
  }

  return { intervalsByQueue, explicitlyClearedQueues, unappliedChanges };
}

/** Builds the canonical map with all 12 subqueues in order. */
export function buildQueuesMap(
  intervalsByQueue: ReadonlyMap<SubqueueId, readonly MinuteInterval[]>,
): QueuesMap {
  const entries = ALL_SUBQUEUES.map((queue) => {
    const merged = mergeOverlappingIntervals(intervalsByQueue.get(queue) ?? []);
    return [queue, { intervals: merged, offMinutes: calculateOffMinutes(merged) }] as const;
  });
  return Object.fromEntries(entries) as QueuesMap;
}
