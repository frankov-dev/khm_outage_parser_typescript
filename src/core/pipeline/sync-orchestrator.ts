import { buildApiSnapshots, MAX_HISTORY_DAYS, needsDayRollover } from "../export/snapshot-builder";
import { parseScheduleBlock, type ParsedBlock } from "../parsing/block-parser";
import type { Clock } from "../ports/clock";
import type { HtmlExtractor } from "../ports/html-extractor";
import type { HttpFetcher } from "../ports/http-fetcher";
import type { ScheduleStore } from "../ports/schedule-store";
import { extractRawBlocks } from "../scraping/block-splitter";
import { filterNewsScheduleCandidates } from "../scraping/news-filter";
import type {
  DateIso,
  DaySchedule,
  RunOutcome,
  ScrapeRunRecord,
  SyncResult,
  SyncStateRecord,
  TimestampIso,
} from "../types/domain";
import type { ExtractedNewsListing, ExtractedSchedulePage, RawScheduleBlock } from "../types/extracted";
import { validateDaySchedule } from "../validation/validator";
import { computeDataHash, computeStateHash, sha256Hex16 } from "../versioning/schedule-differ";
import { mergeDayVersions } from "../versioning/version-merger";

export const MAIN_SCHEDULE_URL = "https://hoe.com.ua/page/pogodinni-vidkljuchennja";
export const NEWS_LISTING_URL = "https://hoe.com.ua/post/novini-kompaniji";
export const PARSER_VERSION = "1.0.0";

export interface SyncOrchestratorOptions {
  mainUrl?: string;
  newsUrl?: string;
  maxHistoryDays?: number;
  checkNewsForUpdates?: boolean;
  parserVersion?: string;
}

function isHealthyOutcome(outcome: RunOutcome): boolean {
  return (
    outcome === "SCHEDULE_UPDATED" ||
    outcome === "SCHEDULE_UNCHANGED" ||
    outcome === "DAY_ROLLOVER" ||
    outcome === "NO_OUTAGES_SCHEDULED" ||
    outcome === "NO_SCHEDULE"
  );
}

function pageMentionsSubqueues(page: ExtractedSchedulePage): boolean {
  return page.sections.some((sec) =>
    sec.lines.some((line) => {
      const lower = line.toLowerCase();
      return lower.includes("підчерг") || lower.includes("підчерзі");
    }),
  );
}

export class SyncOrchestrator {
  private readonly mainUrl: string;
  private readonly newsUrl: string;
  private readonly maxHistoryDays: number;
  private readonly checkNewsForUpdates: boolean;
  private readonly parserVersion: string;

  constructor(
    private readonly fetcher: HttpFetcher,
    private readonly extractor: HtmlExtractor,
    private readonly store: ScheduleStore,
    private readonly clock: Clock,
    options: SyncOrchestratorOptions = {},
  ) {
    this.mainUrl = options.mainUrl ?? MAIN_SCHEDULE_URL;
    this.newsUrl = options.newsUrl ?? NEWS_LISTING_URL;
    this.maxHistoryDays = options.maxHistoryDays ?? MAX_HISTORY_DAYS;
    this.checkNewsForUpdates = options.checkNewsForUpdates ?? true;
    this.parserVersion = options.parserVersion ?? PARSER_VERSION;
  }

  async runSync(): Promise<SyncResult> {
    const startedMs = this.clock.now().getTime();
    const startedAt = this.clock.kyivNow().isoTimestamp;
    const todayDate = this.clock.kyivToday();
    const tomorrowDate = this.clock.kyivTomorrow();
    const pruneBeforeDate = this.clock.kyivAddDays(-(this.maxHistoryDays - 1));

    const finishContext = (): { finishedAt: TimestampIso; durationMs: number } => {
      const finishedAt = this.clock.kyivNow().isoTimestamp;
      const durationMs = Math.max(0, this.clock.now().getTime() - startedMs);
      return { finishedAt, durationMs };
    };

    const syncState = await this.store.getSyncState();
    const rolloverNeeded = needsDayRollover(syncState, todayDate, tomorrowDate);

    const recordFailure = async (
      outcome: "FETCH_ERROR" | "PARSE_ERROR" | "INCOMPLETE_DATA",
      httpStatus: number | null,
      errorCode: string,
      errorMessage: string,
      datesParsed: DateIso[] = [],
    ): Promise<SyncResult> => {
      const { finishedAt, durationMs } = finishContext();
      const runRecord: ScrapeRunRecord = {
        startedAt,
        finishedAt,
        outcome,
        httpStatus,
        datesParsed,
        errorCode,
        errorMessage,
        durationMs,
      };
      await this.store.recordNoOpOrFailure(
        {
          lastCheckedAt: finishedAt,
          lastOutcome: outcome,
          consecutiveFailures: (syncState?.consecutiveFailures ?? 0) + 1,
        },
        runRecord,
        pruneBeforeDate,
      );
      return { outcome, httpStatus, errorCode, errorMessage, durationMs };
    };

    const mainFetch = await this.fetcher.fetchHtml(this.mainUrl);
    if (!mainFetch.ok) {
      return recordFailure(
        "FETCH_ERROR",
        mainFetch.status,
        mainFetch.errorCode,
        mainFetch.errorMessage,
      );
    }

    const mainPage = await this.extractor.extractSchedulePage(mainFetch.html, this.mainUrl);
    if (!mainPage.hasExpectedContainer) {
      return recordFailure(
        "PARSE_ERROR",
        mainFetch.status,
        "MISSING_CONTENT_CONTAINER",
        "Expected div.post container was not found on main page",
      );
    }

    const mainIrHash = await sha256Hex16(`${this.parserVersion}|${JSON.stringify(mainPage)}`);

    let cachedListing: ExtractedNewsListing | null = null;
    let cachedNewsIrHash: string | null = syncState?.newsIrHash ?? null;

    const loadNewsListing = async (): Promise<{
      listing: ExtractedNewsListing;
      newsIrHash: string;
    } | null> => {
      if (cachedListing && cachedNewsIrHash) {
        return { listing: cachedListing, newsIrHash: cachedNewsIrHash };
      }
      const newsFetch = await this.fetcher.fetchHtml(this.newsUrl);
      if (!newsFetch.ok) return null;
      const listing = await this.extractor.extractNewsListing(newsFetch.html, this.newsUrl);
      const newsIrHash = await sha256Hex16(
        `${this.parserVersion}|${JSON.stringify(listing.items.slice(0, 5))}`,
      );
      cachedListing = listing;
      cachedNewsIrHash = newsIrHash;
      return { listing, newsIrHash };
    };

    // Two-tier IR fast path: skips regex parsing, merging, validation and snapshot building when unchanged.
    if (
      syncState !== null &&
      !rolloverNeeded &&
      syncState.parserVersion === this.parserVersion &&
      syncState.mainIrHash === mainIrHash &&
      isHealthyOutcome(syncState.lastOutcome)
    ) {
      const tomorrowStored = (await this.store.getDaysByDates([tomorrowDate])).length > 0;
      let canShortCircuit = tomorrowStored || !this.checkNewsForUpdates;
      let fastNewsHash: string | undefined;

      if (!canShortCircuit) {
        const newsLoaded = await loadNewsListing();
        if (newsLoaded && newsLoaded.newsIrHash === syncState.newsIrHash) {
          canShortCircuit = true;
          fastNewsHash = newsLoaded.newsIrHash;
        }
      }

      if (canShortCircuit) {
        const { finishedAt, durationMs } = finishContext();
        await this.store.recordNoOpOrFailure(
          {
            lastCheckedAt: finishedAt,
            lastOutcome: "SCHEDULE_UNCHANGED",
            consecutiveFailures: 0,
            ...(fastNewsHash !== undefined ? { newsIrHash: fastNewsHash } : {}),
          },
          {
            startedAt,
            finishedAt,
            outcome: "SCHEDULE_UNCHANGED",
            httpStatus: mainFetch.status,
            datesParsed: [],
            errorCode: null,
            errorMessage: null,
            durationMs,
          },
          pruneBeforeDate,
        );
        return { outcome: "SCHEDULE_UNCHANGED", durationMs };
      }
    }

    const mainBlocks = extractRawBlocks(mainPage, todayDate);
    const mainHasSubqueues = pageMentionsSubqueues(mainPage);
    const allRawBlocks: RawScheduleBlock[] = [...mainBlocks];

    if (mainBlocks.length === 0 && !mainHasSubqueues) {
      const newsLoaded = await loadNewsListing();
      if (newsLoaded) {
        const candidates = filterNewsScheduleCandidates(newsLoaded.listing, 3);
        let fallbackBlocks: RawScheduleBlock[] = [];
        for (const candidate of candidates) {
          const postFetch = await this.fetcher.fetchHtml(candidate.url);
          if (!postFetch.ok) continue;
          const postPage = await this.extractor.extractSchedulePage(postFetch.html, candidate.url);
          const extracted = extractRawBlocks(postPage, todayDate);
          if (extracted.length > 0) {
            fallbackBlocks = extracted;
            break;
          }
        }
        const currentOrFuture = fallbackBlocks.filter((b) => b.date >= todayDate);
        allRawBlocks.push(...(currentOrFuture.length > 0 ? currentOrFuture : fallbackBlocks));
      }
    } else if (mainBlocks.length > 0 && this.checkNewsForUpdates) {
      const mainDates = new Set(mainBlocks.map((b) => b.date));
      if (!mainDates.has(tomorrowDate)) {
        const newsLoaded = await loadNewsListing();
        if (newsLoaded) {
          const candidates = filterNewsScheduleCandidates(newsLoaded.listing, 2);
          for (const candidate of candidates) {
            const postFetch = await this.fetcher.fetchHtml(candidate.url);
            if (!postFetch.ok) continue;
            const postPage = await this.extractor.extractSchedulePage(postFetch.html, candidate.url);
            const extracted = extractRawBlocks(postPage, todayDate);
            for (const block of extracted) {
              if (block.date >= todayDate && !mainDates.has(block.date)) {
                allRawBlocks.push(block);
              }
            }
          }
        }
      }
    }

    // Valid page with zero schedule blocks -> distinguish PARSE_ERROR vs genuine NO_SCHEDULE.
    if (allRawBlocks.length === 0) {
      if (mainHasSubqueues) {
        return recordFailure(
          "PARSE_ERROR",
          mainFetch.status,
          "NO_BLOCKS_EXTRACTED",
          "Subqueue keywords found on main page but no blocks could be extracted",
        );
      }

      const { finishedAt, durationMs } = finishContext();
      const runRecord: ScrapeRunRecord = {
        startedAt,
        finishedAt,
        outcome: "NO_SCHEDULE",
        httpStatus: mainFetch.status,
        datesParsed: [],
        errorCode: null,
        errorMessage: null,
        durationMs,
      };

      if (rolloverNeeded) {
        const existingAll = (await this.store.getAllDays(this.maxHistoryDays)).filter(
          (d) => d.date >= pruneBeforeDate,
        );
        const dataHash = await computeDataHash(existingAll);
        const stateHash = await computeStateHash(dataHash, todayDate, tomorrowDate);
        const snapshots = buildApiSnapshots({
          days: existingAll,
          sourceUrl: this.mainUrl,
          todayDate,
          tomorrowDate,
          updatedAt: finishedAt,
          checkedAt: finishedAt,
          stateHash,
          dataHash,
          maxDays: this.maxHistoryDays,
        });
        const nextState: SyncStateRecord = {
          parserVersion: this.parserVersion,
          mainIrHash,
          newsIrHash: cachedNewsIrHash,
          stateHash,
          dataHash,
          todayDate,
          tomorrowDate,
          lastSuccessAt: finishedAt,
          lastCheckedAt: finishedAt,
          lastOutcome: "NO_SCHEDULE",
          consecutiveFailures: 0,
        };
        await this.store.commitSync({
          upsertedDays: [],
          snapshots,
          syncState: nextState,
          runRecord,
          pruneBeforeDate,
        });
      } else {
        await this.store.recordNoOpOrFailure(
          {
            lastCheckedAt: finishedAt,
            lastOutcome: "NO_SCHEDULE",
            consecutiveFailures: 0,
            mainIrHash,
            newsIrHash: cachedNewsIrHash,
          },
          runRecord,
          pruneBeforeDate,
        );
      }

      return { outcome: "NO_SCHEDULE", durationMs };
    }

    // Parse & group blocks by date preserving page order (newest first).
    const blocksByDate = new Map<DateIso, { blocks: ParsedBlock[]; sourceUrl: string }>();
    for (const raw of allRawBlocks) {
      const parsed = parseScheduleBlock(raw);
      if (parsed.queues === null && parsed.unappliedChanges.length === 0) continue;
      const entry = blocksByDate.get(parsed.date);
      if (entry) entry.blocks.push(parsed);
      else blocksByDate.set(parsed.date, { blocks: [parsed], sourceUrl: raw.sourceUrl });
    }

    if (blocksByDate.size === 0) {
      return recordFailure(
        "PARSE_ERROR",
        mainFetch.status,
        "NO_USABLE_QUEUES",
        "Blocks were extracted but no valid subqueues or operational changes could be parsed",
      );
    }

    const datesParsed = [...blocksByDate.keys()];
    const existingList = await this.store.getDaysByDates(datesParsed);
    const existingByDate = new Map(existingList.map((d) => [d.date, d] as const));

    const mergedTimestamp = this.clock.kyivNow().isoTimestamp;
    const validatedDays: DaySchedule[] = [];
    const changedDays: DaySchedule[] = [];

    for (const [date, group] of blocksByDate) {
      const existingDay = existingByDate.get(date) ?? null;
      const merged = await mergeDayVersions({
        date,
        blocksNewestFirst: group.blocks,
        existingDay,
        sourceUrl: group.sourceUrl,
        recordedAt: mergedTimestamp,
      });
      if (!merged.ok) {
        const outcome = merged.errorCode === "ORPHAN_DELTA_WITHOUT_BASE" ? "INCOMPLETE_DATA" : "PARSE_ERROR";
        return recordFailure(outcome, mainFetch.status, merged.errorCode, merged.errorMessage, datesParsed);
      }

      const validated = validateDaySchedule(merged.day, {
        todayDate,
        existingDay,
        hasExplicitCancellation: merged.hasExplicitCancellation,
      });
      if (!validated.ok) {
        return recordFailure(
          "INCOMPLETE_DATA",
          mainFetch.status,
          validated.code,
          validated.message,
          datesParsed,
        );
      }

      validatedDays.push(validated.day);
      if (merged.changedFromExisting) changedDays.push(validated.day);
    }

    if (changedDays.length === 0 && !rolloverNeeded && syncState !== null) {
      const { finishedAt, durationMs } = finishContext();
      await this.store.recordNoOpOrFailure(
        {
          lastCheckedAt: finishedAt,
          lastOutcome: "SCHEDULE_UNCHANGED",
          consecutiveFailures: 0,
          mainIrHash,
          newsIrHash: cachedNewsIrHash,
        },
        {
          startedAt,
          finishedAt,
          outcome: "SCHEDULE_UNCHANGED",
          httpStatus: mainFetch.status,
          datesParsed,
          errorCode: null,
          errorMessage: null,
          durationMs,
        },
        pruneBeforeDate,
      );
      return { outcome: "SCHEDULE_UNCHANGED", durationMs };
    }

    const { finishedAt, durationMs } = finishContext();
    const existingAll = await this.store.getAllDays(this.maxHistoryDays);
    const mergedMap = new Map<DateIso, DaySchedule>(existingAll.map((d) => [d.date, d] as const));
    for (const day of validatedDays) mergedMap.set(day.date, day);

    const retainedDays = [...mergedMap.values()]
      .filter((d) => d.date >= pruneBeforeDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, this.maxHistoryDays);

    const dataHash = await computeDataHash(retainedDays);
    const stateHash = await computeStateHash(dataHash, todayDate, tomorrowDate);
    const snapshots = buildApiSnapshots({
      days: retainedDays,
      sourceUrl: this.mainUrl,
      todayDate,
      tomorrowDate,
      updatedAt: finishedAt,
      checkedAt: finishedAt,
      stateHash,
      dataHash,
      maxDays: this.maxHistoryDays,
    });

    const outcome: "SCHEDULE_UPDATED" | "DAY_ROLLOVER" | "NO_OUTAGES_SCHEDULED" =
      changedDays.length === 0 && rolloverNeeded
        ? "DAY_ROLLOVER"
        : changedDays.length > 0 && changedDays.every((d) => d.status === "NO_OUTAGES")
          ? "NO_OUTAGES_SCHEDULED"
          : "SCHEDULE_UPDATED";

    const nextState: SyncStateRecord = {
      parserVersion: this.parserVersion,
      mainIrHash,
      newsIrHash: cachedNewsIrHash,
      stateHash,
      dataHash,
      todayDate,
      tomorrowDate,
      lastSuccessAt: finishedAt,
      lastCheckedAt: finishedAt,
      lastOutcome: outcome,
      consecutiveFailures: 0,
    };

    const runRecord: ScrapeRunRecord = {
      startedAt,
      finishedAt,
      outcome,
      httpStatus: mainFetch.status,
      datesParsed,
      errorCode: null,
      errorMessage: null,
      durationMs,
    };

    await this.store.commitSync({
      upsertedDays: changedDays,
      snapshots,
      syncState: nextState,
      runRecord,
      pruneBeforeDate,
    });

    return { outcome, datesUpdated: changedDays.map((d) => d.date), durationMs };
  }
}
