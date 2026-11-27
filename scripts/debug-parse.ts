import { readFileSync } from "node:fs";
import path from "node:path";
import { CheerioHtmlExtractor } from "../src/adapters/html/cheerio-extractor";
import { FetchHttpClient } from "../src/adapters/http/fetch-http-client";
import { buildApiSnapshots } from "../src/core/export/snapshot-builder";
import { formatMinutesToHHMM, parseScheduleBlock, type ParsedBlock } from "../src/core/parsing";
import { MAIN_SCHEDULE_URL } from "../src/core/pipeline/sync-orchestrator";
import { extractRawBlocks } from "../src/core/scraping";
import { FixedKyivClock, SystemKyivClock } from "../src/core/time";
import { ALL_SUBQUEUES, type DateIso, type DaySchedule } from "../src/core/types/domain";
import { validateDaySchedule } from "../src/core/validation";
import { computeDataHash, computeStateHash, mergeDayVersions } from "../src/core/versioning";

interface CliArgs {
  live: boolean;
  fixture: string;
  date: DateIso | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  let live = false;
  let fixture = "tests/fixtures/html/main_page.html";
  let date: DateIso | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") live = true;
    else if (arg === "--fixture" && argv[i + 1]) fixture = argv[++i]!;
    else if (arg === "--date" && argv[i + 1]) date = argv[++i];
  }
  return { live, fixture, date };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const clock = args.date ? new FixedKyivClock(`${args.date}T12:00:00+02:00`) : new SystemKyivClock();
  const todayDate = clock.kyivToday();
  const tomorrowDate = clock.kyivTomorrow();
  const nowIso = clock.kyivNow().isoTimestamp;

  let url: string;
  let html: string;
  if (args.live) {
    url = MAIN_SCHEDULE_URL;
    const res = await new FetchHttpClient().fetchHtml(url);
    if (!res.ok) throw new Error(`Fetch failed (${res.errorCode}): ${res.errorMessage}`);
    html = res.html;
  } else {
    url = MAIN_SCHEDULE_URL;
    html = readFileSync(path.resolve(args.fixture), "utf8");
  }

  console.log(`Source: ${args.live ? url : args.fixture} (${html.length} chars) | today=${todayDate}`);

  const extractor = new CheerioHtmlExtractor();
  const page = await extractor.extractSchedulePage(html, url);
  console.log(`Container=${page.hasExpectedContainer}, heading=${JSON.stringify(page.heading)}, sections=${page.sections.length}`);

  const rawBlocks = extractRawBlocks(page, todayDate);
  console.log(`Raw schedule blocks extracted: ${rawBlocks.length}`);

  const byDate = new Map<DateIso, ParsedBlock[]>();
  for (const raw of rawBlocks) {
    const parsed = parseScheduleBlock(raw);
    if (parsed.queues === null && parsed.unappliedChanges.length === 0) continue;
    const arr = byDate.get(parsed.date) ?? [];
    arr.push(parsed);
    byDate.set(parsed.date, arr);
  }

  const days: DaySchedule[] = [];
  for (const [date, blocksNewestFirst] of byDate) {
    const merged = await mergeDayVersions({
      date,
      blocksNewestFirst,
      existingDay: null,
      sourceUrl: url,
      recordedAt: nowIso,
    });
    if (!merged.ok) {
      console.error(`[${date}] MERGE FAILED: ${merged.errorCode} — ${merged.errorMessage}`);
      continue;
    }
    const validated = validateDaySchedule(merged.day, {
      todayDate,
      hasExplicitCancellation: merged.hasExplicitCancellation,
    });
    if (!validated.ok) {
      console.error(`[${date}] VALIDATION FAILED: ${validated.code} — ${validated.message}`);
      continue;
    }
    const day = validated.day;
    days.push(day);
    console.log(
      `\n[${day.date}] status=${day.status}, revisions=${day.revisionCount}, hash=${day.contentHash}`,
    );
    if (day.operationalMessage) console.log(`  message: ${day.operationalMessage}`);
    for (const q of ALL_SUBQUEUES) {
      const qs = day.queues[q];
      const fmt = qs.intervals.map(([s, e]) => `${formatMinutesToHHMM(s)}-${formatMinutesToHHMM(e)}`).join("; ");
      console.log(`  ${q}: ${(qs.offMinutes / 60).toFixed(2)}h (${qs.offMinutes}m) -> ${fmt || "no outages"}`);
    }
  }

  const dataHash = await computeDataHash(days);
  const stateHash = await computeStateHash(dataHash, todayDate, tomorrowDate);
  const snapshots = buildApiSnapshots({
    days,
    sourceUrl: url,
    todayDate,
    tomorrowDate,
    updatedAt: nowIso,
    checkedAt: nowIso,
    stateHash,
    dataHash,
  });

  console.log(`\nSnapshots (${snapshots.length} total), dataHash=${dataHash}, stateHash=${stateHash}:`);
  for (const s of snapshots) {
    if (s.key.startsWith("queue:") && s.key !== "queue:1.1") continue;
    console.log(`  ${s.key.padEnd(16)} ${s.body.length} bytes`);
  }
}

await main();
