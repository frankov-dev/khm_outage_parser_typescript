import {
  applyOperationalChanges,
  buildQueuesMap,
  calculateOffMinutes,
  intervalsOverlap,
  mergeOverlappingIntervals,
} from "../normalizing/interval-normalizer";
import type { ParsedBlock } from "../parsing/block-parser";
import {
  ALL_SUBQUEUES,
  type DateIso,
  type DayRevision,
  type DaySchedule,
  type MinuteInterval,
  type QueueSchedule,
  type QueuesMap,
  type SubqueueId,
  type TimestampIso,
} from "../types/domain";
import {
  areQueuesEqual,
  computeDayContentHash,
  computeSparseQueuesDiff,
  countActiveQueues,
  hasAnyOutages,
  normalizeMessageKey,
} from "./schedule-differ";

export type MergeDayResult =
  | { ok: true; day: DaySchedule; hasExplicitCancellation: boolean; changedFromExisting: boolean }
  | {
      ok: false;
      errorCode: "ORPHAN_DELTA_WITHOUT_BASE" | "NO_VALID_BLOCKS";
      errorMessage: string;
    };

function makeQueue(intervals: readonly MinuteInterval[]): QueueSchedule {
  const merged = mergeOverlappingIntervals(intervals);
  return { intervals: merged, offMinutes: calculateOffMinutes(merged) };
}

function cloneQueues(queues: QueuesMap): QueuesMap {
  return Object.fromEntries(
    ALL_SUBQUEUES.map((q) => [q, makeQueue(queues[q].intervals)] as const),
  ) as QueuesMap;
}

function toIntervalMap(queues: QueuesMap): Map<SubqueueId, MinuteInterval[]> {
  return new Map(ALL_SUBQUEUES.map((q) => [q, [...queues[q].intervals]] as const));
}

function hasIntervalEndingBefore(queues: QueuesMap, cutoff: number): boolean {
  return ALL_SUBQUEUES.some((q) => queues[q].intervals.some((i) => i[1] < cutoff));
}

function isChangeOnly(ver: ParsedBlock): boolean {
  return ver.queues === null && ver.unappliedChanges.length > 0;
}

function isTailOnly(ver: ParsedBlock): boolean {
  return (
    ver.effectiveFromMin !== null &&
    ver.effectiveFromMin > 0 &&
    ver.queues !== null &&
    !hasIntervalEndingBefore(ver.queues, ver.effectiveFromMin)
  );
}

function isPartialCancellation(ver: ParsedBlock): boolean {
  return (
    ver.explicitNoOutageQueues.length > 0 &&
    ver.mentionedQueues.length < ALL_SUBQUEUES.length &&
    !ver.isAdditive &&
    ver.effectiveFromMin === null
  );
}

function isPartialDelta(ver: ParsedBlock, activeBaseCount: number): boolean {
  return (
    ver.isAdditive ||
    (ver.mentionedQueues.length > 0 && ver.mentionedQueues.length < 6 && activeBaseCount >= 6)
  );
}

/**
 * Applies one published version on top of the previous state of the same day.
 * Returns `null` when the version cannot be applied (no base for a delta/shift).
 */
export function applyVersionToBase(
  baseQueues: QueuesMap | null,
  version: ParsedBlock,
): QueuesMap | null {
  // 1. Change-only block (shifts/cancellations without any base intervals of its own).
  if (version.queues === null) {
    if (version.unappliedChanges.length === 0 || baseQueues === null) return null;
    const baseMap = toIntervalMap(baseQueues);
    const applied = applyOperationalChanges(baseMap, version.unappliedChanges);
    const merged = new Map(baseMap);
    for (const [q, intervals] of applied.intervalsByQueue) merged.set(q, intervals);
    return buildQueuesMap(merged);
  }

  const versionQueues = version.queues;
  if (baseQueues === null) return cloneQueues(versionQueues);

  // 2. Partial explicit cancellation: only the cancelled queues are cleared.
  if (isPartialCancellation(version)) {
    const result = cloneQueues(baseQueues);
    for (const q of version.mentionedQueues) {
      if (version.explicitNoOutageQueues.includes(q)) {
        result[q] = makeQueue([]);
      } else if (versionQueues[q].intervals.length > 0) {
        result[q] = makeQueue(versionQueues[q].intervals);
      }
    }
    return result;
  }

  // 3. Additive / delta update: new intervals are added to the mentioned queues.
  const partialByCount =
    version.mentionedQueues.length > 0 &&
    version.mentionedQueues.length < 6 &&
    countActiveQueues(baseQueues) >= 6 &&
    version.explicitNoOutageQueues.length === 0;
  if (version.isAdditive || partialByCount) {
    const result = cloneQueues(baseQueues);
    for (const q of version.mentionedQueues) {
      result[q] = makeQueue([...baseQueues[q].intervals, ...versionQueues[q].intervals]);
    }
    return result;
  }

  // 4. Tail-only mid-day update ("оновлено з HH:MM"): keep the past, replace the future.
  if (isTailOnly(version) && version.effectiveFromMin !== null) {
    const cutoff = version.effectiveFromMin;
    const result = {} as QueuesMap;
    for (const q of ALL_SUBQUEUES) {
      const newIntervals = versionQueues[q].intervals;
      const past: MinuteInterval[] = [];
      for (const interval of baseQueues[q].intervals) {
        // Only an update that already starts before the cutoff supersedes this interval entirely.
        if (newIntervals.some((n) => n[0] < cutoff && intervalsOverlap(interval, n))) continue;
        if (interval[1] <= cutoff) past.push([interval[0], interval[1]]);
        else if (interval[0] < cutoff) past.push([interval[0], cutoff]);
      }
      result[q] = makeQueue([...past, ...newIntervals]);
    }
    return result;
  }

  // 5. Full-day replacement.
  return cloneQueues(versionQueues);
}

interface RevisionDraft {
  operationalMessage: string | null;
  fullQueues: QueuesMap;
  recordedAt: TimestampIso;
}

/** Collapses consecutive identical revisions, numbers them and computes sparse diffs. */
function finalizeRevisions(drafts: readonly RevisionDraft[]): DayRevision[] {
  const collapsed: RevisionDraft[] = [];
  for (const draft of drafts) {
    const last = collapsed[collapsed.length - 1];
    if (last && areQueuesEqual(last.fullQueues, draft.fullQueues)) {
      collapsed[collapsed.length - 1] = {
        operationalMessage: draft.operationalMessage ?? last.operationalMessage,
        fullQueues: last.fullQueues,
        recordedAt: last.recordedAt,
      };
    } else {
      collapsed.push(draft);
    }
  }
  return collapsed.map((draft, index) => ({
    revNo: index + 1,
    operationalMessage: draft.operationalMessage,
    changedQueues: computeSparseQueuesDiff(
      index > 0 ? (collapsed[index - 1]?.fullQueues ?? null) : null,
      draft.fullQueues,
    ).diff,
    fullQueues: draft.fullQueues,
    recordedAt: draft.recordedAt,
  }));
}

async function assembleDay(params: {
  date: DateIso;
  revisions: DayRevision[];
  sourceUrl: string;
  updatedAt: TimestampIso;
}): Promise<DaySchedule> {
  const { revisions } = params;
  const last = revisions[revisions.length - 1];
  const previous = revisions.length >= 2 ? revisions[revisions.length - 2] : undefined;
  if (!last) throw new RangeError("A day needs at least one revision");

  const changedQueues = previous
    ? computeSparseQueuesDiff(previous.fullQueues, last.fullQueues).changedQueues
    : [];
  const base = {
    date: params.date,
    status: hasAnyOutages(last.fullQueues) ? ("ACTIVE" as const) : ("NO_OUTAGES" as const),
    operationalMessage: last.operationalMessage,
    queues: cloneQueues(last.fullQueues),
    revisionCount: revisions.length,
  };
  return {
    ...base,
    changedQueues,
    contentHash: await computeDayContentHash(base),
    sourceUrl: params.sourceUrl,
    updatedAt: params.updatedAt,
    revisions,
  };
}

/** Removes consecutive duplicate revisions of an already stored day and refreshes derived fields. */
export async function sanitizeDayRevisions(day: DaySchedule): Promise<DaySchedule> {
  const revisions = finalizeRevisions(
    day.revisions.map((r) => ({
      operationalMessage: r.operationalMessage,
      fullQueues: r.fullQueues,
      recordedAt: r.recordedAt,
    })),
  );
  return assembleDay({ date: day.date, revisions, sourceUrl: day.sourceUrl, updatedAt: day.updatedAt });
}

function revisionsSignature(revisions: readonly DayRevision[]): string {
  return JSON.stringify(
    revisions.map((r) => [
      r.operationalMessage,
      ALL_SUBQUEUES.map((q) => r.fullQueues[q].intervals),
    ]),
  );
}

/**
 * Replays every version of one day (page order is newest-first) on top of the stored state
 * and builds the day with its chronological revision history.
 */
export async function mergeDayVersions(params: {
  date: DateIso;
  blocksNewestFirst: readonly ParsedBlock[];
  existingDay: DaySchedule | null;
  sourceUrl: string;
  recordedAt: TimestampIso;
}): Promise<MergeDayResult> {
  const { date, existingDay, sourceUrl, recordedAt } = params;

  const chronological = [...params.blocksNewestFirst]
    .reverse()
    .filter((b) => b.queues !== null || b.unappliedChanges.length > 0);
  const first = chronological[0];
  if (!first) {
    return { ok: false, errorCode: "NO_VALID_BLOCKS", errorMessage: `No usable blocks for ${date}` };
  }

  if (existingDay === null && (isChangeOnly(first) || first.isAdditive)) {
    return {
      ok: false,
      errorCode: "ORPHAN_DELTA_WITHOUT_BASE",
      errorMessage: `Delta update for ${date} has no stored base schedule to apply to`,
    };
  }

  // Seed: a version that only makes sense on top of a previous state starts from the stored day.
  let seed: QueuesMap | null = null;
  if (
    existingDay !== null &&
    (isChangeOnly(first) ||
      isPartialDelta(first, countActiveQueues(existingDay.queues)) ||
      isTailOnly(first) ||
      isPartialCancellation(first))
  ) {
    const secondToLast = existingDay.revisions[existingDay.revisions.length - 2];
    const alreadyApplied =
      normalizeMessageKey(existingDay.operationalMessage) ===
        normalizeMessageKey(first.operationalMessage) && secondToLast !== undefined;
    // Re-applying an already stored delta starts from the state before it (idempotent, and
    // an in-place edit of the delta replaces the previous application).
    seed = alreadyApplied && secondToLast ? secondToLast.fullQueues : existingDay.queues;
  }

  let current: QueuesMap | null = seed;
  let sawChangeOnly = false;
  const recomputed: Array<{ operationalMessage: string | null; queues: QueuesMap }> = [];
  for (const version of chronological) {
    if (isChangeOnly(version)) sawChangeOnly = true;
    const next = applyVersionToBase(current, version);
    if (next === null) continue;
    current = next;
    recomputed.push({ operationalMessage: version.operationalMessage, queues: next });
  }
  if (current === null || recomputed.length === 0) {
    return sawChangeOnly
      ? {
          ok: false,
          errorCode: "ORPHAN_DELTA_WITHOUT_BASE",
          errorMessage: `Change-only update for ${date} could not be applied`,
        }
      : { ok: false, errorCode: "NO_VALID_BLOCKS", errorMessage: `No applicable blocks for ${date}` };
  }

  // Previously stored revisions that are not superseded by the page are preserved (oldest first).
  const recomputedKeys = new Set(
    recomputed.map((r) => normalizeMessageKey(r.operationalMessage)).filter((k) => k !== null),
  );
  const singleBlockPage = recomputed.length === 1;
  const preserved: RevisionDraft[] = [];
  for (const rev of existingDay?.revisions ?? []) {
    const key = normalizeMessageKey(rev.operationalMessage);
    const superseded = key !== null && recomputedKeys.has(key) && !singleBlockPage;
    if (superseded) continue;
    if (recomputed.some((r) => areQueuesEqual(r.queues, rev.fullQueues))) continue;
    if (preserved.some((p) => areQueuesEqual(p.fullQueues, rev.fullQueues))) continue;
    preserved.push({
      operationalMessage: rev.operationalMessage,
      fullQueues: rev.fullQueues,
      recordedAt: rev.recordedAt,
    });
  }

  const recomputedDrafts: RevisionDraft[] = recomputed.map((r) => {
    const key = normalizeMessageKey(r.operationalMessage);
    const known = existingDay?.revisions.find(
      (rev) => normalizeMessageKey(rev.operationalMessage) === key && areQueuesEqual(rev.fullQueues, r.queues),
    );
    return {
      operationalMessage: r.operationalMessage,
      fullQueues: r.queues,
      recordedAt: known?.recordedAt ?? recordedAt,
    };
  });

  const revisions = finalizeRevisions([...preserved, ...recomputedDrafts]);
  const active = revisions[revisions.length - 1];
  const changedFromExisting =
    existingDay === null ||
    !active ||
    !areQueuesEqual(existingDay.queues, active.fullQueues) ||
    existingDay.operationalMessage !== active.operationalMessage ||
    revisionsSignature(existingDay.revisions) !== revisionsSignature(revisions);

  const day = await assembleDay({
    date,
    revisions,
    sourceUrl,
    updatedAt: changedFromExisting || !existingDay ? recordedAt : existingDay.updatedAt,
  });

  const newest = chronological[chronological.length - 1];
  return {
    ok: true,
    day,
    hasExplicitCancellation: newest?.hasExplicitCancellation ?? false,
    changedFromExisting,
  };
}
