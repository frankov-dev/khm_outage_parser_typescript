import type { MinuteInterval } from "../types/domain";

export interface ParseTimeOptions {
  /** Accept `24:00` (end of day) and return 1440. Defaults to true. */
  allowEndOfDay?: boolean;
}

const TIME_PARTS = /^(\d{1,2})[:.](\d{2})$/;

/** Parses `H:MM`, `HH:MM`, `H.MM` or `HH.MM` into minutes from midnight with strict bounds. */
export function parseTimeToMinutes(raw: string, options: ParseTimeOptions = {}): number | null {
  const match = TIME_PARTS.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59) return null;
  if (hours <= 23) return hours * 60 + minutes;
  if (hours === 24 && minutes === 0 && options.allowEndOfDay !== false) return 1440;
  return null;
}

/** Like `parseTimeToMinutes`, but `00:00` as an interval end means end of day (1440). */
export function parseEndTimeToMinutes(raw: string, startMin?: number): number | null {
  const value = parseTimeToMinutes(raw, { allowEndOfDay: true });
  if (value === 0 && startMin !== 0) return 1440;
  return value;
}

export function formatMinutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Colon times (7:00, 09:30, 24:00) and the common dot times (10.00, 10.30). Dot times are limited
// to :00/:15/:30/:45 so calendar dates such as "10.11-11.11" or "26.11.2026" never match.
const TIME_TOKEN = String.raw`(?<!\d\.)(\d{1,2}:\d{2}|\d{1,2}\.(?:00|15|30|45))(?!\.\d)`;

const TIME_RANGE_PATTERN = new RegExp(
  String.raw`(?:(?<![\p{L}\d])з\s*)?${TIME_TOKEN}\s*(?:до|по|[-–—])\s*${TIME_TOKEN}(?!\d)`,
  "giu",
);

/** Extracts every valid `start-end` / `з start до end` interval from the text, in order. */
export function extractTimeIntervals(text: string): MinuteInterval[] {
  const result: MinuteInterval[] = [];
  for (const m of text.matchAll(TIME_RANGE_PATTERN)) {
    const startMin = parseTimeToMinutes(m[1] ?? "", { allowEndOfDay: false });
    if (startMin === null) continue;
    const endMin = parseEndTimeToMinutes(m[2] ?? "", startMin);
    if (endMin === null || startMin >= endMin) continue;
    result.push([startMin, endMin]);
  }
  return result;
}
