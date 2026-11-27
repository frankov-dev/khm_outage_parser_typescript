import { describe, expect, it } from "vitest";
import { buildApiSnapshots } from "../../src/core/export";
import { validateDaySchedule } from "../../src/core/validation";
import { computeDataHash, computeStateHash } from "../../src/core/versioning";
import { makeDay } from "../fixtures/day-factory";

describe("core validation and hashing inside workerd", () => {
  it("validates a day with Zod v4 (jitless) without EvalError", async () => {
    const day = await makeDay({ date: "2026-11-27", intervals: { "1.1": [[360, 480]] } });
    expect(validateDaySchedule(day, { todayDate: "2026-11-27" })).toEqual({ ok: true, day });

    const broken = structuredClone(day);
    broken.queues["1.1"].offMinutes = 1;
    const result = validateDaySchedule(broken, { todayDate: "2026-11-27" });
    expect(result).toMatchObject({ ok: false, code: "OFF_MINUTES_MISMATCH" });
  });

  it("computes SHA-256 hashes with Web Crypto", async () => {
    const day = await makeDay({ date: "2026-11-27", intervals: { "1.1": [[360, 480]] } });
    const dataHash = await computeDataHash([day]);
    const a = await computeStateHash(dataHash, "2026-11-27", "2026-11-28");
    const b = await computeStateHash(dataHash, "2026-11-28", "2026-11-29");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it("builds all API snapshots", async () => {
    const day = await makeDay({ date: "2026-11-27", intervals: { "1.1": [[360, 480]] } });
    const snapshots = buildApiSnapshots({
      days: [day],
      sourceUrl: "https://hoe.com.ua/page/pogodinni-vidkljuchennja",
      todayDate: "2026-11-27",
      tomorrowDate: "2026-11-28",
      updatedAt: "2026-11-27T08:00:00+02:00",
      checkedAt: "2026-11-27T08:00:00+02:00",
      stateHash: "0123456789abcdef",
      dataHash: "fedcba9876543210",
    });
    expect(snapshots).toHaveLength(3 + 1 + 12);
  });
});
