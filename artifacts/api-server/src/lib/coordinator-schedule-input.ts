import { z } from "zod/v4";

const fields = {
  interviewerId: z.string().min(1).nullable().optional(),
  interviewerName: z.string().max(200).nullable().optional(),
  location: z.string().max(2000).nullable().optional(),
  scheduledAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480),
  type: z.enum(["technical", "behavioral", "culture_fit", "portfolio", "ai_interview", "final"]),
  notes: z.string().max(10000).nullable().optional(),
};

export const CreateScheduleBody = z.object({
  ...fields,
  requestId: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
  applicationId: z.string().min(1),
  durationMinutes: fields.durationMinutes.default(60),
});

export const UpdateScheduleBody = z
  .object({
    ...fields,
    expectedVersion: z
      .string()
      .regex(/^v1_[0-9a-f]{64}$/)
      .optional(),
    scheduledAt: fields.scheduledAt.optional(),
    durationMinutes: fields.durationMinutes.optional(),
    type: fields.type.optional(),
    status: z
      .enum(["pending", "scheduled", "confirmed", "rescheduled", "cancelled", "completed"])
      .optional(),
    feedbackRating: z.number().int().min(1).max(5).nullable().optional(),
    feedbackNotes: z.string().max(10000).nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedVersion"),
    "Provide at least one schedule change.",
  );

export const ScheduleFeedbackBody = z.object({
  rating: z.number().int().min(1).max(5),
  notes: z.string().max(10000).nullable().optional(),
  expectedVersion: z
    .string()
    .regex(/^v1_[0-9a-f]{64}$/)
    .optional(),
});

export function assertFutureSchedule(scheduledAt: string, now = Date.now()) {
  const instant = new Date(scheduledAt).getTime();
  return Number.isFinite(instant) && instant > now;
}
