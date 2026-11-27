import type { DateIso, TimestampIso } from "../types/domain";

export interface KyivDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `+02:00` (EET, winter) or `+03:00` (EEST, summer). */
  offset: string;
  dateIso: DateIso;
  isoTimestamp: TimestampIso;
}

export interface Clock {
  now(): Date;
  kyivNow(): KyivDateParts;
  kyivToday(): DateIso;
  kyivTomorrow(): DateIso;
  kyivAddDays(days: number): DateIso;
}
