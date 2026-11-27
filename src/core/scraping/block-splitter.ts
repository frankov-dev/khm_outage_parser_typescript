import type { DateIso } from "../types/domain";
import type { DateSource, ExtractedSchedulePage, RawScheduleBlock } from "../types/extracted";
import { extractPublishDate, extractScheduleDate } from "../time/date-extractor";

const BOILERPLATE_PREFIXES: readonly string[] = [
  "електроенергія у підчерг",
  "наголошуємо, що головною причиною",
  "наголошуємо: причиною запровадження",
  "наголошуємо, хмельницька область",
  "наголошуємо, проінформувати заздалегідь",
  "для промислових споживачів",
  "зверніть увагу, це прогноз",
  "зверніть увагу: одна і та ж будівля",
  "нагадаємо, перевірити свою чергу",
  "шановні споживачі! радимо переглянути",
  "якщо ви виявили, що відключення",
  "будь ласка, коли розподіл електроенергії",
  "такі заходи є вимушеними",
  "енергетики країни працюють",
  "актуальна інформація щодо погодинних",
  "графік погодинних відключень не є єдиним",
  "важливо:",
  "відділ зв",
];

const CHECK_QUEUE = /перевірити\s+(?:свою\s+)?чергу/iu;
const INDUSTRIAL_LIMIT = "графік обмеження споживання електричної потужності";

const ANNOUNCEMENT_HEADER =
  /(?:за\s+розпорядженням|відповідно\s+до\s+розпорядження)\s+нек\s+[«"„]?укренерго/iu;
const SUBQUEUE_LINE = /(?:підчерг[аиу]|підчерзі)\s*[№#]?\s*\d\.\d/iu;
const MULTI_SUBQUEUE_LINE = /підчерг[аиу]?\s+\d\.\d\s*[,таі]/iu;

const CHANGE_LINE_KEYWORDS: readonly string[] = [
  "раніше",
  "пізніше",
  "довше",
  "триватим",
  "скасовано",
  "відмінено",
  "заживлення",
  "додатков",
  "розпочнеться",
  "розпочнуться",
  "почнеться",
  "почнуться",
  "починається",
  "починаються",
  "збільшено",
  "зменшено",
];

const EXTRAS_KEYWORDS: readonly string[] = [
  "підчерг",
  "підчерзі",
  "відключен",
  "знеструм",
  "раніше",
  "пізніше",
  "довше",
  "додатков",
  "збільшено",
  "зменшено",
  "оновлен",
  "укренерго",
  "розпоряджен",
  "триватим",
  "заживлення",
  "скасовано",
  "графік",
  "гпв",
  "вимкнен",
  "обмежен",
  "змін",
  "увага",
];

function normalizeForMatch(line: string): string {
  return line.replace(/[’‘ʼ]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function hasSubqueueWord(lower: string): boolean {
  return lower.includes("підчерг") || lower.includes("підчерзі");
}

function includesAny(lower: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => lower.includes(kw));
}

export function isBoilerplateLine(line: string): boolean {
  const lower = normalizeForMatch(line);
  if (CHECK_QUEUE.test(lower) || lower.includes(INDUSTRIAL_LIMIT)) return true;
  return BOILERPLATE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

interface SubSection {
  lines: string[];
  imageAlts: string[];
}

/** Splits a `<hr>` section further when a new "За розпорядженням НЕК «Укренерго»…" header appears. */
function splitByAnnouncementHeaders(lines: string[], imageAlts: string[]): SubSection[] {
  const subs: SubSection[] = [{ lines: [], imageAlts }];
  let sawSubqueue = false;

  for (const line of lines) {
    if (sawSubqueue && ANNOUNCEMENT_HEADER.test(line) && !SUBQUEUE_LINE.test(line)) {
      subs.push({ lines: [], imageAlts: [] });
      sawSubqueue = false;
    }
    const target = subs[subs.length - 1];
    if (target) target.lines.push(line);
    if (hasSubqueueWord(line.toLowerCase())) sawSubqueue = true;
  }
  return subs;
}

function resolveBlockDate(
  sub: SubSection,
  sectionText: string,
  page: ExtractedSchedulePage,
  contextRefDate: DateIso,
  referenceDateIso: DateIso,
): { date: DateIso; source: DateSource } {
  const fromText = extractScheduleDate(sectionText, contextRefDate);
  if (fromText) return { date: fromText, source: "text" };

  for (const alt of sub.imageAlts) {
    const fromAlt = extractScheduleDate(alt, contextRefDate);
    if (fromAlt) return { date: fromAlt, source: "image_alt" };
  }

  const fromHeading = page.heading ? extractScheduleDate(page.heading, contextRefDate) : null;
  if (fromHeading) return { date: fromHeading, source: "publish_context" };

  return { date: referenceDateIso, source: "fallback_today" };
}

export function extractRawBlocks(
  page: ExtractedSchedulePage,
  referenceDateIso: DateIso,
): RawScheduleBlock[] {
  const publishDate = page.publishDateText ? extractPublishDate(page.publishDateText) : null;
  const contextRefDate = publishDate ?? referenceDateIso;
  const blocks: RawScheduleBlock[] = [];

  for (const section of page.sections) {
    for (const sub of splitByAnnouncementHeaders(section.lines, section.imageAlts)) {
      const sectionText = sub.lines.join("\n");
      if (!hasSubqueueWord(sectionText.toLowerCase())) continue;

      const scheduleLines: string[] = [];
      const extrasLines: string[] = [];

      for (const line of sub.lines) {
        if (!line || isBoilerplateLine(line)) continue;
        const lower = line.toLowerCase();

        if (SUBQUEUE_LINE.test(line) || MULTI_SUBQUEUE_LINE.test(line)) {
          if (includesAny(lower, CHANGE_LINE_KEYWORDS)) extrasLines.push(line);
          else scheduleLines.push(line);
        } else if (includesAny(lower, EXTRAS_KEYWORDS)) {
          extrasLines.push(line);
        }
      }

      if (scheduleLines.length === 0 && extrasLines.length === 0) continue;

      const { date, source } = resolveBlockDate(
        sub,
        sectionText,
        page,
        contextRefDate,
        referenceDateIso,
      );
      blocks.push({
        date,
        dateSource: source,
        scheduleText: scheduleLines.join("\n"),
        extrasText: extrasLines.join("\n").trim(),
        sourceUrl: page.url,
      });
    }
  }

  return blocks;
}
