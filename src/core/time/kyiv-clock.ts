import type { Clock, KyivDateParts } from "../ports/clock";
import type { DateIso } from "../types/domain";

const MS_PER_DAY = 86_400_000;

// Hoisted: constructing Intl formatters is comparatively expensive (CPU budget on Workers).
const KYIV_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  // `h23` (not `hour12: false`) so midnight is "00", never "24".
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "longOffset",
});

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function formatKyivParts(date: Date): KyivDateParts {
  const raw: Record<string, string> = {};
  for (const part of KYIV_FORMATTER.formatToParts(date)) {
    raw[part.type] = part.value;
  }

  const year = Number(raw["year"]);
  const month = Number(raw["month"]);
  const day = Number(raw["day"]);
  const hour = Number(raw["hour"]);
  const minute = Number(raw["minute"]);
  const second = Number(raw["second"]);

  const tzName = (raw["timeZoneName"] ?? "").replace(/^GMT/, "");
  const offset = tzName === "" ? "+00:00" : tzName;

  const dateIso = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const isoTimestamp = `${dateIso}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${offset}`;

  return { year, month, day, hour, minute, second, offset, dateIso, isoTimestamp };
}

/** Returns `YYYY-MM-DD` for a real calendar date, otherwise `null`. */
export function formatValidCalendarDate(year: number, month: number, day: number): DateIso | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function parseDateIso(dateIso: DateIso): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return formatValidCalendarDate(year, month, day) === null ? null : { year, month, day };
}

function utcMs(dateIso: DateIso): number {
  const parsed = parseDateIso(dateIso);
  if (!parsed) {
    throw new RangeError(`Invalid calendar date: ${dateIso}`);
  }
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
}

/** Pure calendar arithmetic in UTC — immune to 23h/25h DST days. */
export function addCalendarDays(dateIso: DateIso, deltaDays: number): DateIso {
  const parsed = parseDateIso(dateIso);
  if (!parsed) {
    throw new RangeError(`Invalid calendar date: ${dateIso}`);
  }
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + deltaDays));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** `a - b` in whole calendar days. */
export function diffCalendarDays(a: DateIso, b: DateIso): number {
  return Math.round((utcMs(a) - utcMs(b)) / MS_PER_DAY);
}

abstract class BaseKyivClock implements Clock {
  abstract now(): Date;

  kyivNow(): KyivDateParts {
    return formatKyivParts(this.now());
  }

  kyivToday(): DateIso {
    return this.kyivNow().dateIso;
  }

  kyivTomorrow(): DateIso {
    return this.kyivAddDays(1);
  }

  kyivAddDays(days: number): DateIso {
    return addCalendarDays(this.kyivToday(), days);
  }
}

export class SystemKyivClock extends BaseKyivClock {
  now(): Date {
    return new Date();
  }
}

export class FixedKyivClock extends BaseKyivClock {
  private readonly fixed: Date;

  constructor(value: Date | string) {
    super();
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new RangeError(`Invalid date for FixedKyivClock: ${String(value)}`);
    }
    this.fixed = date;
  }

  now(): Date {
    return new Date(this.fixed.getTime());
  }
}
