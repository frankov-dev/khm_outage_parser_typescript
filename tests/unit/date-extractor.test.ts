import { describe, expect, it } from "vitest";
import { extractPublishDate, extractScheduleDate, resolveYear } from "../../src/core/time";

const REF = "2026-11-27";

describe("extractScheduleDate — legacy parity", () => {
  it("parses Ukrainian text months", () => {
    expect(extractScheduleDate("на 07 листопада", REF)).toBe("2026-11-07");
    expect(extractScheduleDate("на 15 січня 2026 року", "2026-01-20")).toBe("2026-01-15");
    expect(extractScheduleDate("23 березня", REF)).toBe("2026-03-23");
  });

  it("parses numeric dot dates", () => {
    expect(extractScheduleDate("17.10.2026", REF)).toBe("2026-10-17");
    expect(extractScheduleDate("08.04.26", REF)).toBe("2026-04-08");
  });

  it("parses legacy image alt markers", () => {
    expect(extractScheduleDate("ГПВ-15.01.26", "2026-01-20")).toBe("2026-01-15");
    expect(extractScheduleDate("ГПВ_30.06.2026", REF)).toBe("2026-06-30");
    expect(extractScheduleDate("ГПВ 17102026", REF)).toBe("2026-10-17");
  });

  it("ignores the parenthetical update timestamp", () => {
    expect(extractScheduleDate("на 16 листопада (оновлено о 23:00, 15.11.2026)", REF)).toBe(
      "2026-11-16",
    );
  });

  it("corrects an editorial year typo", () => {
    expect(extractScheduleDate("ГПВ 17102027 оновлено 2", REF)).toBe("2026-10-17");
  });

  it("returns null for empty or date-less text", () => {
    expect(extractScheduleDate("", REF)).toBeNull();
    expect(extractScheduleDate("   ", REF)).toBeNull();
    expect(extractScheduleDate("Текст без дат", REF)).toBeNull();
  });
});

describe("extractScheduleDate — live hoe.com.ua formats", () => {
  it("handles the numeric date with trailing NBSP and update stamp", () => {
    const text =
      "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 26.11.2026 р. (оновлено 23:40).\u00A0";
    expect(extractScheduleDate(text, REF)).toBe("2026-11-26");
  });

  it("handles a year-less delta header with 'оновлено з HH:MM'", () => {
    const text =
      "За розпорядженням НЕК «Укренерго» оновлено графік погодинних відключень (ГПВ) на 25 листопада (оновлено з 21:35).";
    expect(extractScheduleDate(text, REF)).toBe("2026-11-25");
  });

  it("handles the initial forecast header", () => {
    const text =
      "За розпорядженням НЕК «Укренерго» 27.11.2026 р. на Хмельниччині будуть застосовані графіки погодинних відключень (ГПВ).";
    expect(extractScheduleDate(text, REF)).toBe("2026-11-27");
  });
});

describe("extractScheduleDate — fixes over the Python parser", () => {
  it("accepts commas and apostrophes in the target phrase", () => {
    expect(extractScheduleDate("на завтра, 16 листопада", REF)).toBe("2026-11-16");
    expect(extractScheduleDate("на п'ятницю 16 листопада", REF)).toBe("2026-11-16");
    expect(extractScheduleDate("на п’ятницю, 16 листопада", REF)).toBe("2026-11-16");
  });

  it("prefers an earlier headline numeric date over a later month mention", () => {
    const text = "Графік 26.11.2026 р. Попередній графік діяв 25 листопада.";
    expect(extractScheduleDate(text, REF)).toBe("2026-11-26");
  });

  it("rejects 3-digit years", () => {
    expect(extractScheduleDate("17.10.202", REF)).toBeNull();
    expect(extractScheduleDate("ГПВ 1710202", REF)).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(extractScheduleDate("31 лютого 2026", REF)).toBeNull();
    expect(extractScheduleDate("30.02.2026", REF)).toBeNull();
  });

  it("handles New Year rollover in both directions", () => {
    expect(extractScheduleDate("на 1 січня", "2026-12-31")).toBe("2027-01-01");
    expect(extractScheduleDate("на 31 грудня", "2027-01-02")).toBe("2026-12-31");
  });

  it("corrects a New Year typo year (2028 instead of 2027)", () => {
    expect(extractScheduleDate("01.01.2028", "2026-12-30")).toBe("2027-01-01");
  });
});

describe("resolveYear", () => {
  it("expands 2-digit years", () => {
    expect(resolveYear(4, 8, "26", REF)).toBe(2026);
  });

  it("keeps a plausible explicit year", () => {
    expect(resolveYear(12, 31, "2026", REF)).toBe(2026);
  });
});

describe("extractPublishDate", () => {
  it("parses short Ukrainian month names", () => {
    expect(extractPublishDate("26 Лис 2026")).toBe("2026-11-26");
    expect(extractPublishDate("05 Січ 2027")).toBe("2027-01-05");
    expect(extractPublishDate("26 Лис. 2026")).toBe("2026-11-26");
  });

  it("normalises NBSP", () => {
    expect(extractPublishDate("24\u00A0Лис\u00A02026")).toBe("2026-11-24");
  });

  it("parses full genitive months and numeric dates", () => {
    expect(extractPublishDate("26 листопада 2026")).toBe("2026-11-26");
    expect(extractPublishDate("26.11.2026")).toBe("2026-11-26");
  });

  it("returns null for garbage", () => {
    expect(extractPublishDate("")).toBeNull();
    expect(extractPublishDate("вчора")).toBeNull();
    expect(extractPublishDate("31 Лют 2026")).toBeNull();
  });
});
