import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  diffCalendarDays,
  FixedKyivClock,
  formatKyivParts,
  formatValidCalendarDate,
  parseDateIso,
} from "../../src/core/time";

describe("formatKyivParts", () => {
  it("uses +02:00 in winter", () => {
    const p = formatKyivParts(new Date("2026-11-27T00:15:00Z"));
    expect(p.isoTimestamp).toBe("2026-11-27T02:15:00+02:00");
    expect(p.offset).toBe("+02:00");
    expect(p.dateIso).toBe("2026-11-27");
  });

  it("formats Kyiv midnight as 00:00:00, never 24:00:00", () => {
    const p = formatKyivParts(new Date("2026-11-26T22:00:00Z"));
    expect(p.isoTimestamp).toBe("2026-11-27T00:00:00+02:00");
    expect(p.hour).toBe(0);
  });

  it("uses +03:00 in summer", () => {
    const p = formatKyivParts(new Date("2026-07-15T12:00:00Z"));
    expect(p.isoTimestamp).toBe("2026-07-15T15:00:00+03:00");
    expect(p.offset).toBe("+03:00");
  });

  it("handles the spring-forward transition (2026-03-29)", () => {
    expect(formatKyivParts(new Date("2026-03-29T00:59:59Z")).isoTimestamp).toBe(
      "2026-03-29T02:59:59+02:00",
    );
    expect(formatKyivParts(new Date("2026-03-29T01:00:00Z")).isoTimestamp).toBe(
      "2026-03-29T04:00:00+03:00",
    );
  });

  it("handles the fall-back transition (2026-10-25)", () => {
    expect(formatKyivParts(new Date("2026-10-25T00:59:59Z")).isoTimestamp).toBe(
      "2026-10-25T03:59:59+03:00",
    );
    expect(formatKyivParts(new Date("2026-10-25T01:00:00Z")).isoTimestamp).toBe(
      "2026-10-25T03:00:00+02:00",
    );
  });
});

describe("FixedKyivClock", () => {
  it("derives Kyiv today across the UTC date boundary", () => {
    const clock = new FixedKyivClock("2026-11-26T23:30:00Z");
    expect(clock.kyivToday()).toBe("2026-11-27");
    expect(clock.kyivTomorrow()).toBe("2026-11-28");
  });

  it("advances exactly one calendar day over DST changes", () => {
    expect(new FixedKyivClock("2026-03-28T12:00:00+02:00").kyivTomorrow()).toBe("2026-03-29");
    expect(new FixedKyivClock("2026-03-29T12:00:00+03:00").kyivTomorrow()).toBe("2026-03-30");
    expect(new FixedKyivClock("2026-10-24T12:00:00+03:00").kyivTomorrow()).toBe("2026-10-25");
    expect(new FixedKyivClock("2026-10-25T12:00:00+02:00").kyivTomorrow()).toBe("2026-10-26");
  });

  it("kyivAddDays supports negative offsets", () => {
    expect(new FixedKyivClock("2026-11-27T12:00:00+02:00").kyivAddDays(-14)).toBe("2026-11-13");
  });

  it("rejects an invalid date", () => {
    expect(() => new FixedKyivClock("not a date")).toThrow(RangeError);
  });
});

describe("calendar helpers", () => {
  it("formatValidCalendarDate validates real dates", () => {
    expect(formatValidCalendarDate(2024, 2, 29)).toBe("2024-02-29");
    expect(formatValidCalendarDate(2026, 2, 29)).toBeNull();
    expect(formatValidCalendarDate(2026, 2, 30)).toBeNull();
    expect(formatValidCalendarDate(2026, 13, 1)).toBeNull();
    expect(formatValidCalendarDate(2026, 0, 1)).toBeNull();
    expect(formatValidCalendarDate(2026, 1, 32)).toBeNull();
    expect(formatValidCalendarDate(2026, 4, 31)).toBeNull();
  });

  it("parseDateIso is strict", () => {
    expect(parseDateIso("2026-11-27")).toEqual({ year: 2026, month: 11, day: 27 });
    expect(parseDateIso("2026-2-3")).toBeNull();
    expect(parseDateIso("2026-02-30")).toBeNull();
    expect(parseDateIso("garbage")).toBeNull();
  });

  it("addCalendarDays crosses month and year boundaries", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(() => addCalendarDays("2026-02-30", 1)).toThrow(RangeError);
  });

  it("diffCalendarDays is exact", () => {
    expect(diffCalendarDays("2026-11-27", "2026-11-27")).toBe(0);
    expect(diffCalendarDays("2026-11-28", "2026-11-27")).toBe(1);
    expect(diffCalendarDays("2026-11-27", "2026-11-28")).toBe(-1);
    expect(diffCalendarDays("2027-01-01", "2026-12-31")).toBe(1);
    expect(diffCalendarDays("2026-10-26", "2026-10-25")).toBe(1);
  });
});
