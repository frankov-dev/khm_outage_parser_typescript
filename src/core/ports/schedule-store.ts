import type {
  DateIso,
  DaySchedule,
  RunOutcome,
  ScrapeRunRecord,
  SyncStateRecord,
  TimestampIso,
} from "../types/domain";

export interface SnapshotWrite {
  key: string;
  body: string;
  etag: string;
  updatedAt: TimestampIso;
}

export interface StoredSnapshot {
  body: string;
  etag: string;
}

export interface CommitPayload {
  upsertedDays: DaySchedule[];
  snapshots: SnapshotWrite[];
  syncState: SyncStateRecord;
  runRecord: ScrapeRunRecord;
  pruneBeforeDate: DateIso;
}

export interface SyncStateCheckPatch {
  lastCheckedAt: TimestampIso;
  lastOutcome: RunOutcome;
  consecutiveFailures: number;
  mainIrHash?: string | null | undefined;
  newsIrHash?: string | null | undefined;
}

export interface ScheduleStore {
  getSyncState(): Promise<SyncStateRecord | null>;
  getDaysByDates(dates: DateIso[]): Promise<DaySchedule[]>;
  getAllDays(limit?: number): Promise<DaySchedule[]>;
  /** Atomically persists days, snapshots, sync state and run log; prunes old data. */
  commitSync(payload: CommitPayload): Promise<void>;
  /** Records a no-op or failed run without touching the last valid schedule. */
  recordNoOpOrFailure(
    patch: SyncStateCheckPatch,
    runRecord: ScrapeRunRecord,
    pruneRunsBeforeIso?: TimestampIso,
  ): Promise<void>;
  getSnapshot(key: string): Promise<StoredSnapshot | null>;
}
