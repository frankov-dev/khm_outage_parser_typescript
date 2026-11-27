import { applyOperationalChanges, buildQueuesMap } from "../normalizing/interval-normalizer";
import type { DateIso, MinuteInterval, QueuesMap, SubqueueId } from "../types/domain";
import { ALL_SUBQUEUES } from "../types/domain";
import type { DateSource, RawScheduleBlock } from "../types/extracted";
import {
  extractSubqueueIds,
  NO_OUTAGE_PATTERN,
  parseOperationalChanges,
  type OperationalChange,
} from "./changes-parser";
import { extractTimeIntervals, parseTimeToMinutes } from "./interval-parser";

export interface ParsedBlock {
  date: DateIso;
  dateSource: DateSource;
  /** Full 12-queue map, or `null` when the block contains no usable schedule data. */
  queues: QueuesMap | null;
  mentionedQueues: SubqueueId[];
  explicitNoOutageQueues: SubqueueId[];
  hasExplicitCancellation: boolean;
  isAdditive: boolean;
  /** Minutes from midnight for "(оновлено з HH:MM)"; `null` when absent. */
  effectiveFromMin: number | null;
  operationalMessage: string | null;
  /** Shifts that could not be applied because the block has no base interval for the queue. */
  unappliedChanges: OperationalChange[];
}

const SUBQUEUE_WORD = /підчерг|підчерзі/iu;

const EFFECTIVE_FROM =
  /\([^)]*?(?<![\p{L}\d])(?:з|із|зі)\s*(\d{1,2}:\d{2})(?!\s*(?:до|по|[-–—]))[^)]*\)/iu;

const EXPLICIT_ADDITIVE_SECTION = /додаткові\s+години/iu;
const GENERAL_ADDITIVE_HEADER =
  /(?<![\p{L}\d])додатков[оіа](?![\p{L}\d])|збільшено\s+обсяг/iu;

function buildOperationalMessage(extrasText: string): string | null {
  const lines = extrasText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // A trailing "Додаткові години відсутності електроенергії:" is only a dangling sub-header.
  while (lines.length > 1 && lines[lines.length - 1]?.endsWith(":")) lines.pop();
  return lines.length > 0 ? lines.join("\n") : null;
}

export function parseScheduleBlock(block: RawScheduleBlock): ParsedBlock {
  const baseByQueue = new Map<SubqueueId, MinuteInterval[]>();
  const mentioned = new Set<SubqueueId>();
  const explicitNoOutage = new Set<SubqueueId>();
  let hasExplicitCancellation = false;

  for (const rawLine of block.scheduleText.split("\n")) {
    const line = rawLine.trim();
    if (!line || !SUBQUEUE_WORD.test(line)) continue;
    const queues = extractSubqueueIds(line);
    if (queues.length === 0) continue;

    const intervals = extractTimeIntervals(line);
    if (intervals.length > 0) {
      for (const q of queues) {
        baseByQueue.set(q, [...(baseByQueue.get(q) ?? []), ...intervals]);
        mentioned.add(q);
      }
    } else if (NO_OUTAGE_PATTERN.test(line)) {
      for (const q of queues) {
        if (!baseByQueue.has(q)) baseByQueue.set(q, []);
        explicitNoOutage.add(q);
        mentioned.add(q);
      }
      hasExplicitCancellation = true;
    }
  }

  const ops = parseOperationalChanges(block.extrasText);
  for (const { queue, interval } of ops.inlineBaseIntervals) {
    baseByQueue.set(queue, [...(baseByQueue.get(queue) ?? []), interval]);
  }
  for (const q of ops.mentionedQueues) mentioned.add(q);
  for (const q of ops.explicitNoOutageQueues) explicitNoOutage.add(q);
  hasExplicitCancellation = hasExplicitCancellation || ops.hasExplicitCancellation;

  const applied = applyOperationalChanges(baseByQueue, ops.changes);

  // Queues that exist in the base map but were not touched by any change keep their intervals.
  const finalByQueue = new Map<SubqueueId, MinuteInterval[]>();
  for (const [q, intervals] of baseByQueue) finalByQueue.set(q, intervals);
  for (const [q, intervals] of applied.intervalsByQueue) finalByQueue.set(q, intervals);

  const hasAnyIntervals = [...finalByQueue.values()].some((i) => i.length > 0);
  const hasUsableData =
    hasAnyIntervals || explicitNoOutage.size > 0 || applied.explicitlyClearedQueues.size > 0;
  const queues = hasUsableData ? buildQueuesMap(finalByQueue) : null;

  const mentionedQueues = ALL_SUBQUEUES.filter((q) => mentioned.has(q));
  const explicitNoOutageQueues = ALL_SUBQUEUES.filter((q) => explicitNoOutage.has(q));

  const effectiveMatch = EFFECTIVE_FROM.exec(block.extrasText);
  const effectiveFromMin = effectiveMatch
    ? parseTimeToMinutes(effectiveMatch[1] ?? "", { allowEndOfDay: false })
    : null;

  const headerText = block.extrasText
    .split("\n")
    .filter((l) => !SUBQUEUE_WORD.test(l))
    .join("\n");
  const partial = mentionedQueues.length < ALL_SUBQUEUES.length;
  const isAdditive =
    partial &&
    (EXPLICIT_ADDITIVE_SECTION.test(headerText) ||
      (GENERAL_ADDITIVE_HEADER.test(headerText) && hasAnyIntervals));

  return {
    date: block.date,
    dateSource: block.dateSource,
    queues,
    mentionedQueues,
    explicitNoOutageQueues,
    hasExplicitCancellation,
    isAdditive,
    effectiveFromMin,
    operationalMessage: buildOperationalMessage(block.extrasText),
    unappliedChanges: applied.unappliedChanges,
  };
}
