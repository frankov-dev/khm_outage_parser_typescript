import type { DateIso } from "../types/domain";
import { diffCalendarDays, formatValidCalendarDate, parseDateIso } from "./kyiv-clock";

export const UKRAINIAN_MONTHS_GENITIVE: Readonly<Record<string, number>> = {
  січня: 1,
  лютого: 2,
  березня: 3,
  квітня: 4,
  травня: 5,
  червня: 6,
  липня: 7,
  серпня: 8,
  вересня: 9,
  жовтня: 10,
  листопада: 11,
  грудня: 12,
};

/** 3-letter abbreviations used on hoe.com.ua news cards and post headers. */
export const UKRAINIAN_MONTHS_SHORT: Readonly<Record<string, number>> = {
  січ: 1,
  лют: 2,
  бер: 3,
  кві: 4,
  тра: 5,
  чер: 6,
  лип: 7,
  сер: 8,
  вер: 9,
  жов: 10,
  лис: 11,
  гру: 12,
};

// NOTE: JS `\b` is ASCII-only and never matches next to Cyrillic. Use Unicode lookarounds.
const MONTHS_ALT = Object.keys(UKRAINIAN_MONTHS_GENITIVE).join("|");

const PARENTHETICAL_UPDATE = /\([^)]*оновлено[^)]*\)/giu;

const ALT_DATE = /(?<![\p{L}\d])ГПВ[-_.\s]*(\d{2})[.\s]?(\d{2})[.\s]?(\d{4}|\d{2})(?!\d)/iu;

const TARGET_MONTH_PHRASE = new RegExp(
  `(?<![\\p{L}\\d])на\\s+(?:[\\p{L}'’]+,?\\s+)?(\\d{1,2})\\s+(${MONTHS_ALT})(?:\\s+(\\d{4})(?!\\d))?(?![\\p{L}\\d])`,
  "iu",
);

const GENERAL_MONTH_PHRASE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\s+(${MONTHS_ALT})(?:\\s+(\\d{4})(?!\\d))?(?![\\p{L}\\d])`,
  "giu",
);

const NUMERIC_DATE = /(?<!\d)(\d{1,2})\.(\d{2})\.(\d{4}|\d{2})(?!\d)/g;

const PUBLISH_WORD_DATE = /(?<!\d)(\d{1,2})\s+(\p{L}+)\.?\s+(\d{4})(?!\d)/u;

function cleanText(text: string): string {
  return text.replace(/[\u00A0\uFEFF]/g, " ");
}

export function resolveYear(
  month: number,
  day: number,
  explicitYear: string | undefined,
  referenceDateIso: DateIso,
): number {
  const ref = parseDateIso(referenceDateIso);
  if (!ref) {
    throw new RangeError(`Invalid reference date: ${referenceDateIso}`);
  }

  if (explicitYear !== undefined) {
    const year = explicitYear.length === 2 ? 2000 + Number(explicitYear) : Number(explicitYear);
    const candidate = formatValidCalendarDate(year, month, day);
    if (candidate !== null && Math.abs(diffCalendarDays(candidate, referenceDateIso)) > 300) {
      // Probable editorial year typo (e.g. 2027 instead of 2026): look for a near-by real date.
      let bestYear: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const altYear of [ref.year, ref.year + 1, ref.year - 1]) {
        const alt = formatValidCalendarDate(altYear, month, day);
        if (alt === null) continue;
        const distance = Math.abs(diffCalendarDays(alt, referenceDateIso));
        if (distance <= 60 && distance < bestDistance) {
          bestYear = altYear;
          bestDistance = distance;
        }
      }
      if (bestYear !== null) return bestYear;
    }
    return year;
  }

  if (ref.month === 12 && month === 1) return ref.year + 1;
  if (ref.month === 1 && month === 12 && ref.day <= 7) return ref.year - 1;
  return ref.year;
}

function buildDate(
  dayText: string | undefined,
  month: number | undefined,
  yearText: string | undefined,
  referenceDateIso: DateIso,
): DateIso | null {
  if (dayText === undefined || month === undefined) return null;
  const day = Number(dayText);
  const year = resolveYear(month, day, yearText, referenceDateIso);
  return formatValidCalendarDate(year, month, day);
}

/** Parses a post publication date such as `26 Лис 2026` or `26 листопада 2026`. */
export function extractPublishDate(text: string): DateIso | null {
  if (!text || !text.trim()) return null;
  const cleaned = cleanText(text);

  const word = PUBLISH_WORD_DATE.exec(cleaned);
  if (word) {
    const key = (word[2] ?? "").toLowerCase();
    const month = UKRAINIAN_MONTHS_SHORT[key] ?? UKRAINIAN_MONTHS_GENITIVE[key];
    if (month !== undefined) {
      const valid = formatValidCalendarDate(Number(word[3]), month, Number(word[1]));
      if (valid) return valid;
    }
  }

  const numeric = /(?<!\d)(\d{1,2})\.(\d{2})\.(\d{4})(?!\d)/.exec(cleaned);
  if (numeric) {
    return formatValidCalendarDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  }
  return null;
}

/**
 * Extracts the target schedule date (not the publication/update timestamp) from section text.
 * Priority: legacy `ГПВ-DD.MM.YY` marker → "на DD <місяця>" phrase → earliest valid
 * generic month phrase / numeric date.
 */
export function extractScheduleDate(text: string, referenceDateIso: DateIso): DateIso | null {
  if (!text || !text.trim()) return null;
  const cleaned = cleanText(text).replace(PARENTHETICAL_UPDATE, " ");

  const alt = ALT_DATE.exec(cleaned);
  if (alt) {
    const valid = buildDate(alt[1], Number(alt[2]), alt[3], referenceDateIso);
    if (valid) return valid;
  }

  const target = TARGET_MONTH_PHRASE.exec(cleaned);
  if (target) {
    const month = UKRAINIAN_MONTHS_GENITIVE[(target[2] ?? "").toLowerCase()];
    const valid = buildDate(target[1], month, target[3], referenceDateIso);
    if (valid) return valid;
  }

  const candidates: Array<{ index: number; date: DateIso }> = [];

  for (const m of cleaned.matchAll(GENERAL_MONTH_PHRASE)) {
    const month = UKRAINIAN_MONTHS_GENITIVE[(m[2] ?? "").toLowerCase()];
    const date = buildDate(m[1], month, m[3], referenceDateIso);
    if (date) candidates.push({ index: m.index ?? 0, date });
  }
  for (const m of cleaned.matchAll(NUMERIC_DATE)) {
    const date = buildDate(m[1], Number(m[2]), m[3], referenceDateIso);
    if (date) candidates.push({ index: m.index ?? 0, date });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.date ?? null;
}
