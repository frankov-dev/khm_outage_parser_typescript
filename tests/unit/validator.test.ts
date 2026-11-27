import { describe, expect, it } from "vitest";
import { validateDaySchedule } from "../../src/core/validation";
import type { DaySchedule } from "../../src/core/types/domain";
import { makeDay } from "../fixtures/day-factory";

const TODAY = "2026-11-27";

async function activeDay(): Promise<DaySchedule> {
  return makeDay({ date: TODAY, intervals: { "1.1": [[360, 480], [660, 840]], "2.1": [[1320, 1440]] } });
}

function clone(day: DaySchedule): DaySchedule {
  return structuredClone(day);
}

function failureCode(day: DaySchedule, options: Parameters<typeof validateDaySchedule>[1] = { todayDate: TODAY }) {
  const result = validateDaySchedule(day, options);
  return result.ok ? "OK" : result.code;
}

describe("validateDaySchedule", () => {
  it("accepts a valid ACTIVE day", async () => {
    const day = await activeDay();
    const result = validateDaySchedule(day, { todayDate: TODAY });
    expect(result).toEqual({ ok: true, day });
  });

  it("accepts a valid NO_OUTAGES day", async () => {
    const day = await makeDay({ date: TODAY });
    expect(day.status).toBe("NO_OUTAGES");
    expect(failureCode(day)).toBe("OK");
  });

  it("rejects malformed structures and impossible dates", async () => {
    const badDate = clone(await activeDay());
    badDate.date = "2026-02-30";
    expect(failureCode(badDate)).toBe("SCHEMA_INVALID");

    const missingQueue = clone(await activeDay()) as unknown as { queues: Record<string, unknown> };
    delete missingQueue.queues["6.2"];
    expect(failureCode(missingQueue as unknown as DaySchedule)).toBe("SCHEMA_INVALID");

    const extraQueue = clone(await activeDay()) as unknown as { queues: Record<string, unknown> };
    extraQueue.queues["7.1"] = { intervals: [], offMinutes: 0 };
    expect(failureCode(extraQueue as unknown as DaySchedule)).toBe("SCHEMA_INVALID");

    const badInterval = clone(await activeDay());
    badInterval.queues["1.1"].intervals = [[500, 400]];
    expect(failureCode(badInterval)).toBe("SCHEMA_INVALID");
  });

  it("rejects dates outside the accepted window", async () => {
    const past = await makeDay({ date: "2026-10-20", intervals: { "1.1": [[0, 60]] } });
    const future = await makeDay({ date: "2026-12-10", intervals: { "1.1": [[0, 60]] } });
    expect(failureCode(past)).toBe("DATE_OUT_OF_RANGE");
    expect(failureCode(future)).toBe("DATE_OUT_OF_RANGE");
    expect(failureCode(past, { todayDate: TODAY, maxPastDays: 60 })).toBe("OK");
  });

  it("rejects unsorted, overlapping and contiguous intervals", async () => {
    for (const intervals of [
      [[600, 700], [0, 100]],
      [[0, 100], [50, 200]],
      [[0, 100], [100, 200]],
    ] as Array<Array<[number, number]>>) {
      const day = clone(await activeDay());
      day.queues["1.1"].intervals = intervals;
      day.queues["1.1"].offMinutes = intervals.reduce((s, i) => s + i[1] - i[0], 0);
      expect(failureCode(day)).toBe("INTERVAL_ORDER_OR_OVERLAP");
    }
  });

  it("rejects an offMinutes mismatch", async () => {
    const day = clone(await activeDay());
    day.queues["1.1"].offMinutes += 1;
    expect(failureCode(day)).toBe("OFF_MINUTES_MISMATCH");
  });

  it("rejects an inconsistent status", async () => {
    const active = clone(await activeDay());
    active.status = "NO_OUTAGES";
    expect(failureCode(active)).toBe("STATUS_MISMATCH");

    const empty = clone(await makeDay({ date: TODAY }));
    empty.status = "ACTIVE";
    expect(failureCode(empty)).toBe("STATUS_MISMATCH");
  });

  it("rejects broken revision invariants", async () => {
    const wrongCount = clone(await activeDay());
    wrongCount.revisionCount = 2;
    expect(failureCode(wrongCount)).toBe("REVISION_INVARIANT_VIOLATION");

    const wrongNumber = clone(await activeDay());
    wrongNumber.revisions[0]!.revNo = 2;
    expect(failureCode(wrongNumber)).toBe("REVISION_INVARIANT_VIOLATION");

    const duplicate = clone(await activeDay());
    duplicate.revisions.push({ ...clone(duplicate).revisions[0]!, revNo: 2 });
    duplicate.revisionCount = 2;
    expect(failureCode(duplicate)).toBe("REVISION_INVARIANT_VIOLATION");

    const mismatchedLast = clone(await activeDay());
    mismatchedLast.revisions[0]!.fullQueues["1.1"].intervals = [[0, 60]];
    mismatchedLast.revisions[0]!.fullQueues["1.1"].offMinutes = 60;
    expect(failureCode(mismatchedLast)).toBe("REVISION_INVARIANT_VIOLATION");
  });

  it("refuses to silently replace an active schedule with an empty one", async () => {
    const existing = await activeDay();
    const empty = await makeDay({ date: TODAY });
    expect(failureCode(empty, { todayDate: TODAY, existingDay: existing })).toBe("SUSPICIOUS_ZEROING");
    expect(
      failureCode(empty, { todayDate: TODAY, existingDay: existing, hasExplicitCancellation: false }),
    ).toBe("SUSPICIOUS_ZEROING");
    expect(
      failureCode(empty, { todayDate: TODAY, existingDay: existing, hasExplicitCancellation: true }),
    ).toBe("OK");
  });

  it("allows an empty day when nothing active existed before", async () => {
    const empty = await makeDay({ date: TODAY });
    const previouslyEmpty = await makeDay({ date: TODAY });
    expect(failureCode(empty, { todayDate: TODAY, existingDay: previouslyEmpty })).toBe("OK");
    expect(failureCode(empty, { todayDate: TODAY, existingDay: null })).toBe("OK");
  });
});
