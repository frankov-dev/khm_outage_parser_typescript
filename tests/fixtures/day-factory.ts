import { buildQueuesMap } from "../../src/core/normalizing";
import {
  type DateIso,
  type DaySchedule,
  type MinuteInterval,
  type SubqueueId,
} from "../../src/core/types/domain";
import {
  computeDayContentHash,
  computeSparseQueuesDiff,
  hasAnyOutages,
} from "../../src/core/versioning";

export type QueueIntervals = Partial<Record<SubqueueId, MinuteInterval[]>>;

export const RECORDED_AT = "2026-11-27T08:00:00+02:00";

/** Builds a valid single-revision day for tests. */
export async function makeDay(options: {
  date: DateIso;
  intervals?: QueueIntervals;
  message?: string | null;
  updatedAt?: string;
}): Promise<DaySchedule> {
  const entries = Object.entries(options.intervals ?? {}) as Array<[SubqueueId, MinuteInterval[]]>;
  const queues = buildQueuesMap(new Map(entries));
  const base = {
    date: options.date,
    status: hasAnyOutages(queues) ? ("ACTIVE" as const) : ("NO_OUTAGES" as const),
    operationalMessage: options.message ?? null,
    queues,
    revisionCount: 1,
  };
  return {
    ...base,
    changedQueues: [],
    contentHash: await computeDayContentHash(base),
    sourceUrl: "https://hoe.com.ua/page/pogodinni-vidkljuchennja",
    updatedAt: options.updatedAt ?? RECORDED_AT,
    revisions: [
      {
        revNo: 1,
        operationalMessage: base.operationalMessage,
        changedQueues: computeSparseQueuesDiff(null, queues).diff,
        fullQueues: structuredClone(queues),
        recordedAt: options.updatedAt ?? RECORDED_AT,
      },
    ],
  };
}
