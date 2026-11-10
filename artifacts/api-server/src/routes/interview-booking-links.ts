import { Router, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { dbAdmin, interviewBookingLinksTable as links } from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { scheduleVersion } from "../lib/coordinator-schedule-version";
import {
  CandidateConfirmationError,
  candidateTimeVersion,
  assertCandidateTimeConfirmation,
} from "../lib/candidate-schedule-confirmation";
import { isJobApprovedForInterview } from "../lib/job-approval";
import { offeredTimesView } from "../lib/interview-offered-times";
import { rateLimit } from "../middlewares/rateLimit";
import {
  bookingLinkExpiry,
  bookingTokenHash,
  newBookingToken,
  BOOKING_TOKEN_PATTERN,
} from "../lib/interview-booking-link";
import {
  ownedSchedule,
  readOffer,
  chooseOfferedTime,
  handleError,
} from "./interview-offered-times";

const router = Router();
const revision = z.string().regex(/^v1_[a-f0-9]{64}$/);
const staffInput = z
  .object({
    expectedVersion: revision,
    expectedOfferVersion: z.string().nullable(),
    expectedLinkVersion: z.string().nullable(),
  })
  .strict();
const tokenInput = z.object({ token: z.string().regex(BOOKING_TOKEN_PATTERN) }).strict();
const choiceInput = tokenInput
  .extend({
    confirm: z.literal(true),
    expectedVersion: revision,
    expectedOfferVersion: z.string().nullable(),
    scheduledAt: z.string().datetime({ offset: true }),
  })
  .strict();
type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Grant = typeof links.$inferSelect;
const unavailable = () =>
  new CandidateConfirmationError(
    404,
    "This booking link is unavailable. Ask your recruiter for a new link.",
  );

async function readLink(tx: Tx, scheduleId: string) {
  const [grant] = await tx.select().from(links).where(eq(links.scheduleId, scheduleId));
  return grant;
}

// Partial migrations must not leave a working capability without revocation
// and erasure hooks. Metadata only; no schema repair at runtime.
async function requireLinkGuards(tx: Tx) {
  const result = await tx.execute(sql`
    SELECT count(*)::int AS guards
    FROM (VALUES
      ('interview_booking_links','lexy_erasure_write_barrier',23),
      ('interview_schedules','lexy_booking_schedule_invalidation',17),
      ('applications','lexy_booking_application_invalidation',17),
      ('interview_offered_times','lexy_booking_offer_invalidation',29)
    ) expected(table_name,trigger_name,kind)
    JOIN pg_trigger t ON t.tgrelid=to_regclass(expected.table_name)
      AND t.tgname=expected.trigger_name AND t.tgtype=expected.kind
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
    JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE p.proname=CASE WHEN expected.table_name='interview_booking_links'
      THEN 'lexy_erasure_write_barrier' ELSE 'lexy_invalidate_interview_booking_link' END
      AND p.prosecdef
      AND p.pronamespace=(SELECT relnamespace FROM pg_class
        WHERE oid=to_regclass('interview_booking_links'))
      AND EXISTS (SELECT 1 FROM pg_class c
        WHERE c.oid=to_regclass('interview_booking_links')
          AND c.relrowsecurity AND c.relforcerowsecurity
          AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
          AND NOT has_table_privilege('lexy_app',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          AND NOT has_any_column_privilege('lexy_app',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
  `);
  if (Number(result.rows[0]?.guards) !== 4)
    throw new CandidateConfirmationError(
      503,
      "Interview booking links are temporarily unavailable. Contact your recruiter.",
    );
}

function status(grant: Grant | undefined, now: number) {
  return {
    version: grant?.version ?? null,
    active: !!grant && !grant.usedAt && grant.expiresAt.getTime() > now,
    expiresAt: grant?.expiresAt.toISOString() ?? null,
  };
}

const staffPath = "/coordinator/schedules/:scheduleId/booking-link";
router.get(staffPath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    await getDataScopeTenantIds(caller);
    res.json(
      await dbAdmin.transaction(async (tx) => {
        const row = await ownedSchedule(tx, String(req.params.scheduleId), caller, false);
        await requireLinkGuards(tx);
        return status(await readLink(tx, row.schedule.id), row.now);
      }),
    );
  } catch (error) {
    bookingError(error, res, next);
  }
});

for (const method of ["post", "delete"] as const) {
  router[method](staffPath, async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const caller = await calendarStaff(getAuthUserId(req));
      await getDataScopeTenantIds(caller);
      const input = staffInput.parse(req.body);
      const result = await dbAdmin.transaction(async (tx) => {
        const row = await ownedSchedule(tx, String(req.params.scheduleId), caller, true);
        await requireLinkGuards(tx);
        const proposal = offeredTimesView(
          row.schedule,
          row.candidateId,
          row.schedule.applicationId,
          await readOffer(tx, row.schedule.id),
          row.now,
        );
        const old = await readLink(tx, row.schedule.id);
        if (
          scheduleVersion(row.schedule) !== input.expectedVersion ||
          proposal.offerVersion !== input.expectedOfferVersion ||
          (old?.version ?? null) !== input.expectedLinkVersion
        )
          throw new CandidateConfirmationError(
            409,
            "This proposal or booking link changed. Reload before continuing.",
          );
        if (method === "delete") {
          await tx.delete(links).where(eq(links.scheduleId, row.schedule.id));
          return status(undefined, row.now);
        }
        const token = newBookingToken();
        const expiresAt = bookingLinkExpiry(row.now, proposal);
        const grant = {
          scheduleId: row.schedule.id,
          candidateId: row.candidateId,
          applicationId: row.schedule.applicationId,
          proposalVersion: proposal.version,
          offerVersion: proposal.offerVersion,
          version: randomUUID(),
          tokenHash: bookingTokenHash(token),
          expiresAt,
          usedAt: null,
          selectedAt: null,
          confirmedVersion: null,
        };
        await tx.insert(links).values(grant).onConflictDoUpdate({
          target: links.scheduleId,
          set: grant,
        });
        return { version: grant.version, active: true, expiresAt: expiresAt.toISOString(), token };
      });
      res.json(result);
    } catch (error) {
      bookingError(error, res, next);
    }
  });
}

export async function resolveLink(tx: Tx, token: string, lock: boolean) {
  const hash = bookingTokenHash(token);
  const [initial] = await tx.select().from(links).where(eq(links.tokenHash, hash));
  if (!initial) throw unavailable();
  let row;
  try {
    row = await ownedSchedule(tx, initial.scheduleId, initial.candidateId, lock, false);
  } catch (error) {
    if (error instanceof CandidateConfirmationError) throw unavailable();
    throw error;
  }
  await requireLinkGuards(tx);
  // Schedule lock comes first for every writer. Re-read after any lock wait.
  const grant = await readLink(tx, initial.scheduleId);
  if (
    !grant ||
    grant.tokenHash !== hash ||
    grant.applicationId !== row.schedule.applicationId ||
    grant.candidateId !== row.candidateId ||
    grant.expiresAt.getTime() <= row.now ||
    !isJobApprovedForInterview(row.jobStatus)
  )
    throw unavailable();
  if (grant.usedAt) {
    if (
      !grant.selectedAt ||
      !grant.confirmedVersion ||
      row.schedule.status !== "confirmed" ||
      row.schedule.scheduledAt.getTime() !== grant.selectedAt.getTime() ||
      candidateTimeVersion(row.schedule) !== grant.confirmedVersion
    )
      throw unavailable();
    return {
      row,
      grant,
      proposal: null,
      receipt: {
        scheduleId: row.schedule.id,
        status: "confirmed" as const,
        scheduledAt: grant.selectedAt.toISOString(),
        durationMinutes: row.schedule.durationMinutes,
        version: grant.confirmedVersion,
        calendarReserved: false as const,
        invitationSent: false as const,
      },
    };
  }
  try {
    assertCandidateTimeConfirmation(row.schedule, grant.proposalVersion, row.jobStatus, row.now);
  } catch (error) {
    if (error instanceof CandidateConfirmationError) throw unavailable();
    throw error;
  }
  const proposal = offeredTimesView(
    row.schedule,
    row.candidateId,
    row.schedule.applicationId,
    await readOffer(tx, row.schedule.id),
    row.now,
  );
  if (proposal.version !== grant.proposalVersion || proposal.offerVersion !== grant.offerVersion)
    throw unavailable();
  return { row, grant, proposal, receipt: null };
}

const publicLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyFn: (req) => req.ip ?? "unknown",
  scope: "public-interview-booking",
});
router.post("/public/interview-booking/read", publicLimit, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const input = tokenInput.safeParse(req.body);
    if (!input.success) throw unavailable();
    res.json(
      await dbAdmin.transaction(async (tx) => {
        const found = await resolveLink(tx, input.data.token, true);
        return {
          state: found.receipt ? "confirmed" : "offered",
          expiresAt: found.grant.expiresAt.toISOString(),
          proposal: found.proposal,
          receipt: found.receipt,
        };
      }),
    );
  } catch (error) {
    bookingError(error, res, next);
  }
});
router.post("/public/interview-booking/choose", publicLimit, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const input = choiceInput.parse(req.body);
    res.json(
      await dbAdmin.transaction(async (tx) => {
        const found = await resolveLink(tx, input.token, true);
        if (found.receipt) {
          if (
            input.expectedVersion !== found.grant.proposalVersion ||
            input.expectedOfferVersion !== found.grant.offerVersion ||
            new Date(input.scheduledAt).getTime() !== found.grant.selectedAt!.getTime()
          )
            throw new CandidateConfirmationError(
              409,
              "A different time was already confirmed. Ask your recruiter to change it.",
            );
          return found.receipt;
        }
        return chooseOfferedTime(
          tx,
          found.grant.scheduleId,
          found.grant.candidateId,
          input,
          async (current, selected) => {
            if (found.grant.expiresAt.getTime() <= current.now) throw unavailable();
            const [claimed] = await tx
              .update(links)
              .set({
                usedAt: new Date(current.now),
                selectedAt: new Date(selected),
                confirmedVersion: candidateTimeVersion({
                  ...current.schedule,
                  status: "confirmed",
                  scheduledAt: new Date(selected),
                }),
              })
              .where(
                and(
                  eq(links.tokenHash, found.grant.tokenHash),
                  sql`${links.expiresAt} > clock_timestamp()`,
                ),
              )
              .returning();
            if (!claimed) throw unavailable();
          },
        );
      }),
    );
  } catch (error) {
    bookingError(error, res, next);
  }
});

function bookingError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Provide a valid booking request." });
    return;
  }
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    const value = cause as { code?: string; message?: string; query?: string; cause?: unknown };
    if (
      (value.code === "42P01" && value.message?.includes("interview_booking_links")) ||
      (value.query?.includes('"interview_booking_links"') &&
        (value.cause as { code?: string })?.code === "42703")
    ) {
      res.status(503).json({
        error: "Interview booking links are temporarily unavailable. Contact your recruiter.",
      });
      return;
    }
    cause = value.cause;
  }
  handleError(error, res, next);
}
export default router;
