import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { HtmlRewriterExtractor } from "../../src/adapters/html/html-rewriter-extractor";
import { D1ScheduleRepository } from "../../src/adapters/storage/d1-schedule-repository";
import {
  MAIN_SCHEDULE_URL,
  NEWS_LISTING_URL,
  SyncOrchestrator,
} from "../../src/core/pipeline/sync-orchestrator";
import type { FetchHtmlResult, HttpFetcher } from "../../src/core/ports/http-fetcher";
import { FixedKyivClock } from "../../src/core/time/kyiv-clock";
import type {
  ApiCurrentResponse,
  ApiDayDetailResponse,
  ApiHealthResponse,
  ApiQueueResponse,
  ApiSchedulesListResponse,
  ApiStatusResponse,
} from "../../src/core/types/api";
import { FIXTURE_HTML } from "../fixtures/parity-cases";

function makeFetcher(main: FetchHtmlResult, news?: FetchHtmlResult): HttpFetcher {
  return {
    async fetchHtml(url: string): Promise<FetchHtmlResult> {
      if (url === MAIN_SCHEDULE_URL) return main;
      if (url === NEWS_LISTING_URL && news) return news;
      return { ok: false, url, status: 404, errorCode: "HTTP_4XX", errorMessage: "HTTP 404" };
    },
  };
}

const ok = (url: string, html: string): FetchHtmlResult => ({ ok: true, url, status: 200, html });

describe("End-to-End Worker + D1 + HTMLRewriter + HTTP API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM days"),
      env.DB.prepare("DELETE FROM day_revisions"),
      env.DB.prepare("DELETE FROM api_snapshots"),
      env.DB.prepare("DELETE FROM sync_state"),
      env.DB.prepare("DELETE FROM scrape_runs"),
    ]);
  });

  it("syncs live fixture into D1, prunes old days, and serves all HTTP endpoints + ETag 304", async () => {
    // Seed an outdated 16-day-old row to verify atomic pruning on commitSync.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO days (schedule_date, status, operational_message, queues_json, revision_count, changed_queues_json, content_hash, source_url, updated_at)
         VALUES ('2026-11-10', 'ACTIVE', NULL, '{}', 1, '[]', '0000000000000000', 'x', '2026-11-10T00:00:00+02:00')`,
      ),
      env.DB.prepare(
        `INSERT INTO api_snapshots (snapshot_key, body, etag, updated_at)
         VALUES ('day:2026-11-10', '{}', 'old', '2026-11-10T00:00:00+02:00')`,
      ),
    ]);

    const repo = new D1ScheduleRepository(env.DB);
    const orchestrator = new SyncOrchestrator(
      makeFetcher(ok(MAIN_SCHEDULE_URL, FIXTURE_HTML.mainPage), ok(NEWS_LISTING_URL, FIXTURE_HTML.newsPage)),
      new HtmlRewriterExtractor(),
      repo,
      new FixedKyivClock("2026-11-27T01:00:00+02:00"),
    );

    const syncRes = await orchestrator.runSync();
    expect(syncRes.outcome).toBe("SCHEDULE_UPDATED");

    // 1. Atomic pruning removed 2026-11-10 (>14 days old).
    const remaining = await env.DB.prepare("SELECT schedule_date FROM days ORDER BY schedule_date").all<{
      schedule_date: string;
    }>();
    expect(remaining.results.map((r) => r.schedule_date)).toEqual(["2026-11-26", "2026-11-27"]);
    expect(await repo.getSnapshot("day:2026-11-10")).toBeNull();

    // 2. GET /api/current + ETag 304
    const curRes = await exports.default.fetch("https://example.com/api/current");
    expect(curRes.status).toBe(200);
    expect(curRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const etag = curRes.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const current = (await curRes.json()) as ApiCurrentResponse;
    expect(current.today.date).toBe("2026-11-27");
    expect(current.today.status).toBe("ACTIVE");
    expect(current.tomorrow.date).toBe("2026-11-28");
    expect(current.tomorrow.status).toBe("UNAVAILABLE");
    expect(current.availableDates).toEqual(["2026-11-27", "2026-11-26"]);

    const notModified = await exports.default.fetch("https://example.com/api/current", {
      headers: { "If-None-Match": etag! },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    // 3. GET /api/queues/1.1 & invalid queue
    const qRes = await exports.default.fetch("https://example.com/api/queues/1.1");
    expect(qRes.status).toBe(200);
    const qBody = (await qRes.json()) as ApiQueueResponse;
    expect(qBody.queue).toBe("1.1");
    expect(qBody.today.intervals).toEqual([
      [360, 480],
      [660, 840],
      [1020, 1200],
      [1320, 1440],
    ]);
    expect(qBody.today.offMinutes).toBe(600);
    expect((await exports.default.fetch("https://example.com/api/queues/9.9")).status).toBe(400);

    // 4. GET /api/status
    const statusRes = await exports.default.fetch("https://example.com/api/status");
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as ApiStatusResponse;
    expect(statusBody.stateHash).toBe(current.stateHash);
    expect(statusBody.hasTomorrow).toBe(false);
    expect(statusBody.availableDates).toEqual(["2026-11-27", "2026-11-26"]);

    // 5. GET /api/schedules & /api/schedules/:date
    const listRes = await exports.default.fetch("https://example.com/api/schedules");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as ApiSchedulesListResponse;
    expect(listBody.schedules).toHaveLength(2);

    const detailRes = await exports.default.fetch("https://example.com/api/schedules/2026-11-26");
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as ApiDayDetailResponse;
    expect(detailBody.revisionCount).toBe(2);
    expect(detailBody.revisions).toHaveLength(2);

    expect((await exports.default.fetch("https://example.com/api/schedules/2020-01-01")).status).toBe(404);
    expect((await exports.default.fetch("https://example.com/api/schedules/bad-date")).status).toBe(400);

    // 6. CORS preflight & method check & health
    expect(
      (await exports.default.fetch("https://example.com/api/current", { method: "OPTIONS" })).status,
    ).toBe(204);
    expect(
      (await exports.default.fetch("https://example.com/api/current", { method: "POST" })).status,
    ).toBe(405);

    const healthRes = await exports.default.fetch("https://example.com/health");
    expect(healthRes.status).toBe(200);
    expect((await healthRes.json()) as ApiHealthResponse).toMatchObject({
      status: "ok",
      dbReady: true,
      lastOutcome: "SCHEDULE_UPDATED",
      consecutiveFailures: 0,
    });

    // 7. D1 read efficiency: snapshot lookup scans at most 1 row!
    const snapQuery = await env.DB.prepare(
      "SELECT body, etag FROM api_snapshots WHERE snapshot_key = ?",
    )
      .bind("current")
      .all();
    expect(snapQuery.meta.rows_read).toBeLessThanOrEqual(1);
  });

  it("preserves LKG in real D1 across consecutive FETCH / PARSE / INCOMPLETE failures", async () => {
    const repo = new D1ScheduleRepository(env.DB);
    const clock = new FixedKyivClock("2026-11-27T01:00:00+02:00");

    // Seed valid state first.
    await new SyncOrchestrator(
      makeFetcher(ok(MAIN_SCHEDULE_URL, FIXTURE_HTML.mainPage), ok(NEWS_LISTING_URL, FIXTURE_HTML.newsPage)),
      new HtmlRewriterExtractor(),
      repo,
      clock,
    ).runSync();
    const initialBody = await (await exports.default.fetch("https://example.com/api/current")).text();

    // Fail 3 times in a row (network 500 -> missing container -> orphan delta).
    await new SyncOrchestrator(
      makeFetcher({
        ok: false,
        url: MAIN_SCHEDULE_URL,
        status: 500,
        errorCode: "HTTP_5XX",
        errorMessage: "HTTP 500",
      }),
      new HtmlRewriterExtractor(),
      repo,
      clock,
    ).runSync();
    await new SyncOrchestrator(
      makeFetcher(ok(MAIN_SCHEDULE_URL, "<html><body>Maintenance</body></html>")),
      new HtmlRewriterExtractor(),
      repo,
      clock,
    ).runSync();
    await new SyncOrchestrator(
      makeFetcher(
        ok(
          MAIN_SCHEDULE_URL,
          '<div class="post"><p>Оновлено на 28 листопада (оновлено з 21:30).</p><p>Додаткові години відсутності електроенергії:</p><p>Підчерга 1.1 – 22:00-24:00.</p></div>',
        ),
        ok(NEWS_LISTING_URL, "<html><body><div class='news-list'></div></body></html>"),
      ),
      new HtmlRewriterExtractor(),
      repo,
      clock,
    ).runSync();

    // LKG API payload MUST remain byte-for-byte identical!
    const afterBody = await (await exports.default.fetch("https://example.com/api/current")).text();
    expect(afterBody).toBe(initialBody);

    // Health reflects degraded state with consecutiveFailures = 3.
    const health = (await (
      await exports.default.fetch("https://example.com/health")
    ).json()) as ApiHealthResponse;
    expect(health.status).toBe("degraded");
    expect(health.consecutiveFailures).toBe(3);
    expect(health.lastOutcome).toBe("INCOMPLETE_DATA");
  });

  it("returns 503 when snapshots have not been populated yet", async () => {
    const res = await exports.default.fetch("https://example.com/api/current");
    expect(res.status).toBe(503);
  });
});
