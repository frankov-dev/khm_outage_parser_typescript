import { ALL_SUBQUEUES, type MinuteInterval, type SubqueueId } from "../types/domain";
import { extractTimeIntervals, parseEndTimeToMinutes, parseTimeToMinutes } from "./interval-parser";

export type OperationalChange =
  | { kind: "cancel_all"; queue: SubqueueId }
  | { kind: "cancel_range"; queue: SubqueueId; interval: MinuteInterval }
  | {
      kind: "replace_range";
      queue: SubqueueId;
      interval: MinuteInterval;
      mode: "widen_or_add" | "shift";
    }
  | {
      kind: "shift_start";
      queue: SubqueueId;
      newStartMin: number;
      direction: "earlier" | "later";
    }
  | {
      kind: "shift_end";
      queue: SubqueueId;
      newEndMin: number;
      direction: "earlier" | "later" | "any";
    }
  | { kind: "extra"; queue: SubqueueId; interval: MinuteInterval };

export interface ParsedOperationalChanges {
  changes: OperationalChange[];
  inlineBaseIntervals: Array<{ queue: SubqueueId; interval: MinuteInterval }>;
  mentionedQueues: SubqueueId[];
  explicitNoOutageQueues: SubqueueId[];
  hasExplicitCancellation: boolean;
}

export const NO_OUTAGE_PATTERN =
  /(?:вимкнень|відключень|знеструмлень)\s+немає|без\s+(?:вимкнень|відключень|знеструмлень)|не\s+вимика(?:ється|ються)|скасовано|відмінено|не\s+застосовуються/iu;

const SUBQUEUE_WORD = /підчерг|підчерзі/iu;
const TIME = String.raw`(\d{1,2}[:.]\d{2})`;

const ENTRY_SPLIT = new RegExp(
  [
    String.raw`\n+`,
    String.raw`;\s*(?=[-•]|\s*(?:у\s+)?підчер(?:г|зі)|\s*додатков)`,
    String.raw`\.\s+(?=(?:у\s+)?підчер(?:г|зі))`,
    String.raw`(?:,\s*(?:а\s+)?|\s+а\s+)(?=(?:у\s+)?підчер(?:г[аиу]|зі)\s*[№#]?\s*[1-6]\.[1-2])`,
  ].join("|"),
  "iu",
);

// 1a: "раніше/пізніше о 09:00 і триватиме до 16:00"
const FULL_CHANGE_WITH_SHIFT = new RegExp(
  String.raw`(раніше|пізніше)\s*[, -]*\s*о[б]?\s*${TIME}.+?триватим(?:е|уть)\s+до\s*${TIME}`,
  "iu",
);
// 1b: "відключення триватиме/триватимуть з 16:00 до 17:00"
const FULL_CHANGE_EXPLICIT = new RegExp(
  String.raw`(?:триватим(?:е|уть)|знеструмлен[аоі]|відключення)(?:\s+довше)?\s+(?:з|о[б]?)\s*${TIME}\s*(?:до|по|-)\s*${TIME}`,
  "iu",
);
// Power restoration (заживлення) — must be tested before outage-start patterns.
const RESTORATION = new RegExp(
  String.raw`(?:триватим(?:е|уть)(?:\s+довше)?\s*[, -]*\s*заживлення.+?о[б]?\s*${TIME})|` +
    String.raw`(?:заживлення(?:\s+споживачів)?(?:\s+(?:розпочнеться|почнеться|відбудеться))?(?:\s+(раніше|пізніше))?\s*[, -]*\s*о[б]?\s*${TIME})`,
  "iu",
);
const START_SHIFT = new RegExp(
  String.raw`(?:розпочнеться|розпочнуться|почнеться|почнуться|починається|починаються|знеструмлен[аоі])\s+(раніше|пізніше)\s*[, -]*\s*о[б]?\s*${TIME}`,
  "iu",
);
const EXTENDED_END = new RegExp(
  String.raw`триватим(?:е|уть)(?:\s+довше)?\s*[, -]*\s*до\s*${TIME}`,
  "iu",
);
const EXTRA_WORD = /(?<![\p{L}\d])додатков[оіа]?(?![\p{L}\d])/iu;
const SINGLE_CLOCK_TIME = /\d{1,2}:\d{2}/;

/** Subqueue ids (`1.1`..`6.2`). Rejects fragments of dates such as `2.2.2026`. */
export function extractSubqueueIds(text: string): SubqueueId[] {
  const found: SubqueueId[] = [];
  for (const m of text.matchAll(/(?<![\d.])([1-6]\.[1-2])(?!\d|\.\d)/g)) {
    const id = m[1] as SubqueueId;
    if ((ALL_SUBQUEUES as readonly string[]).includes(id) && !found.includes(id)) {
      found.push(id);
    }
  }
  return found;
}

function sortQueues(queues: Iterable<SubqueueId>): SubqueueId[] {
  const set = new Set(queues);
  return ALL_SUBQUEUES.filter((q) => set.has(q));
}

export function parseOperationalChanges(extrasText: string): ParsedOperationalChanges {
  const changes: OperationalChange[] = [];
  const inlineBaseIntervals: Array<{ queue: SubqueueId; interval: MinuteInterval }> = [];
  const mentioned = new Set<SubqueueId>();
  const explicitNoOutage = new Set<SubqueueId>();
  let hasExplicitCancellation = false;
  const seen = new Set<string>();

  const emit = (change: OperationalChange): void => {
    const key = JSON.stringify(change);
    if (seen.has(key)) return;
    seen.add(key);
    changes.push(change);
    mentioned.add(change.queue);
  };

  const text = extrasText.replace(/[–—]/g, "-");

  for (const rawEntry of text.split(ENTRY_SPLIT)) {
    const entry = rawEntry.trim();
    if (!entry || !SUBQUEUE_WORD.test(entry)) continue;
    const queues = extractSubqueueIds(entry);
    if (queues.length === 0) continue;

    // Pattern 0 — cancellations / explicit "no outages".
    if (NO_OUTAGE_PATTERN.test(entry)) {
      const parenGroups = [...entry.matchAll(/\(([^)]*)\)/g)].filter((m) =>
        NO_OUTAGE_PATTERN.test(m[1] ?? ""),
      );
      const insideIntervals = parenGroups.flatMap((m) => extractTimeIntervals(m[1] ?? ""));

      if (insideIntervals.length > 0) {
        // "Підчерга 1.1 – 10:00-14:00 (18:00-20:00 скасовано)": base outside, cancel inside.
        const outside = entry.replace(/\(([^)]*)\)/g, (full, inner: string) =>
          NO_OUTAGE_PATTERN.test(inner) ? " " : full,
        );
        for (const q of queues) {
          for (const interval of extractTimeIntervals(outside)) {
            inlineBaseIntervals.push({ queue: q, interval });
            mentioned.add(q);
          }
          for (const interval of insideIntervals) {
            emit({ kind: "cancel_range", queue: q, interval });
          }
        }
        hasExplicitCancellation = true;
        continue;
      }

      const ranges = extractTimeIntervals(entry);
      if (ranges.length > 0) {
        for (const q of queues) {
          for (const interval of ranges) emit({ kind: "cancel_range", queue: q, interval });
        }
        hasExplicitCancellation = true;
      } else if (!SINGLE_CLOCK_TIME.test(entry)) {
        for (const q of queues) {
          emit({ kind: "cancel_all", queue: q });
          explicitNoOutage.add(q);
        }
        hasExplicitCancellation = true;
      }
      // A cancellation with a single clock time cannot be applied safely: ignore, never wipe.
      continue;
    }

    // Pattern 1 — full change with an explicit interval.
    const shiftFull = FULL_CHANGE_WITH_SHIFT.exec(entry);
    const explicitFull = shiftFull ? null : FULL_CHANGE_EXPLICIT.exec(entry);
    if (shiftFull || explicitFull) {
      const startRaw = shiftFull ? shiftFull[2] : explicitFull?.[1];
      const endRaw = shiftFull ? shiftFull[3] : explicitFull?.[2];
      const startMin = parseTimeToMinutes(startRaw ?? "", { allowEndOfDay: false });
      const endMin = startMin === null ? null : parseEndTimeToMinutes(endRaw ?? "", startMin);
      if (startMin !== null && endMin !== null && startMin < endMin) {
        const mode = shiftFull?.[1]?.toLowerCase() === "пізніше" ? "shift" : "widen_or_add";
        for (const q of queues) {
          emit({ kind: "replace_range", queue: q, interval: [startMin, endMin], mode });
        }
        continue;
      }
    }

    // Pattern 2 — power restoration (checked before outage-start patterns).
    const restoration = RESTORATION.exec(entry);
    if (restoration) {
      const viaExtended = restoration[1] !== undefined;
      const rawTime = viaExtended ? restoration[1] : restoration[3];
      const keyword = restoration[2]?.toLowerCase();
      const direction: "earlier" | "later" | "any" = viaExtended
        ? "later"
        : keyword === "раніше"
          ? "earlier"
          : keyword === "пізніше"
            ? "later"
            : "any";
      const newEndMin = parseEndTimeToMinutes(rawTime ?? "");
      if (newEndMin !== null) {
        for (const q of queues) emit({ kind: "shift_end", queue: q, newEndMin, direction });
        continue;
      }
    }

    // Pattern 3 — outage starts earlier / later.
    const start = START_SHIFT.exec(entry);
    if (start) {
      const newStartMin = parseTimeToMinutes(start[2] ?? "", { allowEndOfDay: false });
      if (newStartMin !== null) {
        const direction = start[1]?.toLowerCase() === "раніше" ? "earlier" : "later";
        for (const q of queues) emit({ kind: "shift_start", queue: q, newStartMin, direction });
        continue;
      }
    }

    // Pattern 4 — outage lasts longer: "триватиме [довше] до HH:MM".
    const extended = EXTENDED_END.exec(entry);
    if (extended) {
      const newEndMin = parseEndTimeToMinutes(extended[1] ?? "");
      if (newEndMin !== null) {
        for (const q of queues) {
          emit({ kind: "shift_end", queue: q, newEndMin, direction: "later" });
        }
        continue;
      }
    }

    // Pattern 5 — additional outage intervals.
    if (EXTRA_WORD.test(entry)) {
      for (const interval of extractTimeIntervals(entry)) {
        for (const q of queues) emit({ kind: "extra", queue: q, interval });
      }
    }
  }

  return {
    changes,
    inlineBaseIntervals,
    mentionedQueues: sortQueues(mentioned),
    explicitNoOutageQueues: sortQueues(explicitNoOutage),
    hasExplicitCancellation,
  };
}
