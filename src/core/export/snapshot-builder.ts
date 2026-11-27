import type { SnapshotWrite } from "../ports/schedule-store";
import type {
  ApiCurrentResponse,
  ApiDayDetailResponse,
  ApiDayView,
  ApiQueueDayView,
  ApiQueueResponse,
  ApiSchedulesListResponse,
  ApiStatusResponse,
} from "../types/api";
import {
  ALL_SUBQUEUES,
  type DateIso,
  type DaySchedule,
  type SubqueueId,
  type SyncStateRecord,
  type TimestampIso,
} from "../types/domain";
import { areIntervalsEqual } from "../versioning/schedule-differ";

export const MAX_HISTORY_DAYS = 14;

/** True when the Kyiv calendar day moved since the last sync (also after multi-day idle gaps). */
export function needsDayRollover(
  syncState: SyncStateRecord | null,
  todayDate: DateIso,
  tomorrowDate: DateIso,
): boolean {
  return (
    syncState === null || syncState.todayDate !== todayDate || syncState.tomorrowDate !== tomorrowDate
  );
}

function toDayView(date: DateIso, day: DaySchedule | undefined): ApiDayView {
  if (!day) {
    return {
      date,
      status: "UNAVAILABLE",
      message: null,
      revisionCount: 0,
      changedQueues: [],
      queues: null,
    };
  }
  return {
    date,
    status: day.status,
    message: day.operationalMessage,
    revisionCount: day.revisionCount,
    changedQueues: day.changedQueues,
    queues: day.queues,
  };
}

function toQueueDayView(date: DateIso, day: DaySchedule | undefined, queue: SubqueueId): ApiQueueDayView {
  if (!day) {
    return {
      date,
      status: "UNAVAILABLE",
      message: null,
      intervals: null,
      offMinutes: null,
      prevIntervals: null,
      deltaMinutes: null,
    };
  }
  const current = day.queues[queue];
  const previous = day.revisions[day.revisions.length - 2]?.fullQueues[queue];
  const changed = previous !== undefined && !areIntervalsEqual(previous.intervals, current.intervals);
  return {
    date,
    status: day.status,
    message: day.operationalMessage,
    intervals: current.intervals,
    offMinutes: current.offMinutes,
    prevIntervals: changed ? previous.intervals : null,
    deltaMinutes: changed ? current.offMinutes - previous.offMinutes : null,
  };
}

export interface BuildSnapshotsParams {
  days: readonly DaySchedule[];
  sourceUrl: string;
  todayDate: DateIso;
  tomorrowDate: DateIso;
  updatedAt: TimestampIso;
  checkedAt: TimestampIso;
  stateHash: string;
  dataHash: string;
  maxDays?: number | undefined;
}

/** Builds every pre-serialised API response (minified JSON) served straight from D1. */
export function buildApiSnapshots(params: BuildSnapshotsParams): SnapshotWrite[] {
  const { sourceUrl, todayDate, tomorrowDate, updatedAt, checkedAt, stateHash, dataHash } = params;
  const days = [...params.days]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, params.maxDays ?? MAX_HISTORY_DAYS);
  const byDate = new Map(days.map((d) => [d.date, d] as const));
  const todayDay = byDate.get(todayDate);
  const tomorrowDay = byDate.get(tomorrowDate);
  const availableDates = days.map((d) => d.date);

  const write = (key: string, body: unknown, etag: string): SnapshotWrite => ({
    key,
    body: JSON.stringify(body),
    etag,
    updatedAt,
  });

  const status: ApiStatusResponse = {
    source: sourceUrl,
    stateHash,
    dataHash,
    todayDate,
    todayStatus: todayDay?.status ?? "UNAVAILABLE",
    tomorrowDate,
    hasTomorrow: tomorrowDay !== undefined,
    availableDates,
    updatedAt,
    checkedAt,
  };

  const current: ApiCurrentResponse = {
    source: sourceUrl,
    stateHash,
    dataHash,
    updatedAt,
    today: toDayView(todayDate, todayDay),
    tomorrow: toDayView(tomorrowDate, tomorrowDay),
    availableDates,
  };

  const history: ApiSchedulesListResponse = {
    source: sourceUrl,
    stateHash,
    dataHash,
    updatedAt,
    availableDates,
    schedules: days.map((d) => ({
      date: d.date,
      status: d.status,
      message: d.operationalMessage,
      revisionCount: d.revisionCount,
      changedQueues: d.changedQueues,
      queues: d.queues,
      updatedAt: d.updatedAt,
    })),
  };

  const snapshots: SnapshotWrite[] = [
    write("status", status, stateHash),
    write("current", current, stateHash),
    write("history", history, dataHash),
  ];

  for (const day of days) {
    const detail: ApiDayDetailResponse = {
      source: sourceUrl,
      stateHash,
      date: day.date,
      status: day.status,
      message: day.operationalMessage,
      revisionCount: day.revisionCount,
      queues: day.queues,
      revisions: day.revisions.map((r) => ({
        revNo: r.revNo,
        recordedAt: r.recordedAt,
        message: r.operationalMessage,
        changedQueues: r.changedQueues,
      })),
      updatedAt: day.updatedAt,
    };
    snapshots.push(write(`day:${day.date}`, detail, day.contentHash));
  }

  for (const queue of ALL_SUBQUEUES) {
    const body: ApiQueueResponse = {
      source: sourceUrl,
      queue,
      stateHash,
      updatedAt,
      today: toQueueDayView(todayDate, todayDay, queue),
      tomorrow: toQueueDayView(tomorrowDate, tomorrowDay, queue),
    };
    snapshots.push(write(`queue:${queue}`, body, stateHash));
  }

  return snapshots;
}
