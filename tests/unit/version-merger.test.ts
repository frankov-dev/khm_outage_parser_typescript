import { describe, expect, it } from "vitest";
import { CheerioHtmlExtractor } from "../../src/adapters/html/cheerio-extractor";
import { mergeOverlappingIntervals } from "../../src/core/normalizing";
import { parseScheduleBlock } from "../../src/core/parsing";
import { extractRawBlocks } from "../../src/core/scraping";
import { ALL_SUBQUEUES, type DaySchedule, type MinuteInterval } from "../../src/core/types/domain";
import {
  mergeDayVersions,
  sanitizeDayRevisions,
  type MergeDayResult,
} from "../../src/core/versioning";
import { validateDaySchedule } from "../../src/core/validation";
import { buildQueuesMap } from "../../src/core/normalizing";
import { makeDay } from "../fixtures/day-factory";
import { FIXTURE_HTML } from "../fixtures/parity-cases";

const extractor = new CheerioHtmlExtractor();
const URL = "https://hoe.com.ua/page/pogodinni-vidkljuchennja";
const T1 = "2026-11-23T10:00:00+02:00";
const T2 = "2026-11-23T23:00:00+02:00";

function t(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
function I(start: string, end: string): MinuteInterval {
  return [t(start), t(end)];
}

async function parsePage(html: string, ref: string) {
  const page = await extractor.extractSchedulePage(html, URL);
  return extractRawBlocks(page, ref).map(parseScheduleBlock);
}

async function mergeHtml(
  html: string,
  date: string,
  existingDay: DaySchedule | null = null,
  recordedAt = T1,
): Promise<MergeDayResult> {
  const blocks = (await parsePage(html, date)).filter((b) => b.date === date);
  return mergeDayVersions({ date, blocksNewestFirst: blocks, existingDay, sourceUrl: URL, recordedAt });
}

async function mergeOk(
  html: string,
  date: string,
  existingDay: DaySchedule | null = null,
  recordedAt = T1,
) {
  const res = await mergeHtml(html, date, existingDay, recordedAt);
  if (!res.ok) throw new Error(`${res.errorCode}: ${res.errorMessage}`);
  return res;
}

const SAMPLE_HTML = `
<div class="post">
  <p>
    За розпорядженням НЕК «Укренерго» 07 листопада на Хмельниччині будуть застосовані графіки погодинних відключень (ГПВ):
    <br/><br/>
    Підчерга 1.1 – 00:00-04:00; 09:00-13:00.
    <br/>
    Підчерга 2.1 – 22:00-24:00.
  </p>
</div>`;

function twelveQueues(interval: string): string {
  const lines = ALL_SUBQUEUES.map((q) => `Підчерга ${q} – ${interval}.`);
  return lines.join("<br/>");
}

describe("mergeDayVersions — basic days", () => {
  it("builds a single-revision day from one block", async () => {
    const { day, changedFromExisting } = await mergeOk(SAMPLE_HTML, "2026-11-07");
    expect(changedFromExisting).toBe(true);
    expect(day.status).toBe("ACTIVE");
    expect(day.queues["1.1"]).toEqual({ intervals: [I("00:00", "04:00"), I("09:00", "13:00")], offMinutes: 480 });
    expect(day.queues["2.1"].offMinutes).toBe(120);
    expect(day.queues["1.2"]).toEqual({ intervals: [], offMinutes: 0 });
    expect(day.revisionCount).toBe(1);
    expect(day.changedQueues).toEqual([]);
    expect(day.updatedAt).toBe(T1);
    expect(day.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("archives the older <hr> block as an earlier revision with a sparse diff", async () => {
    const html = `
    <div class="post">
      <p>Графік на 07 листопада (оновлений):</p><p>Підчерга 1.1 – 10:00-14:00</p>
      <hr>
      <p>Графік на 07 листопада (початковий):</p><p>Підчерга 1.1 – 00:00-02:00</p>
    </div>`;
    const { day } = await mergeOk(html, "2026-11-07");
    expect(day.queues["1.1"].intervals).toEqual([I("10:00", "14:00")]);
    expect(day.revisionCount).toBe(2);
    expect(day.revisions[0]?.operationalMessage).toBe("Графік на 07 листопада (початковий):");
    expect(day.revisions[0]?.fullQueues["1.1"].intervals).toEqual([I("00:00", "02:00")]);
    expect(day.revisions[1]?.revNo).toBe(2);
    expect(Object.keys(day.revisions[1]?.changedQueues ?? {})).toEqual(["1.1"]);
    expect(day.changedQueues).toEqual(["1.1"]);
  });

  it("is idempotent: the same page produces an identical day and keeps updatedAt", async () => {
    const first = await mergeOk(SAMPLE_HTML, "2026-11-07", null, T1);
    const second = await mergeOk(SAMPLE_HTML, "2026-11-07", first.day, T2);
    expect(second.changedFromExisting).toBe(false);
    expect(second.day).toEqual(first.day);
    expect(second.day.updatedAt).toBe(T1);
  });

  it("archives the previous version when a single block is edited in place", async () => {
    const first = await mergeOk(SAMPLE_HTML, "2026-11-07", null, T1);
    const edited = SAMPLE_HTML.replace("22:00-24:00", "21:00-24:00");
    const second = await mergeOk(edited, "2026-11-07", first.day, T2);
    expect(second.changedFromExisting).toBe(true);
    expect(second.day.queues["2.1"].offMinutes).toBe(180);
    expect(second.day.revisionCount).toBe(2);
    expect(second.day.revisions[0]?.fullQueues["2.1"].offMinutes).toBe(120);
    expect(second.day.updatedAt).toBe(T2);
    expect(second.day.revisions[0]?.recordedAt).toBe(T1);

    // A third identical run must keep the archived revision (stable history).
    const third = await mergeOk(edited, "2026-11-07", second.day, "2026-11-24T00:00:00+02:00");
    expect(third.changedFromExisting).toBe(false);
    expect(third.day.revisionCount).toBe(2);
  });
});

describe("mergeDayVersions — legacy real-world scenarios", () => {
  const html2311 = `
  <div class="post">
    <p>За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 23 листопада (оновлено з 21:30).</p>
    <p>Додатково години відсутності електроенергії:</p>
    <p>Підчерга 5.2 – 22:00-24:00.<br/>Підчерга 6.2 – 22:00-24:00.</p>
    <hr/>
    <p>За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 23 листопада (оновлено з 20:00).</p>
    <p>Підчерга 1.1 – 18:00-22:00.<br/>Підчерга 1.2 – 17:00-21:00.<br/>
       Підчерга 2.1 – 21:00-24:00.<br/>Підчерга 2.2 – 22:00-24:00.<br/>
       Підчерга 3.1 – 15:00-20:00.<br/>Підчерга 3.2 – 15:00-20:00.<br/>
       Підчерга 4.1 – 19:00-22:00.<br/>Підчерга 4.2 – 19:00-22:00.<br/>
       Підчерга 5.1 – 20:00-24:00.<br/>Підчерга 5.2 – без відключень.<br/>
       Підчерга 6.1 – 20:00-22:00.<br/>Підчерга 6.2 – без відключень.</p>
    <hr/>
    <p>За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 23 листопада (оновлено з 11:00).</p>
    <p>Підчерга 1.1 – 10:00-15:00; 18:00-22:00.<br/>Підчерга 1.2 – 10:00-14:00; 17:00-20:00.<br/>
       Підчерга 2.1 – 10:00-14:00; 17:00-20:00; 22:00-24:00.<br/>Підчерга 2.2 – 08:00-12:00; 16:00-19:00; 22:00-24:00.<br/>
       Підчерга 3.1 – 11:00-13:00; 15:00-20:00.<br/>Підчерга 3.2 – 11:00-13:00; 15:00-20:00.<br/>
       Підчерга 4.1 – 10:00-15:00; 19:00-22:00.<br/>Підчерга 4.2 – 12:00-16:00; 19:00-22:00.<br/>
       Підчерга 5.1 – 06:00-10:00; 14:00-18:00; 22:00-24:00.<br/>Підчерга 5.2 – 07:00-10:00; 13:00-17:00.<br/>
       Підчерга 6.1 – 06:00-10:00; 13:00-17:00; 20:00-22:00.<br/>Підчерга 6.2 – 07:00-10:00; 14:00-19:00.</p>
  </div>`;

  it("merges full → tail → additive delta chronologically (23.11.2026)", async () => {
    const { day } = await mergeOk(html2311, "2026-11-23");
    const q = day.queues;
    expect(q["2.1"].intervals).toEqual([I("10:00", "14:00"), I("17:00", "20:00"), I("21:00", "24:00")]);
    expect(q["5.1"].intervals).toEqual([I("06:00", "10:00"), I("14:00", "18:00"), I("20:00", "24:00")]);
    expect(q["1.2"].intervals).toEqual([I("10:00", "14:00"), I("17:00", "21:00")]);
    expect(q["5.2"].intervals).toEqual([I("07:00", "10:00"), I("13:00", "17:00"), I("22:00", "24:00")]);
    expect(q["5.2"].offMinutes).toBe(9 * 60);
    expect(q["6.2"].intervals).toEqual([I("07:00", "10:00"), I("14:00", "19:00"), I("22:00", "24:00")]);
    expect(q["6.2"].offMinutes).toBe(10 * 60);

    expect(day.revisionCount).toBe(3);
    expect(day.revisions[0]?.operationalMessage).toContain("11:00");
    expect(day.revisions[1]?.operationalMessage).toContain("20:00");
    expect(day.revisions[2]?.operationalMessage).toContain("21:30");
    expect(day.operationalMessage).not.toMatch(/:\s*$/);
    expect(day.changedQueues).toEqual(["5.2", "6.2"]);
  });

  it("applies a standalone delta on top of the stored day and stays idempotent", async () => {
    const baseHtml = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» 23.11.2026 р. будуть застосовані графіки (ГПВ).</p>
      <p>Підчерга 1.1 – 10:00-14:00.<br/>Підчерга 5.2 – 07:00-10:00.</p></div>`;
    const deltaHtml = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 21:30).</p>
      <p>Додатково години відсутності електроенергії:</p>
      <p>Підчерга 5.2 – 22:00-24:00.</p></div>`;

    const base = await mergeOk(baseHtml, "2026-11-23", null, T1);
    const applied = await mergeOk(deltaHtml, "2026-11-23", base.day, T2);
    expect(applied.day.queues["1.1"].intervals).toEqual([I("10:00", "14:00")]);
    expect(applied.day.queues["5.2"].intervals).toEqual([I("07:00", "10:00"), I("22:00", "24:00")]);
    expect(applied.day.revisionCount).toBe(2);

    const again = await mergeOk(deltaHtml, "2026-11-23", applied.day, "2026-11-23T23:30:00+02:00");
    expect(again.changedFromExisting).toBe(false);
    expect(again.day).toEqual(applied.day);

    const editedDelta = deltaHtml.replace(
      "<p>Підчерга 5.2 – 22:00-24:00.</p>",
      "<p>Підчерга 5.2 – 22:00-24:00.<br/>Підчерга 6.2 – 22:00-24:00.</p>",
    );
    const edited = await mergeOk(editedDelta, "2026-11-23", applied.day, "2026-11-23T23:40:00+02:00");
    expect(edited.day.queues["5.2"].intervals).toEqual([I("07:00", "10:00"), I("22:00", "24:00")]);
    expect(edited.day.queues["6.2"].intervals).toEqual([I("22:00", "24:00")]);
    expect(edited.day.queues["1.1"].intervals).toEqual([I("10:00", "14:00")]);
    expect(edited.day.revisions[0]?.operationalMessage).toContain("23.11.2026");
  });

  it("replaces a stale stored revision when it is recomputed from the page", async () => {
    const stale = await makeDay({
      date: "2026-11-23",
      intervals: {},
      message:
        "За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 21:30).\nДодатково години відсутності електроенергії:",
    });
    const staleRev = {
      revNo: 1,
      operationalMessage:
        "За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 20:00).",
      changedQueues: {},
      fullQueues: buildQueuesMap(new Map([["1.1", [I("18:00", "22:00")]]])),
      recordedAt: T1,
    };
    const existing: DaySchedule = {
      ...stale,
      revisionCount: 2,
      revisions: [staleRev, { ...stale.revisions[0]!, revNo: 2 }],
    };

    const html = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 21:30).</p>
      <p>Додатково години відсутності електроенергії:</p>
      <p>Підчерга 5.2 – 22:00-24:00.</p>
      <hr/>
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 20:00).</p>
      <p>Підчерга 1.1 – 18:00-22:00.<br/>Підчерга 5.2 – без відключень.</p>
      <hr/>
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 11:00).</p>
      <p>Підчерга 1.1 – 10:00-15:00; 18:00-22:00.<br/>Підчерга 5.2 – 07:00-10:00.</p></div>`;
    const { day } = await mergeOk(html, "2026-11-23", existing, T2);
    // 11:00 and 20:00 produce identical effective queues here (1.1 = 9h, 5.2 = 3h), so
    // deduplication collapses them into 1 clean revision + the 21:30 delta = 2 revisions,
    // while dropping the stale corrupted 4.0h revision.
    expect(day.revisionCount).toBe(2);
    expect(day.revisions[0]?.fullQueues["1.1"].offMinutes).toBe(9 * 60);
    expect(day.revisions[1]?.fullQueues["5.2"].offMinutes).toBe(5 * 60);
    expect(validateDaySchedule(day, { todayDate: "2026-11-23" }).ok).toBe(true);
  });

  it("keeps unmentioned queues for a plural 'Додаткові години' delta with six queues", async () => {
    const html = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 24 листопада (оновлено з\u00A0 20:00).</p>
      <p>Додаткові\u00A0години відсутності електроенергії:</p>
      <p>Підчерга 1.1 - 22:00-24:00.<br/>Підчерга 1.2 - 22:00-24:00.<br/>
         Підчерга 2.1 - 20:00-22:00.<br/>Підчерга 3.1 - 20:00-22:00.<br/>
         Підчерга 4.1 - 20:00-22:00.<br/>Підчерга 4.2\u00A0- 22:00-00:00.</p>
      <hr/>
      <p>За розпорядженням НЕК «Укренерго» 24.11.2026 р. на Хмельниччині будуть застосовані графіки погодинних відключень (ГПВ).</p>
      <p>Підчерга 1.1 – 04:00-07:00.<br/>Підчерга 1.2 – 01:00-04:00.<br/>
         Підчерга 2.1 – 12:00-17:00.<br/>Підчерга 2.2 – 12:00-17:00.<br/>
         Підчерга 3.1 – 06:00-10:00.<br/>Підчерга 3.2 – 06:00-10:00.<br/>
         Підчерга 4.1 – 06:00-10:00.<br/>Підчерга 4.2 – 07:00-12:00; 16:00-20:00.<br/>
         Підчерга 5.1 – 16:00-20:00.<br/>Підчерга 5.2 – 17:00-20:00.<br/>
         Підчерга 6.1 – 22:00-24:00.<br/>Підчерга 6.2 – 18:00-22:00.</p></div>`;
    const { day } = await mergeOk(html, "2026-11-24");
    expect(day.queues["4.2"].intervals).toEqual([I("07:00", "12:00"), I("16:00", "20:00"), I("22:00", "24:00")]);
    expect(day.queues["4.2"].offMinutes).toBe(11 * 60);
    expect(day.queues["6.1"].intervals).toEqual([I("22:00", "24:00")]);
    expect(day.queues["6.2"].intervals).toEqual([I("18:00", "22:00")]);
  });

  const tailHtml = `<div class="post">
    <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 20:00).</p>
    <p>Підчерга 1.1 – без відключень.<br/>Підчерга 1.2 – 20:00-23:00.<br/>
       Підчерга 2.1 – 20:00-22:00.<br/>Підчерга 2.2 – 20:00-22:00.<br/>
       Підчерга 3.1 – 20:00-22:00.<br/>Підчерга 3.2 – 20:00-22:00.</p>
    <hr/>
    <p>За розпорядженням НЕК «Укренерго» 23.11.2026 р. будуть застосовані графіки (ГПВ).</p>
    <p>Підчерга 1.1 – 10:00-13:00; 18:00-22:00.<br/>Підчерга 1.2 – 18:00-21:00.<br/>
       Підчерга 2.1 – 10:00-12:00.<br/>Підчерга 2.2 – 10:00-12:00.<br/>
       Підчерга 3.1 – 10:00-12:00.<br/>Підчерга 3.2 – 10:00-12:00.</p></div>`;

  it("tail update truncates a spanning interval that is cancelled from the cutoff", async () => {
    const { day } = await mergeOk(tailHtml, "2026-11-23");
    expect(day.queues["1.1"]).toEqual({ intervals: [I("10:00", "13:00"), I("18:00", "20:00")], offMinutes: 300 });
  });

  it("regression #2: a tail update keeps the part of a spanning interval before the cutoff", async () => {
    const { day } = await mergeOk(tailHtml, "2026-11-23");
    // base 18:00-21:00 + update 20:00-23:00 from 20:00 → 18:00-23:00 (legacy lost 18:00-20:00)
    expect(day.queues["1.2"]).toEqual({ intervals: [I("18:00", "23:00")], offMinutes: 300 });
  });
});

describe("mergeDayVersions — news vs main revisions", () => {
  it("does not duplicate a stored revision that the page now provides under another wording", async () => {
    const qInit = buildQueuesMap(new Map([["1.1", [I("10:00", "12:00")]]]));
    const q2320 = buildQueuesMap(new Map([["1.1", [I("10:00", "12:00"), I("22:00", "24:00")]]]));
    const base = await makeDay({ date: "2026-11-24", intervals: { "1.1": [I("10:00", "12:00"), I("22:00", "24:00")] } });
    const existing: DaySchedule = {
      ...base,
      operationalMessage: "Оновлено на 24 листопада (оновлено 23:20).",
      revisionCount: 2,
      revisions: [
        { revNo: 1, operationalMessage: "Графік 24.11.2026.", changedQueues: {}, fullQueues: qInit, recordedAt: T1 },
        { revNo: 2, operationalMessage: "Оновлено на 24 листопада (оновлено 23:20).", changedQueues: {}, fullQueues: q2320, recordedAt: T1 },
      ],
    };
    const html = `<div class="post">
      <p>Оновлено на 24 листопада (оновлено з 20:00).</p>
      <p>Додаткові години відсутності електроенергії:</p>
      <p>Підчерга 2.1 – 20:00-22:00.</p>
      <hr/>
      <p>Оновлено на 24 листопада (оновлено 23:20, 23.11.2026).</p>
      <p>Підчерга 1.1 – 10:00-12:00; 22:00-24:00.</p>
      <hr/>
      <p>Графік 24.11.2026.</p>
      <p>Підчерга 1.1 – 10:00-12:00.</p></div>`;
    const { day } = await mergeOk(html, "2026-11-24", existing, T2);
    expect(day.revisionCount).toBe(3);
    expect(day.revisions[0]?.operationalMessage).toBe("Графік 24.11.2026.");
    expect(day.revisions[1]?.operationalMessage).toContain("23:20, 23.11.2026");
    expect(day.queues["2.1"].intervals).toEqual([I("20:00", "22:00")]);
    expect(day.queues["1.1"].intervals).toEqual([I("10:00", "12:00"), I("22:00", "24:00")]);
  });

  it("sanitizeDayRevisions removes stale duplicates of the active queues", async () => {
    const day = await makeDay({ date: "2026-11-22", intervals: { "1.1": [I("10:00", "12:00")] }, message: "Графік 22.11.2026." });
    const duplicated: DaySchedule = {
      ...day,
      revisionCount: 2,
      revisions: [
        { ...day.revisions[0]!, operationalMessage: "Графік 22.11.2026 (дубль)." },
        { ...day.revisions[0]!, revNo: 2 },
      ],
    };
    const cleaned = await sanitizeDayRevisions(duplicated);
    expect(cleaned.revisionCount).toBe(1);
    expect(cleaned.revisions).toHaveLength(1);
    expect(cleaned.changedQueues).toEqual([]);
  });
});

describe("mergeDayVersions — regressions over the Python exporter", () => {
  const fullDay = `<div class="post">
    <p>За розпорядженням НЕК «Укренерго» 23.11.2026 р. будуть застосовані графіки (ГПВ).</p>
    <p>${twelveQueues("10:00-12:00")}</p></div>`;

  it("#3A: a partial cancellation clears only the cancelled queues", async () => {
    const base = await mergeOk(fullDay, "2026-11-23", null, T1);
    const cancelHtml = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада.</p>
      <p>Підчерги 1.1, 1.2 – без відключень.</p></div>`;
    const { day, hasExplicitCancellation } = await mergeOk(cancelHtml, "2026-11-23", base.day, T2);
    expect(hasExplicitCancellation).toBe(true);
    expect(day.queues["1.1"].intervals).toEqual([]);
    expect(day.queues["1.2"].intervals).toEqual([]);
    expect(day.queues["2.1"].intervals).toEqual([I("10:00", "12:00")]);
    expect(day.queues["6.2"].intervals).toEqual([I("10:00", "12:00")]);
    expect(day.status).toBe("ACTIVE");
    expect(day.revisionCount).toBe(2);
  });

  it("#11: a standalone tail-only update keeps the morning from the stored day", async () => {
    const morning = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» 23.11.2026 р. будуть застосовані графіки (ГПВ).</p>
      <p>Підчерга 1.1 – 10:00-12:00; 18:00-21:00.<br/>${ALL_SUBQUEUES.slice(1)
        .map((q) => `Підчерга ${q} – 10:00-12:00.`)
        .join("<br/>")}</p></div>`;
    const base = await mergeOk(morning, "2026-11-23", null, T1);
    const tail = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 20:00).</p>
      <p>${["1.1", "1.2", "2.1", "2.2", "3.1", "3.2"].map((q) => `Підчерга ${q} – 20:00-22:00.`).join("<br/>")}</p></div>`;
    const { day } = await mergeOk(tail, "2026-11-23", base.day, T2);
    expect(day.queues["1.1"].intervals).toEqual([I("10:00", "12:00"), I("18:00", "22:00")]);
    expect(day.queues["1.2"].intervals).toEqual([I("10:00", "12:00"), I("20:00", "22:00")]);
    expect(day.queues["4.1"].intervals).toEqual([I("10:00", "12:00")]);
    expect(day.revisionCount).toBe(2);
  });

  const shiftOnly = `<div class="post">
    <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада.</p>
    <p>- у підчерги 1.1 відключення розпочнеться раніше – о 09:00</p></div>`;

  it("#18: a change-only block is applied on top of the stored day", async () => {
    const base = await mergeOk(
      `<div class="post"><p>За розпорядженням НЕК «Укренерго» 23.11.2026 р. будуть застосовані графіки (ГПВ).</p><p>${twelveQueues("10:00-14:00")}</p></div>`,
      "2026-11-23",
      null,
      T1,
    );
    const { day } = await mergeOk(shiftOnly, "2026-11-23", base.day, T2);
    expect(day.queues["1.1"].intervals).toEqual([I("09:00", "14:00")]);
    expect(day.queues["2.1"].intervals).toEqual([I("10:00", "14:00")]);
    expect(day.revisionCount).toBe(2);
  });

  it("guards against orphan deltas and change-only blocks without a stored base", async () => {
    const delta = `<div class="post">
      <p>За розпорядженням НЕК «Укренерго» оновлено графік на 23 листопада (оновлено з 21:30).</p>
      <p>Додатково години відсутності електроенергії:</p>
      <p>Підчерга 5.2 – 22:00-24:00.</p></div>`;
    for (const html of [delta, shiftOnly]) {
      const res = await mergeHtml(html, "2026-11-23", null);
      expect(res).toMatchObject({ ok: false, errorCode: "ORPHAN_DELTA_WITHOUT_BASE" });
    }
  });

  it("reports NO_VALID_BLOCKS when nothing usable is left", async () => {
    const res = await mergeDayVersions({
      date: "2026-11-23",
      blocksNewestFirst: [],
      existingDay: null,
      sourceUrl: URL,
      recordedAt: T1,
    });
    expect(res).toMatchObject({ ok: false, errorCode: "NO_VALID_BLOCKS" });
  });
});

describe("mergeDayVersions — live fixture (post of 25 Nov)", () => {
  it("adds the 22:00-24:00 delta to the full schedule of the 23:35 update", async () => {
    const blocks = await parsePage(FIXTURE_HTML.post1125, "2027-05-01");
    expect(blocks).toHaveLength(3);
    const res = await mergeDayVersions({
      date: "2026-11-25",
      blocksNewestFirst: blocks,
      existingDay: null,
      sourceUrl: URL,
      recordedAt: T1,
    });
    if (!res.ok) throw new Error(res.errorMessage);

    const update2335 = blocks[1]?.queues;
    expect(update2335).toBeTruthy();
    expect(res.day.revisionCount).toBe(3);
    expect(res.day.queues["1.1"].intervals).toEqual(
      mergeOverlappingIntervals([...(update2335?.["1.1"].intervals ?? []), [1320, 1440]]),
    );
    for (const q of ALL_SUBQUEUES.filter((x) => x !== "1.1")) {
      expect(res.day.queues[q]).toEqual(update2335?.[q]);
    }
    expect(res.day.changedQueues).toEqual(["1.1"]);
    expect(res.day.operationalMessage).toContain("оновлено з 21:35");
  });
});
