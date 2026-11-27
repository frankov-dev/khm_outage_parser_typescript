import { describe, expect, it } from "vitest";
import { buildApiSnapshots, MAX_HISTORY_DAYS, needsDayRollover } from "../../src/core/export";
import { buildQueuesMap } from "../../src/core/normalizing";
import { addCalendarDays } from "../../src/core/time";
import type {
  ApiCurrentResponse,
  ApiDayDetailResponse,
  ApiQueueResponse,
  ApiSchedulesListResponse,
  ApiStatusResponse,
} from "../../src/core/types/api";
import {
  ALL_SUBQUEUES,
  type DaySchedule,
  type MinuteInterval,
  type SubqueueId,
  type SyncStateRecord,
} from "../../src/core/types/domain";
import {
  computeDataHash,
  computeSparseQueuesDiff,
  computeStateHash,
  sha256Hex16,
} from "../../src/core/versioning";
import { makeDay } from "../fixtures/day-factory";

const TODAY = "2026-11-27";
const TOMORROW = "2026-11-28";
const SOURCE = "https://hoe.com.ua/page/pogodinni-vidkljuchennja";
const NOW = "2026-11-27T08:00:00+02:00";

function build(days: DaySchedule[], overrides: { todayDate?: string; tomorrowDate?: string } = {}) {
  return buildApiSnapshots({
    days,
    sourceUrl: SOURCE,
    todayDate: overrides.todayDate ?? TODAY,
    tomorrowDate: overrides.tomorrowDate ?? TOMORROW,
    updatedAt: NOW,
    checkedAt: NOW,
    stateHash: "state0123456789ab",
    dataHash: "data0123456789ab",
  });
}

function bodyOf<T>(snapshots: ReturnType<typeof build>, key: string): T {
  const snap = snapshots.find((s) => s.key === key);
  if (!snap) throw new Error(`missing snapshot ${key}`);
  return JSON.parse(snap.body) as T;
}

async function dayWithTwoRevisions(
  date: string,
  before: MinuteInterval[],
  after: MinuteInterval[],
): Promise<DaySchedule> {
  const first = await makeDay({ date, intervals: { "1.1": before }, message: "v1" });
  const q2 = buildQueuesMap(new Map<SubqueueId, MinuteInterval[]>([["1.1", after]]));
  return {
    ...first,
    operationalMessage: "v2",
    queues: q2,
    revisionCount: 2,
    changedQueues: computeSparseQueuesDiff(first.queues, q2).changedQueues,
    revisions: [
      first.revisions[0]!,
      {
        revNo: 2,
        operationalMessage: "v2",
        changedQueues: computeSparseQueuesDiff(first.queues, q2).diff,
        fullQueues: q2,
        recordedAt: NOW,
      },
    ],
  };
}

describe("buildApiSnapshots", () => {
  it("produces every expected key as minified valid JSON", async () => {
    const today = await makeDay({ date: TODAY, intervals: { "1.1": [[360, 480]] } });
    const older = await makeDay({ date: "2026-11-26", intervals: { "2.1": [[0, 60]] } });
    const snapshots = build([older, today]);

    expect(snapshots.map((s) => s.key).sort()).toEqual(
      [
        "status",
        "current",
        "history",
        `day:${TODAY}`,
        "day:2026-11-26",
        ...ALL_SUBQUEUES.map((q) => `queue:${q}`),
      ].sort(),
    );
    for (const s of snapshots) {
      expect(JSON.parse(s.body)).toBeTruthy();
      expect(s.body).not.toMatch(/\n|": /);
      expect(s.updatedAt).toBe(NOW);
    }
    expect(snapshots.find((s) => s.key === "status")?.etag).toBe("state0123456789ab");
    expect(snapshots.find((s) => s.key === "history")?.etag).toBe("data0123456789ab");
    expect(snapshots.find((s) => s.key === `day:${TODAY}`)?.etag).toBe(today.contentHash);
  });

  it("marks missing days UNAVAILABLE instead of falling back to another date", async () => {
    const yesterday = await makeDay({ date: "2026-11-26", intervals: { "1.1": [[0, 60]] } });
    const snapshots = build([yesterday]);

    const current = bodyOf<ApiCurrentResponse>(snapshots, "current");
    expect(current.today).toEqual({
      date: TODAY,
      status: "UNAVAILABLE",
      message: null,
      revisionCount: 0,
      changedQueues: [],
      queues: null,
    });
    expect(current.tomorrow.status).toBe("UNAVAILABLE");
    expect(current.availableDates).toEqual(["2026-11-26"]);

    const status = bodyOf<ApiStatusResponse>(snapshots, "status");
    expect(status.todayStatus).toBe("UNAVAILABLE");
    expect(status.hasTomorrow).toBe(false);
    expect(status.todayDate).toBe(TODAY);

    const queue = bodyOf<ApiQueueResponse>(snapshots, "queue:1.1");
    expect(queue.today).toEqual({
      date: TODAY,
      status: "UNAVAILABLE",
      message: null,
      intervals: null,
      offMinutes: null,
      prevIntervals: null,
      deltaMinutes: null,
    });
  });

  it("serves today and tomorrow together with their schedules", async () => {
    const today = await makeDay({ date: TODAY, intervals: { "1.1": [[360, 480]] }, message: "m" });
    const tomorrow = await makeDay({ date: TOMORROW, intervals: { "1.1": [[600, 720]] } });
    const snapshots = build([today, tomorrow]);
    const current = bodyOf<ApiCurrentResponse>(snapshots, "current");
    expect(current.today.status).toBe("ACTIVE");
    expect(current.today.message).toBe("m");
    expect(current.today.queues?.["1.1"].offMinutes).toBe(120);
    expect(current.tomorrow.queues?.["1.1"].intervals).toEqual([[600, 720]]);
    expect(bodyOf<ApiStatusResponse>(snapshots, "status").hasTomorrow).toBe(true);
  });

  it("precomputes prevIntervals and deltaMinutes per queue", async () => {
    const grown = await dayWithTwoRevisions(TODAY, [[360, 480]], [[360, 480], [1320, 1440]]);
    let queue = bodyOf<ApiQueueResponse>(build([grown]), "queue:1.1");
    expect(queue.today.prevIntervals).toEqual([[360, 480]]);
    expect(queue.today.intervals).toEqual([[360, 480], [1320, 1440]]);
    expect(queue.today.deltaMinutes).toBe(120);

    const shrunk = await dayWithTwoRevisions(TODAY, [[360, 480]], [[360, 420]]);
    queue = bodyOf<ApiQueueResponse>(build([shrunk]), "queue:1.1");
    expect(queue.today.deltaMinutes).toBe(-60);

    // Another queue did not change in the latest revision → no diff for it.
    const untouched = bodyOf<ApiQueueResponse>(build([grown]), "queue:2.1");
    expect(untouched.today.prevIntervals).toBeNull();
    expect(untouched.today.deltaMinutes).toBeNull();

    const single = await makeDay({ date: TODAY, intervals: { "1.1": [[360, 480]] } });
    expect(bodyOf<ApiQueueResponse>(build([single]), "queue:1.1").today.deltaMinutes).toBeNull();
  });

  it("exposes revisions in the day detail", async () => {
    const day = await dayWithTwoRevisions(TODAY, [[360, 480]], [[360, 480], [1320, 1440]]);
    const detail = bodyOf<ApiDayDetailResponse>(build([day]), `day:${TODAY}`);
    expect(detail.revisionCount).toBe(2);
    expect(detail.revisions.map((r) => [r.revNo, r.message])).toEqual([[1, "v1"], [2, "v2"]]);
    expect(Object.keys(detail.revisions[1]?.changedQueues ?? {})).toEqual(["1.1"]);
  });

  it("caps history at 14 days, newest first", async () => {
    const days: DaySchedule[] = [];
    for (let i = 0; i < 20; i++) {
      days.push(await makeDay({ date: addCalendarDays(TODAY, -i), intervals: { "1.1": [[0, 60]] } }));
    }
    const snapshots = build(days);
    const history = bodyOf<ApiSchedulesListResponse>(snapshots, "history");
    expect(history.schedules).toHaveLength(MAX_HISTORY_DAYS);
    expect(history.availableDates[0]).toBe(TODAY);
    expect(history.availableDates.at(-1)).toBe(addCalendarDays(TODAY, -13));
    expect(bodyOf<ApiStatusResponse>(snapshots, "status").availableDates).toHaveLength(14);
    expect(snapshots.filter((s) => s.key.startsWith("day:"))).toHaveLength(14);
  });
});

describe("hashes and rollover", () => {
  it("sha256Hex16 returns 16 lowercase hex chars deterministically", async () => {
    const a = await sha256Hex16("abc");
    expect(a).toBe("ba7816bf8f01cfea");
    expect(await sha256Hex16("abc")).toBe(a);
  });

  it("state hash changes at midnight even when the data hash does not", async () => {
    const day = await makeDay({ date: TODAY, intervals: { "1.1": [[0, 60]] } });
    const dataHash = await computeDataHash([day]);
    expect(await computeDataHash([day])).toBe(dataHash);
    const before = await computeStateHash(dataHash, "2026-11-27", "2026-11-28");
    const after = await computeStateHash(dataHash, "2026-11-28", "2026-11-29");
    expect(before).not.toBe(after);
    expect(await computeStateHash(dataHash, "2026-11-27", "2026-11-28")).toBe(before);
  });

  it("data hash depends on content but not on input order", async () => {
    const a = await makeDay({ date: "2026-11-26", intervals: { "1.1": [[0, 60]] } });
    const b = await makeDay({ date: TODAY, intervals: { "1.1": [[0, 120]] } });
    expect(await computeDataHash([a, b])).toBe(await computeDataHash([b, a]));
    const changed = await makeDay({ date: TODAY, intervals: { "1.1": [[0, 180]] } });
    expect(await computeDataHash([a, changed])).not.toBe(await computeDataHash([a, b]));
  });

  it("needsDayRollover detects single-day and multi-day idle gaps", () => {
    const state: SyncStateRecord = {
      parserVersion: "1",
      mainIrHash: null,
      newsIrHash: null,
      stateHash: "s",
      dataHash: "d",
      todayDate: "2026-11-27",
      tomorrowDate: "2026-11-28",
      lastSuccessAt: NOW,
      lastCheckedAt: NOW,
      lastOutcome: "SCHEDULE_UNCHANGED",
      consecutiveFailures: 0,
    };
    expect(needsDayRollover(null, "2026-11-27", "2026-11-28")).toBe(true);
    expect(needsDayRollover(state, "2026-11-27", "2026-11-28")).toBe(false);
    expect(needsDayRollover(state, "2026-11-28", "2026-11-29")).toBe(true);
    expect(needsDayRollover(state, "2026-12-01", "2026-12-02")).toBe(true);
  });
});
