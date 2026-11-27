import { z } from "zod";
import { parseDateIso } from "../time/kyiv-clock";
import { ALL_SUBQUEUES, type SubqueueId } from "../types/domain";

// Cloudflare Workers forbid `new Function()`; Zod must run without JIT.
z.config({ jitless: true });

export const dateIsoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => parseDateIso(value) !== null, { message: "Not a real calendar date" });

export const minuteIntervalSchema = z
  .tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)])
  .refine(([start, end]) => start < end, { message: "start must be before end" });

export const queueScheduleSchema = z.object({
  intervals: z.array(minuteIntervalSchema),
  offMinutes: z.number().int().min(0).max(1440),
});

const subqueueEnum = z.enum(ALL_SUBQUEUES);

// Explicit shape (not z.record) so that all 12 queues are required and unknown ones rejected.
const queuesShape = Object.fromEntries(
  ALL_SUBQUEUES.map((q) => [q, queueScheduleSchema] as const),
) as Record<SubqueueId, typeof queueScheduleSchema>;

export const queuesMapSchema = z.strictObject(queuesShape);

export const dayRevisionSchema = z.object({
  revNo: z.number().int().min(1),
  operationalMessage: z.string().nullable(),
  changedQueues: z.partialRecord(subqueueEnum, queueScheduleSchema),
  fullQueues: queuesMapSchema,
  recordedAt: z.string().min(1),
});

export const dayScheduleSchema = z.object({
  date: dateIsoSchema,
  status: z.enum(["ACTIVE", "NO_OUTAGES"]),
  operationalMessage: z.string().nullable(),
  queues: queuesMapSchema,
  revisionCount: z.number().int().min(1),
  changedQueues: z.array(subqueueEnum),
  contentHash: z.string().regex(/^[0-9a-f]{16}$/),
  sourceUrl: z.string().min(1),
  updatedAt: z.string().min(1),
  revisions: z.array(dayRevisionSchema).min(1),
});
