-- Active canonical schedules (14-day retention window)
CREATE TABLE IF NOT EXISTS days (
    schedule_date        TEXT PRIMARY KEY,
    status               TEXT NOT NULL CHECK (status IN ('ACTIVE', 'NO_OUTAGES')),
    operational_message  TEXT,
    queues_json          TEXT NOT NULL,
    revision_count       INTEGER NOT NULL DEFAULT 1,
    changed_queues_json  TEXT NOT NULL DEFAULT '[]',
    content_hash         TEXT NOT NULL,
    source_url           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

-- Normalized chronological revision history per date (pruned alongside `days`)
CREATE TABLE IF NOT EXISTS day_revisions (
    schedule_date        TEXT NOT NULL,
    rev_no               INTEGER NOT NULL,
    operational_message  TEXT,
    changed_queues_json  TEXT NOT NULL,
    full_queues_json     TEXT NOT NULL,
    recorded_at          TEXT NOT NULL,
    PRIMARY KEY (schedule_date, rev_no)
);

-- Materialized pre-serialized JSON responses for 1-row-read HTTP API serving
CREATE TABLE IF NOT EXISTS api_snapshots (
    snapshot_key         TEXT PRIMARY KEY,
    body                 TEXT NOT NULL,
    etag                 TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

-- Global singleton sync state + two-tier IR fast-path hashes
CREATE TABLE IF NOT EXISTS sync_state (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    parser_version       TEXT NOT NULL,
    main_ir_hash         TEXT,
    news_ir_hash         TEXT,
    state_hash           TEXT NOT NULL,
    data_hash            TEXT NOT NULL,
    today_date           TEXT NOT NULL,
    tomorrow_date        TEXT NOT NULL,
    last_success_at      TEXT NOT NULL,
    last_checked_at      TEXT NOT NULL,
    last_outcome         TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Cron execution audit log (14-day retention window)
CREATE TABLE IF NOT EXISTS scrape_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at           TEXT NOT NULL,
    finished_at          TEXT NOT NULL,
    outcome              TEXT NOT NULL,
    http_status          INTEGER,
    dates_parsed_json    TEXT,
    error_code           TEXT,
    error_message        TEXT,
    duration_ms          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_started_at ON scrape_runs(started_at);
