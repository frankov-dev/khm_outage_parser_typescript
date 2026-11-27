export const ALL_SUBQUEUES = [
  "1.1",
  "1.2",
  "2.1",
  "2.2",
  "3.1",
  "3.2",
  "4.1",
  "4.2",
  "5.1",
  "5.2",
  "6.1",
  "6.2",
] as const;

export type SubqueueId = (typeof ALL_SUBQUEUES)[number];

/** Calendar date in `YYYY-MM-DD` format. */
export type DateIso = string;

/** Kyiv ISO-8601 timestamp with `+02:00` / `+03:00` offset. */
export type TimestampIso = string;

/** Outage interval in minutes from midnight: `0 <= startMin < endMin <= 1440`. */
export type MinuteInterval = readonly [startMin: number, endMin: number];

export interface QueueSchedule {
  intervals: MinuteInterval[];
  offMinutes: number;
}

export type QueuesMap = Record<SubqueueId, QueueSchedule>;

export type SparseQueuesDiff = Partial<Record<SubqueueId, QueueSchedule>>;

export type DayStatus = "ACTIVE" | "NO_OUTAGES";

export type AvailabilityStatus = DayStatus | "UNAVAILABLE";

export interface DayRevision {
  revNo: number;
  operationalMessage: string | null;
  changedQueues: SparseQueuesDiff;
  fullQueues: QueuesMap;
  recordedAt: TimestampIso;
}

export interface DaySchedule {
  date: DateIso;
  status: DayStatus;
  operationalMessage: string | null;
  queues: QueuesMap;
  revisionCount: number;
  changedQueues: SubqueueId[];
  contentHash: string;
  sourceUrl: string;
  updatedAt: TimestampIso;
  revisions: DayRevision[];
}

export type RunOutcome =
  | "SCHEDULE_UPDATED"
  | "SCHEDULE_UNCHANGED"
  | "DAY_ROLLOVER"
  | "NO_OUTAGES_SCHEDULED"
  | "NO_SCHEDULE"
  | "FETCH_ERROR"
  | "PARSE_ERROR"
  | "INCOMPLETE_DATA";

export interface SyncStateRecord {
  parserVersion: string;
  mainIrHash: string | null;
  newsIrHash: string | null;
  stateHash: string;
  dataHash: string;
  todayDate: DateIso;
  tomorrowDate: DateIso;
  lastSuccessAt: TimestampIso;
  lastCheckedAt: TimestampIso;
  lastOutcome: RunOutcome;
  consecutiveFailures: number;
}

export interface ScrapeRunRecord {
  startedAt: TimestampIso;
  finishedAt: TimestampIso;
  outcome: RunOutcome;
  httpStatus: number | null;
  datesParsed: DateIso[];
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
}

interface SyncResultBase {
  durationMs: number;
}

export type SyncResult =
  | (SyncResultBase & {
      outcome: "SCHEDULE_UPDATED" | "DAY_ROLLOVER" | "NO_OUTAGES_SCHEDULED";
      datesUpdated: DateIso[];
    })
  | (SyncResultBase & {
      outcome: "SCHEDULE_UNCHANGED" | "NO_SCHEDULE";
    })
  | (SyncResultBase & {
      outcome: "FETCH_ERROR" | "PARSE_ERROR" | "INCOMPLETE_DATA";
      httpStatus: number | null;
      errorCode: string;
      errorMessage: string;
    });
