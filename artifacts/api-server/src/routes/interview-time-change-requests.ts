import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { dbAdmin, interviewTimeChangeRequestsTable as requests } from "@workspace/db";
import { z } from "zod";
import {
  RequestCandidateTimeChangeBody,
  ReviewStaffTimeChangeRequestBody,
  WithdrawCandidateTimeChangeBody,
} from "@workspace/api-zod";
import { ownedSchedule, handleError } from "./interview-offered-times";
import { resolveLink } from "./interview-booking-links";
import { resolveCandidateId } from "../lib/portal-auth";
import { calendarStaff } from "../lib/calendar-staff";
import { getAuthUserId } from "../lib/auth-token";
import {
  candidateTimeVersion,
  CandidateConfirmationError,
} from "../lib/candidate-schedule-confirmation";
import { isJobApprovedForInterview } from "../lib/job-approval";
import { recordInterviewTimeConfirmation } from "../lib/interview-confirmation-notifications";
import { BOOKING_TOKEN_PATTERN } from "../lib/interview-booking-link";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();
type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Row = Awaited<ReturnType<typeof ownedSchedule>>;
const input = RequestCandidateTimeChangeBody.extend({
  confirm: z.literal(true),
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
}).strict();
const reviewInput = ReviewStaffTimeChangeRequestBody.extend({
  requestId: z.string().min(1).max(100),
}).strict();
const tokenInput = z.object({ token: z.string().regex(BOOKING_TOKEN_PATTERN) }).strict();
const publicInput = input.extend({ token: tokenInput.shape.token }).strict();
const withdrawalInput = WithdrawCandidateTimeChangeBody.extend({
  confirm: z.literal(true),
  requestId: z.string().min(1).max(100),
  expectedVersion: input.shape.expectedVersion,
}).strict();
const publicWithdrawalInput = withdrawalInput.extend({ token: tokenInput.shape.token }).strict();
const candidatePath = "/portal/interview-schedules/:scheduleId/time-change-request";
const staffPath = "/coordinator/schedules/:scheduleId/time-change-request";
const publicLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyFn: (req) => req.ip ?? "unknown",
  scope: "public-interview-time-change",
});

function scope(row: Row) {
  return and(
    eq(requests.scheduleId, row.schedule.id),
    eq(requests.candidateId, row.candidateId),
    eq(requests.applicationId, row.schedule.applicationId),
  );
}
function requestable(row: Row) {
  return (
    ["pending", "confirmed"].includes(row.schedule.status) &&
    row.schedule.type !== "ai_interview" &&
    row.schedule.durationMinutes >= 5 &&
    row.schedule.durationMinutes <= 480 &&
    isJobApprovedForInterview(row.jobStatus) &&
    row.schedule.scheduledAt.getTime() > row.now
  );
}
export async function timeChangeView(tx: Tx, row: Row, staff = false) {
  const version = candidateTimeVersion(row.schedule);
  const [request] = await tx
    .select()
    .from(requests)
    .where(and(scope(row), staff ? undefined : eq(requests.proposalVersion, version)))
    .orderBy(desc(requests.requestedAt), desc(requests.id))
    .limit(1);
  return {
    scheduleId: row.schedule.id,
    version,
    scheduledAt: row.schedule.scheduledAt.toISOString(),
    durationMinutes: row.schedule.durationMinutes,
    canRequest: requestable(row) && (!request || request.proposalVersion !== version),
    canWithdraw:
      !!request &&
      requestable(row) &&
      request.proposalVersion === version &&
      request.reviewedAt === null &&
      request.withdrawnAt === null,
    request: request
      ? {
          id: request.id,
          requestedAt: request.requestedAt.toISOString(),
          reviewedAt: request.reviewedAt?.toISOString() ?? null,
          withdrawnAt: request.withdrawnAt?.toISOString() ?? null,
          currentProposal: request.proposalVersion === version,
        }
      : null,
    appointmentChanged: false as const,
    invitationSent: false as const,
  };
}
export async function requestTimeChange(tx: Tx, row: Row, expectedVersion: string) {
  if (!requestable(row) || candidateTimeVersion(row.schedule) !== expectedVersion)
    throw new CandidateConfirmationError(
      409,
      "This interview changed or is no longer upcoming. Reload before requesting a different time.",
    );
  const [saved] = await tx
    .insert(requests)
    .values({
      scheduleId: row.schedule.id,
      candidateId: row.candidateId,
      applicationId: row.schedule.applicationId,
      proposalVersion: expectedVersion,
    })
    .onConflictDoNothing()
    .returning({ id: requests.id });
  // The request, action evidence and scoped in-app alert are one transaction.
  // Lost-response retries for the same proposal never repeat alerts or actions.
  if (saved)
    await recordInterviewTimeConfirmation(tx, row.schedule, row.candidateId, "change_requested");
  return timeChangeView(tx, row);
}
async function candidate(req: import("express").Request) {
  const id = await resolveCandidateId(req);
  if (!id) throw new CandidateConfirmationError(401, "Candidate sign-in required.");
  return id;
}
async function withdrawTimeChange(tx: Tx, row: Row, body: z.infer<typeof withdrawalInput>) {
  if (!requestable(row) || candidateTimeVersion(row.schedule) !== body.expectedVersion)
    throw new CandidateConfirmationError(409, "This interview changed. Reload before withdrawing.");
  const [existing] = await tx
    .select()
    .from(requests)
    .where(and(scope(row), eq(requests.id, body.requestId)))
    .limit(1);
  if (!existing) throw new CandidateConfirmationError(404, "Time-change request not found.");
  if (existing.proposalVersion !== body.expectedVersion || existing.reviewedAt)
    throw new CandidateConfirmationError(
      409,
      "This request changed or was already reviewed. Reload status.",
    );
  if (!existing.withdrawnAt) {
    const [changed] = await tx
      .update(requests)
      .set({ withdrawnAt: new Date(row.now) })
      .where(
        and(
          scope(row),
          eq(requests.id, body.requestId),
          eq(requests.proposalVersion, body.expectedVersion),
          isNull(requests.reviewedAt),
          isNull(requests.withdrawnAt),
        ),
      )
      .returning({ id: requests.id });
    if (!changed) throw new CandidateConfirmationError(409, "This request changed. Reload status.");
    await recordInterviewTimeConfirmation(tx, row.schedule, row.candidateId, "change_withdrawn");
  }
  return timeChangeView(tx, row);
}
router.post(`${candidatePath}/withdraw`, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const id = await candidate(req);
    const body = withdrawalInput.parse(req.body);
    res.json(
      await dbAdmin.transaction(async (tx) =>
        withdrawTimeChange(
          tx,
          await ownedSchedule(tx, String(req.params.scheduleId), id, true, false),
          body,
        ),
      ),
    );
  } catch (e) {
    failure(e, res, next);
  }
});
router.post(
  "/public/interview-booking/time-change/withdraw",
  publicLimit,
  async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const body = publicWithdrawalInput.parse(req.body);
      res.json(
        await dbAdmin.transaction(async (tx) =>
          withdrawTimeChange(tx, (await resolveLink(tx, body.token, true)).row, body),
        ),
      );
    } catch (e) {
      failure(e, res, next);
    }
  },
);
router.get(candidatePath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const id = await candidate(req);
    res.json(
      await dbAdmin.transaction(async (tx) =>
        timeChangeView(
          tx,
          await ownedSchedule(tx, String(req.params.scheduleId), id, false, false),
        ),
      ),
    );
  } catch (e) {
    failure(e, res, next);
  }
});
router.post(candidatePath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const id = await candidate(req);
    const body = input.parse(req.body);
    res.json(
      await dbAdmin.transaction(async (tx) =>
        requestTimeChange(
          tx,
          await ownedSchedule(tx, String(req.params.scheduleId), id, true, false),
          body.expectedVersion,
        ),
      ),
    );
  } catch (e) {
    failure(e, res, next);
  }
});
router.get(staffPath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const staff = await calendarStaff(getAuthUserId(req));
    res.json(
      await dbAdmin.transaction(async (tx) =>
        timeChangeView(
          tx,
          await ownedSchedule(tx, String(req.params.scheduleId), staff, false, false),
          true,
        ),
      ),
    );
  } catch (e) {
    failure(e, res, next);
  }
});
router.post(staffPath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const staff = await calendarStaff(getAuthUserId(req));
    const body = reviewInput.parse(req.body);
    res.json(
      await dbAdmin.transaction(async (tx) => {
        const row = await ownedSchedule(tx, String(req.params.scheduleId), staff, true, false);
        const [saved] = await tx
          .update(requests)
          .set({ reviewedAt: new Date(row.now), reviewedBy: staff.id })
          .where(
            and(
              scope(row),
              eq(requests.id, body.requestId),
              isNull(requests.reviewedAt),
              isNull(requests.withdrawnAt),
            ),
          )
          .returning({ id: requests.id });
        if (!saved) {
          const [existing] = await tx
            .select({ id: requests.id, withdrawnAt: requests.withdrawnAt })
            .from(requests)
            .where(and(scope(row), eq(requests.id, body.requestId)))
            .limit(1);
          if (!existing)
            throw new CandidateConfirmationError(404, "Time-change request not found.");
          if (existing.withdrawnAt)
            throw new CandidateConfirmationError(
              409,
              "The candidate withdrew this request. Reload status.",
            );
        }
        return timeChangeView(tx, row, true);
      }),
    );
  } catch (e) {
    failure(e, res, next);
  }
});
for (const write of [false, true]) {
  router.post(
    `/public/interview-booking/time-change${write ? "" : "/read"}`,
    publicLimit,
    async (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      try {
        const body = (write ? publicInput : tokenInput).parse(req.body);
        res.json(
          await dbAdmin.transaction(async (tx) => {
            const found = await resolveLink(tx, body.token, true);
            return write
              ? requestTimeChange(
                  tx,
                  found.row,
                  (body as z.infer<typeof publicInput>).expectedVersion,
                )
              : timeChangeView(tx, found.row);
          }),
        );
      } catch (e) {
        failure(e, res, next);
      }
    },
  );
}
function failure(
  error: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Confirm a current interview time-change request." });
    return;
  }
  let cause = error;
  for (let i = 0; i < 6 && cause && typeof cause === "object"; i++) {
    const value = cause as { code?: string; cause?: unknown };
    if (value.code === "42P01" || value.code === "42703") {
      res.status(503).json({
        error:
          "Time-change requests are temporarily unavailable. Contact your recruiter or try again later.",
      });
      return;
    }
    cause = value.cause;
  }
  handleError(error, res, next);
}
export default router;
