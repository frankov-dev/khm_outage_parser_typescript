import { describe, expect, it } from "vitest";
import { CheerioHtmlExtractor } from "../../src/adapters/html/cheerio-extractor";
import {
  MAIN_SCHEDULE_URL,
  NEWS_LISTING_URL,
  SyncOrchestrator,
} from "../../src/core/pipeline/sync-orchestrator";
import type { FetchHtmlResult, HttpFetcher } from "../../src/core/ports/http-fetcher";
import type {
  CommitPayload,
  ScheduleStore,
  StoredSnapshot,
  SyncStateCheckPatch,
} from "../../src/core/ports/schedule-store";
import { FixedKyivClock } from "../../src/core/time/kyiv-clock";
import {
  ALL_SUBQUEUES,
  type DateIso,
  type DaySchedule,
  type ScrapeRunRecord,
  type SyncStateRecord,
  type TimestampIso,
} from "../../src/core/types/domain";
import { makeDay } from "../fixtures/day-factory";
import { FIXTURE_HTML } from "../fixtures/parity-cases";

class InMemoryScheduleStore implements ScheduleStore {
  days = new Map<DateIso, DaySchedule>();
  snapshots = new Map<string, StoredSnapshot>();
  syncState: SyncStateRecord | null = null;
  runs: ScrapeRunRecord[] = [];
  commitCount = 0;
  noOpOrFailCount = 0;

  async getSyncState(): Promise<SyncStateRecord | null> {
    return this.syncState ? structuredClone(this.syncState) : null;
  }

  async getDaysByDates(dates: DateIso[]): Promise<DaySchedule[]> {
    return dates
      .map((d) => this.days.get(d))
      .filter((d): d is DaySchedule => d !== undefined)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => structuredClone(d));
  }

  async getAllDays(limit = 14): Promise<DaySchedule[]> {
    return [...this.days.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }

  async commitSync(payload: CommitPayload): Promise<void> {
    this.commitCount++;
    for (const day of payload.upsertedDays) {
      this.days.set(day.date, structuredClone(day));
    }
    for (const snap of payload.snapshots) {
      this.snapshots.set(snap.key, { body: snap.body, etag: snap.etag });
    }
    for (const [date] of this.days) {
      if (date < payload.pruneBeforeDate) {
        this.days.delete(date);
        this.snapshots.delete(`day:${date}`);
      }
    }
    this.syncState = structuredClone(payload.syncState);
    this.runs.push(structuredClone(payload.runRecord));
  }

  async recordNoOpOrFailure(
    patch: SyncStateCheckPatch,
    runRecord: ScrapeRunRecord,
    _pruneRunsBeforeIso?: TimestampIso,
  ): Promise<void> {
    this.noOpOrFailCount++;
    if (this.syncState) {
      this.syncState = {
        ...this.syncState,
        lastCheckedAt: patch.lastCheckedAt,
        lastOutcome: patch.lastOutcome,
        consecutiveFailures: patch.consecutiveFailures,
        ...(patch.mainIrHash !== undefined ? { mainIrHash: patch.mainIrHash } : {}),
        ...(patch.newsIrHash !== undefined ? { newsIrHash: patch.newsIrHash } : {}),
      };
    }
    this.runs.push(structuredClone(runRecord));
  }

  async getSnapshot(key: string): Promise<StoredSnapshot | null> {
    return this.snapshots.get(key) ?? null;
  }
}

function mapFetcher(routes: Record<string, FetchHtmlResult>): {
  fetcher: HttpFetcher;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetcher: {
      async fetchHtml(url: string): Promise<FetchHtmlResult> {
        calls.push(url);
        return (
          routes[url] ?? {
            ok: false,
            url,
            status: 404,
            errorCode: "HTTP_4XX",
            errorMessage: "HTTP 404",
          }
        );
      },
    },
  };
}

const okPage = (url: string, html: string): FetchHtmlResult => ({
  ok: true,
  url,
  status: 200,
  html,
});

const TODAY_HTML = `<html><body><h1>Погодинні відключення</h1><div class="post">
  <p>За розпорядженням НЕК «Укренерго» 27.11.2026 р. будуть застосовані графіки погодинних відключень (ГПВ).</p>
  <p>${ALL_SUBQUEUES.map((q) => `Підчерга ${q} – 08:00-10:00.`).join("<br/>")}</p>
</div></body></html>`;

const EMPTY_NEWS_HTML = `<html><body><h1>Новини Компанії</h1><div class="news-list"></div><div class="post"></div></body></html>`;

describe("SyncOrchestrator", () => {
  const extractor = new CheerioHtmlExtractor();

  it("handles SCHEDULE_UPDATED then fast-paths SCHEDULE_UNCHANGED", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FixedKyivClock("2026-11-27T10:00:00+02:00");
    const { fetcher, calls } = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, TODAY_HTML),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, EMPTY_NEWS_HTML),
    });

    const orch = new SyncOrchestrator(fetcher, extractor, store, clock);
    const first = await orch.runSync();
    expect(first.outcome).toBe("SCHEDULE_UPDATED");
    expect(store.commitCount).toBe(1);
    expect(store.days.get("2026-11-27")?.queues["1.1"].offMinutes).toBe(120);

    // Second run on identical HTML + news: fast-path skips re-commit & re-parsing.
    calls.length = 0;
    const second = await orch.runSync();
    expect(second.outcome).toBe("SCHEDULE_UNCHANGED");
    expect(store.commitCount).toBe(1);
    expect(store.noOpOrFailCount).toBe(1);
    expect(calls).toEqual([MAIN_SCHEDULE_URL, NEWS_LISTING_URL]);
  });

  it("handles DAY_ROLLOVER at midnight when HTML is unchanged and refreshes stateHash", async () => {
    const store = new InMemoryScheduleStore();
    const { fetcher } = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, TODAY_HTML),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, EMPTY_NEWS_HTML),
    });

    await new SyncOrchestrator(
      fetcher,
      extractor,
      store,
      new FixedKyivClock("2026-11-27T23:55:00+02:00"),
    ).runSync();
    const beforeStateHash = store.syncState?.stateHash;
    const beforeDataHash = store.syncState?.dataHash;

    // 10 minutes later: midnight rollover in Kyiv -> 2026-11-28.
    const rollover = await new SyncOrchestrator(
      fetcher,
      extractor,
      store,
      new FixedKyivClock("2026-11-28T00:05:00+02:00"),
    ).runSync();

    expect(rollover.outcome).toBe("DAY_ROLLOVER");
    expect(store.commitCount).toBe(2);
    expect(store.syncState?.todayDate).toBe("2026-11-28");
    expect(store.syncState?.dataHash).toBe(beforeDataHash);
    expect(store.syncState?.stateHash).not.toBe(beforeStateHash);
  });

  it("handles NO_OUTAGES_SCHEDULED when all 12 queues explicitly have no outages", async () => {
    const store = new InMemoryScheduleStore();
    const html = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» 27.11.2026 р. вимкнень не буде.</p>
      <p>${ALL_SUBQUEUES.map((q) => `Підчерга ${q} – вимкнень немає.`).join("<br/>")}</p>
    </div>`;
    const { fetcher } = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, html),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, EMPTY_NEWS_HTML),
    });

    const res = await new SyncOrchestrator(
      fetcher,
      extractor,
      store,
      new FixedKyivClock("2026-11-27T10:00:00+02:00"),
    ).runSync();

    expect(res.outcome).toBe("NO_OUTAGES_SCHEDULED");
    expect(store.days.get("2026-11-27")?.status).toBe("NO_OUTAGES");
    expect(store.syncState?.consecutiveFailures).toBe(0);
  });

  it("handles NO_SCHEDULE on a valid page without GPV blocks without incrementing failures", async () => {
    const store = new InMemoryScheduleStore();
    const html = `<html><body><h1>Погодинні відключення</h1><div class="post"><p>Застосування ГПВ наразі не планується.</p></div></body></html>`;
    const { fetcher } = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, html),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, EMPTY_NEWS_HTML),
    });

    const res = await new SyncOrchestrator(
      fetcher,
      extractor,
      store,
      new FixedKyivClock("2026-11-27T10:00:00+02:00"),
    ).runSync();

    expect(res.outcome).toBe("NO_SCHEDULE");
    expect(store.runs.at(-1)?.outcome).toBe("NO_SCHEDULE");
  });

  it("protects LKG on FETCH_ERROR, PARSE_ERROR, orphan delta, and suspicious zeroing", async () => {
    const store = new InMemoryScheduleStore();
    const existing = await makeDay({
      date: "2026-11-27",
      intervals: { "1.1": [[360, 480]], "2.1": [[600, 720]] },
    });
    store.days.set("2026-11-27", existing);
    store.snapshots.set("current", { body: '{"preserved":true}', etag: "lkg" });
    store.syncState = {
      parserVersion: "1.0.0",
      mainIrHash: "old",
      newsIrHash: null,
      stateHash: "lkg",
      dataHash: "lkg",
      todayDate: "2026-11-27",
      tomorrowDate: "2026-11-28",
      lastSuccessAt: "2026-11-27T08:00:00+02:00",
      lastCheckedAt: "2026-11-27T08:00:00+02:00",
      lastOutcome: "SCHEDULE_UPDATED",
      consecutiveFailures: 0,
    };

    const clock = new FixedKyivClock("2026-11-27T11:00:00+02:00");

    // 1. FETCH_ERROR (origin 500)
    const f1 = mapFetcher({
      [MAIN_SCHEDULE_URL]: {
        ok: false,
        url: MAIN_SCHEDULE_URL,
        status: 500,
        errorCode: "HTTP_5XX",
        errorMessage: "HTTP 500",
      },
    });
    const r1 = await new SyncOrchestrator(f1.fetcher, extractor, store, clock).runSync();
    expect(r1).toMatchObject({ outcome: "FETCH_ERROR", httpStatus: 500 });

    // 2. PARSE_ERROR (maintenance page missing div.post)
    const f2 = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, "<html><body>Maintenance</body></html>"),
    });
    const r2 = await new SyncOrchestrator(f2.fetcher, extractor, store, clock).runSync();
    expect(r2).toMatchObject({ outcome: "PARSE_ERROR", errorCode: "MISSING_CONTENT_CONTAINER" });

    // 3. INCOMPLETE_DATA (orphan delta for a brand-new date 2026-11-28 without base)
    const orphanHtml = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» на 28 листопада (оновлено з 21:30).</p>
      <p>Додаткові години відсутності електроенергії:</p>
      <p>Підчерга 5.2 – 22:00-24:00.</p></div>`;
    const f3 = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, orphanHtml),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, EMPTY_NEWS_HTML),
    });
    const r3 = await new SyncOrchestrator(f3.fetcher, extractor, store, clock).runSync();
    expect(r3).toMatchObject({ outcome: "INCOMPLETE_DATA", errorCode: "ORPHAN_DELTA_WITHOUT_BASE" });

    // LKG must be 100% intact across all 3 failure modes!
    expect(store.commitCount).toBe(0);
    expect(store.days.get("2026-11-27")).toEqual(existing);
    expect(store.snapshots.get("current")?.body).toBe('{"preserved":true}');
    expect(store.syncState?.consecutiveFailures).toBe(3);
  });

  it("picks up tomorrow from News post #2 when post #1 is today's update and ignores old archive posts", async () => {
    const store = new InMemoryScheduleStore();
    const newsListing = `<html><body><div class="news-list">
      <article class="item clearfix"><div class="wr"><div class="heading"><a href="/post/prognoz-gpv-na-27-listopada.html">Прогноз ГПВ на 27 листопада (ОНОВЛЕНО)</a></div><div class="item-footer"><span><i class="fa fa-calendar"></i> 27 Лис 2026</span></div></div></article>
      <article class="item clearfix"><div class="wr"><div class="heading"><a href="/post/prognoz-gpv-na-28-listopada.html">Прогноз ГПВ на 28 листопада</a></div><div class="item-footer"><span><i class="fa fa-calendar"></i> 27 Лис 2026</span></div></div></article>
      <article class="item clearfix"><div class="wr"><div class="heading"><a href="/post/prognoz-gpv-na-20-listopada.html">Прогноз ГПВ на 20 листопада</a></div><div class="item-footer"><span><i class="fa fa-calendar"></i> 19 Лис 2026</span></div></div></article>
    </div></body></html>`;

    const post28 = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» 28.11.2026 р. на Хмельниччині будуть застосовані графіки (ГПВ).</p>
      <p>Підчерга 1.1 – 12:00-16:00.</p></div>`;
    const post20 = `<div class="post"><p>На 20 листопада</p><p>Підчерга 1.1 – 00:00-02:00.</p></div>`;

    const { fetcher } = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, TODAY_HTML),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, newsListing),
      "https://hoe.com.ua/post/prognoz-gpv-na-27-listopada.html": okPage(
        "https://hoe.com.ua/post/prognoz-gpv-na-27-listopada.html",
        TODAY_HTML,
      ),
      "https://hoe.com.ua/post/prognoz-gpv-na-28-listopada.html": okPage(
        "https://hoe.com.ua/post/prognoz-gpv-na-28-listopada.html",
        post28,
      ),
      "https://hoe.com.ua/post/prognoz-gpv-na-20-listopada.html": okPage(
        "https://hoe.com.ua/post/prognoz-gpv-na-20-listopada.html",
        post20,
      ),
    });

    const res = await new SyncOrchestrator(
      fetcher,
      extractor,
      store,
      new FixedKyivClock("2026-11-27T20:00:00+02:00"),
    ).runSync();

    expect(res.outcome).toBe("SCHEDULE_UPDATED");
    expect(store.days.has("2026-11-27")).toBe(true);
    expect(store.days.has("2026-11-28")).toBe(true);
    expect(store.days.get("2026-11-28")?.queues["1.1"].intervals).toEqual([[720, 960]]);
    // Old news post 2026-11-20 MUST NOT be ingested into store!
    expect(store.days.has("2026-11-20")).toBe(false);
  });

  it("runs cleanly on live main_page + news_page fixtures", async () => {
    const store = new InMemoryScheduleStore();
    const { fetcher } = mapFetcher({
      [MAIN_SCHEDULE_URL]: okPage(MAIN_SCHEDULE_URL, FIXTURE_HTML.mainPage),
      [NEWS_LISTING_URL]: okPage(NEWS_LISTING_URL, FIXTURE_HTML.newsPage),
    });

    // At 2026-11-26, main_page has today (26.11) AND tomorrow (27.11) -> shouldn't even need news!
    const res = await new SyncOrchestrator(
      fetcher,
      extractor,
      store,
      new FixedKyivClock("2026-11-26T23:50:00+02:00"),
    ).runSync();

    expect(res.outcome).toBe("SCHEDULE_UPDATED");
    expect([...store.days.keys()].sort()).toEqual(["2026-11-26", "2026-11-27"]);
    expect(store.days.get("2026-11-26")?.revisionCount).toBe(2);
    expect(store.days.get("2026-11-27")?.queues["1.1"].offMinutes).toBe(600);
  });
});
