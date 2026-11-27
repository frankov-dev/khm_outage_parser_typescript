import { describe, expect, it } from "vitest";
import {
  extractTimeIntervals,
  formatMinutesToHHMM,
  parseEndTimeToMinutes,
  parseTimeToMinutes,
} from "../../src/core/parsing";

describe("parseTimeToMinutes", () => {
  it("parses single- and double-digit hours", () => {
    expect(parseTimeToMinutes("7:00")).toBe(420);
    expect(parseTimeToMinutes("09:30")).toBe(570);
    expect(parseTimeToMinutes("23:59")).toBe(1439);
    expect(parseTimeToMinutes("10.30")).toBe(630);
  });

  it("accepts 24:00 only as end of day", () => {
    expect(parseTimeToMinutes("24:00")).toBe(1440);
    expect(parseTimeToMinutes("24:00", { allowEndOfDay: false })).toBeNull();
  });

  it("rejects out-of-range values", () => {
    for (const bad of ["24:01", "25:99", "12:60", "7", "abc", "", "1:5"]) {
      expect(parseTimeToMinutes(bad)).toBeNull();
    }
  });
});

describe("parseEndTimeToMinutes", () => {
  it("treats 00:00 as end of day unless the start is also 00:00", () => {
    expect(parseEndTimeToMinutes("00:00", 1320)).toBe(1440);
    expect(parseEndTimeToMinutes("00:00")).toBe(1440);
    expect(parseEndTimeToMinutes("00:00", 0)).toBe(0);
    expect(parseEndTimeToMinutes("24:00", 1320)).toBe(1440);
    expect(parseEndTimeToMinutes("18:00", 600)).toBe(1080);
  });
});

describe("formatMinutesToHHMM", () => {
  it("formats minutes", () => {
    expect(formatMinutesToHHMM(360)).toBe("06:00");
    expect(formatMinutesToHHMM(1440)).toBe("24:00");
    expect(formatMinutesToHHMM(0)).toBe("00:00");
    expect(formatMinutesToHHMM(1295)).toBe("21:35");
  });
});

describe("extractTimeIntervals", () => {
  it("parses the modern format with different dashes", () => {
    expect(extractTimeIntervals("00:00-04:00; 09:00–13:00; 18:00 — 21:00.")).toEqual([
      [0, 240],
      [540, 780],
      [1080, 1260],
    ]);
  });

  it("parses the classic Ukrainian format", () => {
    expect(extractTimeIntervals("з 10:00 до 15:00")).toEqual([[600, 900]]);
    expect(extractTimeIntervals("з 06:00 до 11:00 та з 18:00 до 23:00")).toEqual([
      [360, 660],
      [1080, 1380],
    ]);
    expect(extractTimeIntervals("з 10:00 по 15:00")).toEqual([[600, 900]]);
    expect(extractTimeIntervals("з 10:00-15:00")).toEqual([[600, 900]]);
  });

  it("parses single-digit hours and dot times", () => {
    expect(extractTimeIntervals("7:00-10:00")).toEqual([[420, 600]]);
    expect(extractTimeIntervals("10.00-14.00; 10.30–14.30")).toEqual([
      [600, 840],
      [630, 870],
    ]);
  });

  it("normalises a 00:00 end to end of day", () => {
    expect(extractTimeIntervals("22:00-00:00")).toEqual([[1320, 1440]]);
    expect(extractTimeIntervals("22:00-24:00")).toEqual([[1320, 1440]]);
  });

  it("rejects empty or invalid intervals", () => {
    expect(extractTimeIntervals("00:00-00:00")).toEqual([]);
    expect(extractTimeIntervals("14:00-10:00")).toEqual([]);
    expect(extractTimeIntervals("25:99-26:00")).toEqual([]);
    expect(extractTimeIntervals("24:00-24:00")).toEqual([]);
  });

  it("does not mistake calendar dates for times", () => {
    expect(extractTimeIntervals("з 10.11-11.11")).toEqual([]);
    expect(extractTimeIntervals("на 26.11.2026 р. (оновлено 23:40).")).toEqual([]);
    expect(extractTimeIntervals("Підчерга 1.1 – 06:00-08:00")).toEqual([[360, 480]]);
  });
});
