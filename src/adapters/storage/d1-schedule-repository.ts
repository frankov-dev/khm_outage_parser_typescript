import type {
  CommitPayload,
  ScheduleStore,
  StoredSnapshot,
  SyncStateCheckPatch,
} from "../../core/ports/schedule-store";
import type {
  DateIso,
  DayRevision,
  DaySchedule,
  DayStatus,
  QueuesMap,
  RunOutcome,
  ScrapeRunRecord,
  SparseQueuesDiff,
  SubqueueId,
  SyncStateRecord,
  TimestampIso,
} from "../../core/types/domain";

interface DayRow {
  schedule_date: string;
  status: string;
  operational_message: string | null;
  queues_json: string;
  revision_count: number;
  changed_queues_json: string;
  content_hash: string;
  source_url: string;
  updated_at: string;
}

interface RevisionRow {
  schedule_date: string;
  rev_no: number;
  operational_message: string | null;
  changed_queues_json: string;
  full_queues_json: string;
  recorded_at: string;
}

interface SyncStateRow {
  parser_version: string;
  main_ir_hash: string | null;
  news_ir_hash: string | null;
  state_hash: string;
  data_hash: string;
  today_date: string;
  tomorrow_date: string;
  last_success_at: string;
  last_checked_at: string;
  last_outcome: string;
  consecutive_failures: number;
}

export class D1ScheduleRepository implements ScheduleStore {
  constructor(private readonly db: D1Database) {}

  async ping(): Promise<void> {
    await this.db.prepare("SELECT 1").first();
  }

  async getSyncState(): Promise<SyncStateRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT parser_version, main_ir_hash, news_ir_hash, state_hash, data_hash,
                today_date, tomorrow_date, last_success_at, last_checked_at,
                last_outcome, consecutive_failures
         FROM sync_state WHERE id = 1`,
      )
      .first<SyncStateRow>();
    if (!row) return null;
    return {
      parserVersion: row.parser_version,
      mainIrHash: row.main_ir_hash,
      newsIrHash: row.news_ir_hash,
      stateHash: row.state_hash,
      dataHash: row.data_hash,
      todayDate: row.today_date,
      tomorrowDate: row.tomorrow_date,
      lastSuccessAt: row.last_success_at,
      lastCheckedAt: row.last_checked_at,
      lastOutcome: row.last_outcome as RunOutcome,
      consecutiveFailures: row.consecutive_failures,
    };
  }

  async getDaysByDates(dates: DateIso[]): Promise<DaySchedule[]> {
    if (dates.length === 0) return [];
    const placeholders = dates.map(() => "?").join(", ");
    const dayStmt = this.db
      .prepare(
        `SELECT schedule_date, status, operational_message, queues_json, revision_count,
                changed_queues_json, content_hash, source_url, updated_at
         FROM days WHERE schedule_date IN (${placeholders})
         ORDER BY schedule_date DESC`,
      )
      .bind(...dates);
    const revStmt = this.db
      .prepare(
        `SELECT schedule_date, rev_no, operational_message, changed_queues_json,
                full_queues_json, recorded_at
         FROM day_revisions WHERE schedule_date IN (${placeholders})
         ORDER BY schedule_date DESC, rev_no ASC`,
      )
      .bind(...dates);

    const [dayRes, revRes] = await this.db.batch<DayRow | RevisionRow>([dayStmt, revStmt]);
    return this.assembleDays(
      (dayRes?.results ?? []) as DayRow[],
      (revRes?.results ?? []) as RevisionRow[],
    );
  }

  async getAllDays(limit = 14): Promise<DaySchedule[]> {
    const { results: dayRows } = await this.db
      .prepare(
        `SELECT schedule_date, status, operational_message, queues_json, revision_count,
                changed_queues_json, content_hash, source_url, updated_at
         FROM days ORDER BY schedule_date DESC LIMIT ?`,
      )
      .bind(limit)
      .all<DayRow>();
    if (dayRows.length === 0) return [];

    const dates = dayRows.map((r) => r.schedule_date);
    const placeholders = dates.map(() => "?").join(", ");
    const { results: revRows } = await this.db
      .prepare(
        `SELECT schedule_date, rev_no, operational_message, changed_queues_json,
                full_queues_json, recorded_at
         FROM day_revisions WHERE schedule_date IN (${placeholders})
         ORDER BY schedule_date DESC, rev_no ASC`,
      )
      .bind(...dates)
      .all<RevisionRow>();
    return this.assembleDays(dayRows, revRows);
  }

  private assembleDays(dayRows: DayRow[], revRows: RevisionRow[]): DaySchedule[] {
    const revsByDate = new Map<DateIso, DayRevision[]>();
    for (const r of revRows) {
      const list = revsByDate.get(r.schedule_date) ?? [];
      list.push({
        revNo: r.rev_no,
        operationalMessage: r.operational_message,
        changedQueues: JSON.parse(r.changed_queues_json) as SparseQueuesDiff,
        fullQueues: JSON.parse(r.full_queues_json) as QueuesMap,
        recordedAt: r.recorded_at,
      });
      revsByDate.set(r.schedule_date, list);
    }

    return dayRows.map((d) => ({
      date: d.schedule_date,
      status: d.status as DayStatus,
      operationalMessage: d.operational_message,
      queues: JSON.parse(d.queues_json) as QueuesMap,
      revisionCount: d.revision_count,
      changedQueues: JSON.parse(d.changed_queues_json) as SubqueueId[],
      contentHash: d.content_hash,
      sourceUrl: d.source_url,
      updatedAt: d.updated_at,
      revisions: revsByDate.get(d.schedule_date) ?? [],
    }));
  }

  private insertRunStatement(run: ScrapeRunRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO scrape_runs
         (started_at, finished_at, outcome, http_status, dates_parsed_json, error_code, error_message, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.startedAt,
        run.finishedAt,
        run.outcome,
        run.httpStatus,
        JSON.stringify(run.datesParsed),
        run.errorCode,
        run.errorMessage,
        run.durationMs,
      );
  }

  async commitSync(payload: CommitPayload): Promise<void> {
    const stmts: D1PreparedStatement[] = [];

    for (const day of payload.upsertedDays) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO days
             (schedule_date, status, operational_message, queues_json, revision_count,
              changed_queues_json, content_hash, source_url, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(schedule_date) DO UPDATE SET
               status = excluded.status,
               operational_message = excluded.operational_message,
               queues_json = excluded.queues_json,
               revision_count = excluded.revision_count,
               changed_queues_json = excluded.changed_queues_json,
               content_hash = excluded.content_hash,
               source_url = excluded.source_url,
               updated_at = excluded.updated_at`,
          )
          .bind(
            day.date,
            day.status,
            day.operationalMessage,
            JSON.stringify(day.queues),
            day.revisionCount,
            JSON.stringify(day.changedQueues),
            day.contentHash,
            day.sourceUrl,
            day.updatedAt,
          ),
      );
      stmts.push(
        this.db.prepare("DELETE FROM day_revisions WHERE schedule_date = ?").bind(day.date),
      );
      for (const rev of day.revisions) {
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO day_revisions
               (schedule_date, rev_no, operational_message, changed_queues_json, full_queues_json, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              day.date,
              rev.revNo,
              rev.operationalMessage,
              JSON.stringify(rev.changedQueues),
              JSON.stringify(rev.fullQueues),
              rev.recordedAt,
            ),
        );
      }
    }

    for (const snap of payload.snapshots) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO api_snapshots (snapshot_key, body, etag, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(snapshot_key) DO UPDATE SET
               body = excluded.body,
               etag = excluded.etag,
               updated_at = excluded.updated_at`,
          )
          .bind(snap.key, snap.body, snap.etag, snap.updatedAt),
      );
    }

    const s = payload.syncState;
    stmts.push(
      this.db
        .prepare(
          `INSERT INTO sync_state
           (id, parser_version, main_ir_hash, news_ir_hash, state_hash, data_hash,
            today_date, tomorrow_date, last_success_at, last_checked_at,
            last_outcome, consecutive_failures)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             parser_version = excluded.parser_version,
             main_ir_hash = excluded.main_ir_hash,
             news_ir_hash = excluded.news_ir_hash,
             state_hash = excluded.state_hash,
             data_hash = excluded.data_hash,
             today_date = excluded.today_date,
             tomorrow_date = excluded.tomorrow_date,
             last_success_at = excluded.last_success_at,
             last_checked_at = excluded.last_checked_at,
             last_outcome = excluded.last_outcome,
             consecutive_failures = excluded.consecutive_failures`,
        )
        .bind(
          s.parserVersion,
          s.mainIrHash,
          s.newsIrHash,
          s.stateHash,
          s.dataHash,
          s.todayDate,
          s.tomorrowDate,
          s.lastSuccessAt,
          s.lastCheckedAt,
          s.lastOutcome,
          s.consecutiveFailures,
        ),
    );

    stmts.push(this.insertRunStatement(payload.runRecord));

    // Atomic 14-day retention pruning alongside the commit.
    stmts.push(
      this.db.prepare("DELETE FROM days WHERE schedule_date < ?").bind(payload.pruneBeforeDate),
      this.db
        .prepare("DELETE FROM day_revisions WHERE schedule_date < ?")
        .bind(payload.pruneBeforeDate),
      this.db
        .prepare("DELETE FROM api_snapshots WHERE snapshot_key LIKE 'day:%' AND substr(snapshot_key, 5) < ?")
        .bind(payload.pruneBeforeDate),
      this.db
        .prepare("DELETE FROM scrape_runs WHERE started_at < ?")
        .bind(payload.pruneBeforeDate),
    );

    await this.db.batch(stmts);
  }

  async recordNoOpOrFailure(
    patch: SyncStateCheckPatch,
    runRecord: ScrapeRunRecord,
    pruneRunsBeforeIso?: TimestampIso,
  ): Promise<void> {
    const sets = [
      "last_checked_at = ?",
      "last_outcome = ?",
      "consecutive_failures = ?",
    ];
    const params: Array<string | number | null> = [
      patch.lastCheckedAt,
      patch.lastOutcome,
      patch.consecutiveFailures,
    ];
    if (patch.mainIrHash !== undefined) {
      sets.push("main_ir_hash = ?");
      params.push(patch.mainIrHash);
    }
    if (patch.newsIrHash !== undefined) {
      sets.push("news_ir_hash = ?");
      params.push(patch.newsIrHash);
    }

    const stmts: D1PreparedStatement[] = [
      this.db.prepare(`UPDATE sync_state SET ${sets.join(", ")} WHERE id = 1`).bind(...params),
      this.insertRunStatement(runRecord),
    ];
    if (pruneRunsBeforeIso !== undefined) {
      stmts.push(
        this.db.prepare("DELETE FROM scrape_runs WHERE started_at < ?").bind(pruneRunsBeforeIso),
      );
    }

    await this.db.batch(stmts);
  }

  async getSnapshot(key: string): Promise<StoredSnapshot | null> {
    const row = await this.db
      .prepare("SELECT body, etag FROM api_snapshots WHERE snapshot_key = ?")
      .bind(key)
      .first<StoredSnapshot>();
    return row ?? null;
  }
}
