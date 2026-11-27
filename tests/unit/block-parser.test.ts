import { describe, expect, it } from "vitest";
import { CheerioHtmlExtractor } from "../../src/adapters/html/cheerio-extractor";
import { parseScheduleBlock } from "../../src/core/parsing";
import { extractRawBlocks } from "../../src/core/scraping";
import { ALL_SUBQUEUES, type MinuteInterval, type SubqueueId } from "../../src/core/types/domain";
import { FIXTURE_HTML } from "../fixtures/parity-cases";

function t(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
function I(start: string, end: string): MinuteInterval {
  return [t(start), t(end)];
}

function parse(scheduleText: string, extrasText = "") {
  return parseScheduleBlock({
    date: "2026-11-07",
    dateSource: "text",
    scheduleText,
    extrasText,
    sourceUrl: "https://hoe.com.ua/x",
  });
}
function iv(res: ReturnType<typeof parse>, q: SubqueueId): MinuteInterval[] | undefined {
  return res.queues?.[q].intervals;
}

describe("legacy parity — modern format", () => {
  it("parses modern lines and guarantees all 12 queues", () => {
    const res = parse(
      [
        "За розпорядженням НЕК «Укренерго» 07 листопада на Хмельниччині будуть застосовані графіки:",
        "Підчерга 1.1 – 00:00-04:00; 09:00-13:00; 18:00-21:00.",
        "Підчерга 2.1 – 00:00-04:00; 13:00-17:00; 22:00-24:00.",
      ].join("\n"),
    );
    expect(Object.keys(res.queues ?? {})).toEqual([...ALL_SUBQUEUES]);
    expect(iv(res, "1.1")).toEqual([I("00:00", "04:00"), I("09:00", "13:00"), I("18:00", "21:00")]);
    expect(iv(res, "2.1")?.[2]).toEqual(I("22:00", "24:00"));
    expect(iv(res, "1.2")).toEqual([]);
    expect(res.queues?.["1.1"].offMinutes).toBe(240 + 240 + 180);
  });

  it("parses explicit no-outage lines", () => {
    const res = parse(
      ["Підчерга 1.1 – 21:00-24:00.", "Підчерга 2.1 – вимкнень немає.", "Підчерга 4.1 – без відключень."].join("\n"),
    );
    expect(iv(res, "1.1")).toEqual([I("21:00", "24:00")]);
    expect(iv(res, "2.1")).toEqual([]);
    expect(iv(res, "4.1")).toEqual([]);
    expect(res.explicitNoOutageQueues).toEqual(["2.1", "4.1"]);
    expect(Object.keys(res.queues ?? {})).toHaveLength(12);
  });

  it("parses multi-queue lines", () => {
    const res = parse("Підчерги 3.1, 3.2 – 04:00-08:00; 13:00-18:00.");
    expect(iv(res, "3.1")).toHaveLength(2);
    expect(iv(res, "3.2")).toHaveLength(2);
    expect(res.mentionedQueues).toEqual(["3.1", "3.2"]);
  });
});

describe("legacy parity — classic format", () => {
  it("parses a single interval", () => {
    expect(iv(parse("підчерга 1.1 – з 10:00 до 15:00"), "1.1")).toEqual([I("10:00", "15:00")]);
  });
  it("parses multiple intervals", () => {
    expect(iv(parse("підчерга 2.1 – з 06:00 до 11:00 та з 18:00 до 23:00"), "2.1")).toEqual([
      I("06:00", "11:00"),
      I("18:00", "23:00"),
    ]);
  });
});

describe("legacy parity — operational changes", () => {
  it("earlier start", () => {
    const res = parse(
      "підчерга 3.1 – 08:00-13:00; 21:00-24:00",
      "- у підчерги 3.1 відключення розпочнеться раніше – о 20:00",
    );
    expect(iv(res, "3.1")).toEqual([I("08:00", "13:00"), I("20:00", "24:00")]);
  });

  it("earlier start never corrupts an already finished interval", () => {
    const res = parse(
      "підчерга 3.1 – 08:00-11:00; 16:00-20:00",
      "- у підчерги 3.1 відключення почнеться раніше, о 12:00",
    );
    expect(iv(res, "3.1")).toEqual([I("08:00", "11:00"), I("12:00", "20:00")]);
  });

  it("extended end", () => {
    const res = parse(
      "підчерга 4.1 – 04:00-08:00; 13:00-17:00",
      "- у підчерги 4.1 відключення триватиме довше – до 18:00",
    );
    expect(iv(res, "4.1")).toEqual([I("04:00", "08:00"), I("13:00", "18:00")]);
  });

  it("power restoration phrase", () => {
    const res = parse(
      "підчерга 6.1 – 08:00-13:00; 17:00-20:00",
      "- у підчерги 6.1 триватиме довше – заживлення споживачів розпочнеться о 21:00.",
    );
    expect(iv(res, "6.1")).toEqual([I("08:00", "13:00"), I("17:00", "21:00")]);
  });

  it("explicit interval change", () => {
    const res = parse(
      "підчерга 2.1 – 00:00-04:00",
      "- підчерга 2.1. - відключення триватимуть з 16:00 до 17:00;",
    );
    expect(iv(res, "2.1")).toEqual([I("00:00", "04:00"), I("16:00", "17:00")]);
  });

  it("extra outage", () => {
    const res = parse(
      "підчерга 1.1 – 10:00-14:00",
      "додатково буде знеструмлено підчергу 1.1 з 16:00 до 18:00",
    );
    expect(iv(res, "1.1")).toEqual([I("10:00", "14:00"), I("16:00", "18:00")]);
  });
});

describe("legacy parity — edge cases", () => {
  it("merges overlapping intervals", () => {
    expect(iv(parse("підчерга 1.1 – 10:00-14:00; 13:00-16:00"), "1.1")).toEqual([I("10:00", "16:00")]);
  });

  it("empty schedule has no queues and no message", () => {
    const res = parse("", "");
    expect(res.queues).toBeNull();
    expect(res.operationalMessage).toBeNull();
  });

  it("detects additive delta metadata", () => {
    const res = parse(
      "Підчерга 5.2 – 22:00-24:00.\nПідчерга 6.2 – 22:00-24:00.",
      "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 23 листопада (оновлено з 21:30).\nДодатково години відсутності електроенергії:",
    );
    expect(res.isAdditive).toBe(true);
    expect(res.effectiveFromMin).toBe(t("21:30"));
    expect(res.mentionedQueues).toEqual(["5.2", "6.2"]);
    expect(iv(res, "5.2")).toEqual([I("22:00", "24:00")]);
    expect(iv(res, "6.2")).toEqual([I("22:00", "24:00")]);
  });

  it("normalises a 00:00 end to 24:00", () => {
    const res = parse(
      "Підчерга 2.2 – 00:00-01:00.\nПідчерга 4.2 – 22:00-00:00.\nПідчерга 5.1 – 18:00-21:00.",
      "- у підчерги 5.1 відключення триватиме довше – до 00:00\n- Підчерга 6.1 – додатково 21:00-00:00",
    );
    expect(iv(res, "2.2")).toEqual([I("00:00", "01:00")]);
    expect(iv(res, "4.2")).toEqual([I("22:00", "24:00")]);
    expect(iv(res, "5.1")).toEqual([I("18:00", "24:00")]);
    expect(iv(res, "6.1")).toEqual([I("21:00", "24:00")]);
  });

  it("applies range and full cancellations", () => {
    const res = parse(
      "Підчерга 1.1 – 10:00-14:00; 18:00-22:00.\nПідчерга 2.1 – 12:00-16:00.",
      "- у підчерги 1.1 відключення з 18:00 до 20:00 скасовано;\n- у підчерги 2.1 відключення скасовано.",
    );
    expect(iv(res, "1.1")).toEqual([I("10:00", "14:00"), I("20:00", "22:00")]);
    expect(iv(res, "2.1")).toEqual([]);
    expect(res.mentionedQueues).toContain("2.1");
    expect(res.explicitNoOutageQueues).toEqual(["2.1"]);
    expect(res.hasExplicitCancellation).toBe(true);
  });

  it("effective_from requires the preposition 'з'", () => {
    for (const note of [
      "оновлено графік на 24 листопада (оновлено 23:20, 23.11.2026).",
      "оновлено графік на 16 листопада (оновлено о 23:00, 15.11.2026).",
      "оновлено графік на 21 листопада (оновлено 23:00).",
    ]) {
      expect(parse("Підчерга 1.1 – 10:00-14:00.", note).effectiveFromMin).toBeNull();
    }
    for (const [note, expected] of [
      ["оновлено графік на 24 листопада (оновлено з 20:00).", "20:00"],
      ["оновлено графік на 15 листопада (з 17:30).", "17:30"],
      ["Прогноз ГПВ (ОНОВЛЕНО, з 9:30).", "09:30"],
    ] as const) {
      expect(parse("Підчерга 1.1 – 10:00-14:00.", note).effectiveFromMin).toBe(t(expected));
    }
  });
});

describe("regressions — bugs of the Python parser", () => {
  it("#3A: a partial cancellation is not additive", () => {
    const res = parse("Підчерги 1.1, 1.2 – без відключень.");
    expect(res.explicitNoOutageQueues).toEqual(["1.1", "1.2"]);
    expect(res.isAdditive).toBe(false);
    expect(res.hasExplicitCancellation).toBe(true);
    expect(res.queues).not.toBeNull();
  });

  it("#3B: a full 12-queue replacement with 'Збільшено обсяг' is not additive", () => {
    const lines = ALL_SUBQUEUES.map((q) => `Підчерга ${q} – 10:00-12:00.`).join("\n");
    const res = parse(lines, "Збільшено обсяг обмежень на Хмельниччині\nДодатково до раніше оголошеного");
    expect(res.mentionedQueues).toHaveLength(12);
    expect(res.isAdditive).toBe(false);
  });

  it("#4: singular 'триватиме з … до …'", () => {
    const res = parse("підчерга 2.1 – 08:00-10:00", "- підчерга 2.1 - відключення триватиме з 16:00 до 17:00");
    expect(iv(res, "2.1")).toEqual([I("08:00", "10:00"), I("16:00", "17:00")]);
  });

  it("#5: early power restoration shortens the outage instead of inverting it", () => {
    const res = parse(
      "підчерга 1.1 – 14:00-18:00",
      "- у підчерги 1.1 заживлення споживачів розпочнеться раніше – о 16:00",
    );
    expect(iv(res, "1.1")).toEqual([I("14:00", "16:00")]);
  });

  it("#6: 'розпочнеться пізніше' moves the start later", () => {
    const res = parse(
      "підчерга 1.1 – 10:00-14:00",
      "- у підчерги 1.1 відключення розпочнеться пізніше – о 12:00",
    );
    expect(iv(res, "1.1")).toEqual([I("12:00", "14:00")]);
  });

  it("#7: numbers without subqueue context or dates never address a queue", () => {
    const res = parse(
      "підчерга 1.1 – 10:00-12:00",
      "Додатково застосовано 2.1 черги з 16:00 до 18:00\nОновлено 2.2.2026 о 10:00 додатково підчерга 1.1 з 20:00 до 21:00",
    );
    expect(iv(res, "2.1")).toEqual([]);
    expect(iv(res, "2.2")).toEqual([]);
    expect(res.mentionedQueues).toEqual(["1.1"]);
    expect(iv(res, "1.1")).toEqual([I("10:00", "12:00"), I("20:00", "21:00")]);
  });

  it("#8: restoration shortens the nearest interval across several intervals", () => {
    const res = parse(
      "підчерга 1.1 – 06:00-10:00; 11:00-15:00",
      "- у підчерги 1.1 заживлення споживачів розпочнеться о 14:00",
    );
    expect(iv(res, "1.1")).toEqual([I("06:00", "10:00"), I("11:00", "14:00")]);
  });

  it("#9: a later start with an explicit end replaces rather than widens", () => {
    const res = parse(
      "підчерга 1.1 – 10:00-14:00",
      "- у підчерги 1.1 розпочнеться пізніше – о 12:00 і триватиме до 16:00",
    );
    expect(iv(res, "1.1")).toEqual([I("12:00", "16:00")]);
  });

  it("#15: a single-time cancellation never wipes the queue", () => {
    const res = parse("підчерга 1.1 – 10:00-14:00", "у підчерги 1.1 відключення о 18:00 скасовано");
    expect(iv(res, "1.1")).toEqual([I("10:00", "14:00")]);
    expect(res.explicitNoOutageQueues).toEqual([]);
  });

  it("#15: an inline note cancels only the parenthesised range", () => {
    const res = parse("", "Підчерга 1.1 – 10:00-14:00 (18:00-20:00 скасовано)");
    expect(iv(res, "1.1")).toEqual([I("10:00", "14:00")]);
    expect(res.queues?.["1.1"].offMinutes).toBe(240);
  });

  it("#16: separate clauses with different times do not cross-contaminate", () => {
    const res = parse(
      "підчерга 1.1 – 11:00-15:00\nпідчерга 2.1 – 13:00-17:00",
      "у підчерги 1.1 розпочнеться раніше о 10:00, а у підчерги 2.1 розпочнеться раніше о 12:00",
    );
    expect(iv(res, "1.1")).toEqual([I("10:00", "15:00")]);
    expect(iv(res, "2.1")).toEqual([I("12:00", "17:00")]);
  });

  it("#16: plural verbs and extra wording are understood", () => {
    expect(iv(parse("підчерга 3.1 – 10:00-14:00", "- у підчерги 3.1 не вимикаються"), "3.1")).toEqual([]);
    expect(iv(parse("підчерга 3.1 – 10:00-14:00", "- у підчерги 3.1 відключення відмінено"), "3.1")).toEqual([]);
    expect(
      iv(parse("підчерга 3.1 – 10:00-14:00", "- у підчерзі 3.1 відключення триватимуть довше – до 19:00"), "3.1"),
    ).toEqual([I("10:00", "19:00")]);
    expect(
      iv(parse("підчерга 3.1 – 10:00-14:00", "- у підчерги 3.1 відключення розпочнуться раніше о 09:00"), "3.1"),
    ).toEqual([I("09:00", "14:00")]);
  });

  it("#18: a change-only block reports unapplied changes instead of dropping them", () => {
    const res = parse("", "- у підчерги 1.1 відключення розпочнеться раніше – о 09:00");
    expect(res.queues).toBeNull();
    expect(res.unappliedChanges).toEqual([
      { kind: "shift_start", queue: "1.1", newStartMin: t("09:00"), direction: "earlier" },
    ]);
    expect(res.mentionedQueues).toEqual(["1.1"]);
  });

  it("#20: a dangling sub-header is stripped from the message but still marks the block additive", () => {
    const res = parse(
      "Підчерга 1.1 - 22:00-24:00",
      "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 25 листопада (оновлено з 21:35).\nДодаткові години відсутності електроенергії:",
    );
    expect(res.operationalMessage).toBe(
      "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 25 листопада (оновлено з 21:35).",
    );
    expect(res.isAdditive).toBe(true);
  });
});

describe("live fixtures end-to-end", () => {
  const extractor = new CheerioHtmlExtractor();

  async function parseFixture(html: string, ref: string) {
    const page = await extractor.extractSchedulePage(html, "https://hoe.com.ua/x");
    return extractRawBlocks(page, ref).map(parseScheduleBlock);
  }

  it("main page: three fully parsed 12-queue blocks", async () => {
    const blocks = await parseFixture(FIXTURE_HTML.mainPage, "2026-11-27");
    expect(blocks.map((b) => b.date)).toEqual(["2026-11-27", "2026-11-26", "2026-11-26"]);
    for (const b of blocks) {
      expect(Object.keys(b.queues ?? {})).toEqual([...ALL_SUBQUEUES]);
      expect(b.mentionedQueues).toHaveLength(12);
      expect(b.isAdditive).toBe(false);
      expect(b.effectiveFromMin).toBeNull();
      expect(b.unappliedChanges).toEqual([]);
    }
    expect(blocks[0]?.queues?.["1.1"]).toEqual({
      intervals: [I("06:00", "08:00"), I("11:00", "14:00"), I("17:00", "20:00"), I("22:00", "24:00")],
      offMinutes: 600,
    });
    expect(blocks[1]?.queues?.["6.2"].intervals[0]).toEqual([0, 120]);
    expect(blocks[1]?.operationalMessage).toContain("(оновлено 23:40)");
  });

  it("post of 25 Nov: year-less single-queue delta is recognised as additive", async () => {
    const blocks = await parseFixture(FIXTURE_HTML.post1125, "2027-05-01");
    expect(blocks).toHaveLength(3);
    const delta = blocks[0];
    expect(delta?.date).toBe("2026-11-25");
    expect(delta?.isAdditive).toBe(true);
    expect(delta?.effectiveFromMin).toBe(1295);
    expect(delta?.mentionedQueues).toEqual(["1.1"]);
    expect(delta?.queues?.["1.1"]).toEqual({ intervals: [[1320, 1440]], offMinutes: 120 });
    expect(delta?.operationalMessage).toBe(
      "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 25 листопада (оновлено з 21:35).",
    );
    expect(blocks[1]?.isAdditive).toBe(false);
    expect(blocks[2]?.isAdditive).toBe(false);
    expect(blocks[1]?.mentionedQueues).toHaveLength(12);
  });
});
