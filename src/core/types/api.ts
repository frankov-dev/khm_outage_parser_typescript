import type {
  AvailabilityStatus,
  DateIso,
  DayStatus,
  MinuteInterval,
  QueuesMap,
  RunOutcome,
  SparseQueuesDiff,
  SubqueueId,
  TimestampIso,
} from "./domain";

export interface ApiDayView {
  date: DateIso;
  status: AvailabilityStatus;
  message: string | null;
  revisionCount: number;
  changedQueues: SubqueueId[];
  queues: QueuesMap | null;
}

/** `GET /api/current` */
export interface ApiCurrentResponse {
  source: string;
  stateHash: string;
  dataHash: string;
  updatedAt: TimestampIso;
  today: ApiDayView;
  tomorrow: ApiDayView;
  availableDates: DateIso[];
}

export interface ApiQueueDayView {
  date: DateIso;
  status: AvailabilityStatus;
  message: string | null;
  intervals: MinuteInterval[] | null;
  offMinutes: number | null;
  prevIntervals: MinuteInterval[] | null;
  deltaMinutes: number | null;
}

/** `GET /api/queues/:id` */
export interface ApiQueueResponse {
  source: string;
  queue: SubqueueId;
  stateHash: string;
  updatedAt: TimestampIso;
  today: ApiQueueDayView;
  tomorrow: ApiQueueDayView;
}

/** `GET /api/status` */
export interface ApiStatusResponse {
  source: string;
  stateHash: string;
  dataHash: string;
  todayDate: DateIso;
  todayStatus: AvailabilityStatus;
  tomorrowDate: DateIso;
  hasTomorrow: boolean;
  availableDates: DateIso[];
  updatedAt: TimestampIso;
  checkedAt: TimestampIso;
}

export interface ApiSchedulesHistoryItem {
  date: DateIso;
  status: DayStatus;
  message: string | null;
  revisionCount: number;
  changedQueues: SubqueueId[];
  queues: QueuesMap;
  updatedAt: TimestampIso;
}

/** `GET /api/schedules` */
export interface ApiSchedulesListResponse {
  source: string;
  stateHash: string;
  dataHash: string;
  updatedAt: TimestampIso;
  availableDates: DateIso[];
  schedules: ApiSchedulesHistoryItem[];
}

export interface ApiRevisionView {
  revNo: number;
  recordedAt: TimestampIso;
  message: string | null;
  changedQueues: SparseQueuesDiff;
}

/** `GET /api/schedules/:date` */
export interface ApiDayDetailResponse {
  source: string;
  stateHash: string;
  date: DateIso;
  status: DayStatus;
  message: string | null;
  revisionCount: number;
  queues: QueuesMap;
  revisions: ApiRevisionView[];
  updatedAt: TimestampIso;
}

/** `GET /health` */
export interface ApiHealthResponse {
  status: "ok" | "degraded";
  dbReady: boolean;
  lastOutcome: RunOutcome | null;
  lastSuccessAt: TimestampIso | null;
  lastCheckedAt: TimestampIso | null;
  consecutiveFailures: number;
}
