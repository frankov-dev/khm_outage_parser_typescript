import { describe, expect, it } from "vitest";
import {
  applyOperationalChanges,
  buildQueuesMap,
  calculateOffMinutes,
  findNearestIntervalIndex,
  intervalsOverlap,
  mergeOverlappingIntervals,
  subtractInterval,
} from "../../src/core/normalizing";
import { ALL_SUBQUEUES, type MinuteInterval, type SubqueueId } from "../../src/core/types/domain";

describe("mergeOverlappingIntervals", () => {
  it("merges overlapping and contiguous intervals", () => {
    expect(mergeOverlappingIntervals([[600, 840], [780, 960]])).toEqual([[600, 960]]);
    expect(mergeOverlappingIntervals([[600, 840], [840, 960]])).toEqual([[600, 960]]);
  });

  it("sorts and deduplicates", () => {
    expect(mergeOverlappingIntervals([[900, 960], [600, 700], [600, 700]])).toEqual([
      [600, 700],
      [900, 960],
    ]);
  });

  it("drops invalid intervals", () => {
    expect(
      mergeOverlappingIntervals([[10, 10], [20, 10], [-5, 30], [0, 1441], [100, 200]]),
    ).toEqual([[100, 200]]);
  });
});

describe("subtractInterval", () => {
  const base: MinuteInterval[] = [[600, 840]];
  it("splits in the middle", () => {
    expect(subtractInterval(base, [660, 720])).toEqual([[600, 660], [720, 840]]);
  });
  it("trims left and right", () => {
    expect(subtractInterval(base, [540, 660])).toEqual([[660, 840]]);
    expect(subtractInterval(base, [780, 900])).toEqual([[600, 780]]);
  });
  it("wipes a fully covered interval and keeps disjoint ones", () => {
    expect(subtractInterval(base, [500, 900])).toEqual([]);
    expect(subtractInterval(base, [900, 960])).toEqual([[600, 840]]);
  });
  it("ignores an empty cancel range", () => {
    expect(subtractInterval(base, [700, 700])).toEqual([[600, 840]]);
  });
});

describe("calculateOffMinutes / intervalsOverlap", () => {
  it("sums exact integer minutes", () => {
    expect(calculateOffMinutes([[0, 240], [570, 780], [1320, 1440]])).toBe(240 + 210 + 120);
    expect(calculateOffMinutes([[570, 1140]])).toBe(570);
    expect(calculateOffMinutes([])).toBe(0);
  });
  it("detects overlap but not touching intervals", () => {
    expect(intervalsOverlap([0, 10], [5, 15])).toBe(true);
    expect(intervalsOverlap([0, 10], [10, 15])).toBe(false);
  });
});

describe("findNearestIntervalIndex", () => {
  it("never selects an interval that would become invalid", () => {
    // 12:00 is after the end of 08:00-11:00, so only the second interval is a candidate.
    expect(findNearestIntervalIndex([[480, 660], [960, 1200]], 720, "start", "earlier")).toBe(1);
    expect(findNearestIntervalIndex([[480, 660]], 400, "end", "later")).toBeNull();
  });

  it("direction 'any' applies no natural-direction penalty", () => {
    const intervals: MinuteInterval[] = [[360, 600], [660, 900]];
    expect(findNearestIntervalIndex(intervals, 840, "end", "any")).toBe(1);
  });
});

describe("applyOperationalChanges", () => {
  const q = (id: SubqueueId, ...i: MinuteInterval[]) => new Map<SubqueueId, MinuteInterval[]>([[id, i]]);

  it("reports shifts for queues without base intervals as unapplied", () => {
    const change = { kind: "shift_start", queue: "1.1", newStartMin: 600, direction: "earlier" } as const;
    const result = applyOperationalChanges(new Map(), [change]);
    expect(result.unappliedChanges).toEqual([change]);
    expect(result.intervalsByQueue.get("1.1")).toEqual([]);
  });

  it("cancel_all clears the queue and marks it explicit", () => {
    const result = applyOperationalChanges(q("2.1", [720, 960]), [{ kind: "cancel_all", queue: "2.1" }]);
    expect(result.intervalsByQueue.get("2.1")).toEqual([]);
    expect(result.explicitlyClearedQueues.has("2.1")).toBe(true);
  });
});

describe("buildQueuesMap", () => {
  it("always contains all 12 queues in canonical order", () => {
    const map = buildQueuesMap(new Map<SubqueueId, MinuteInterval[]>([["3.1", [[0, 60], [60, 120]]]]));
    expect(Object.keys(map)).toEqual([...ALL_SUBQUEUES]);
    expect(map["3.1"]).toEqual({ intervals: [[0, 120]], offMinutes: 120 });
    expect(map["1.1"]).toEqual({ intervals: [], offMinutes: 0 });
  });
});
