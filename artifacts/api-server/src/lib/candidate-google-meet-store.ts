import { and, eq, isNull, or } from "drizzle-orm";
import {
  dbAdmin,
  applicationsTable as applications,
  candidatesTable as candidates,
  interviewSchedulesTable as schedules,
  jobsTable as jobs,
  interviewCalendarInvitationAttemptsTable as attempts,
  staffGoogleCalendarsTable as calendars,
  usersTable as users,
} from "@workspace/db";
import type { CandidateSession } from "./portal-auth";
import { compliantCandidatePredicate } from "./compliance-scope";
import { requireAttemptStorage } from "../routes/outlook-candidate-invitations";
import type { CandidateMeetRecord } from "./candidate-google-meet";
import { googleStaffConfig, googleStaffFailure } from "./google-staff-config";
import { readGoogleInvitationPanel } from "./google-invitation-panel";
import { memberAllowed } from "./calendar-panel-access";
import {
  readVerifiedCandidateGoogleMeet,
  verifyCandidateGoogleEvent,
} from "./candidate-google-meet-verification";
import { googleStaffProvider } from "./google-staff-provider";
import { openGoogleCredential, sealGoogleCredential } from "./google-staff-service";
import { googleStaffStore } from "./google-staff-store";

/** Private receipt reads are joined through canonical self ownership, not tenant
 * membership. No decrypted token or private receipt leaves this module.
 */
async function readRecord(
  self: CandidateSession,
  scheduleId: string,
): Promise<CandidateMeetRecord | null> {
  return dbAdmin.transaction(async (tx) => {
    await requireAttemptStorage(tx);
    const [row] = await tx
      .select({
        schedule: schedules,
        application: applications,
        candidate: candidates,
        job: jobs,
        attempt: attempts,
        connection: calendars,
        organizer: {
          id: users.id,
          tenantId: users.tenantId,
          role: users.role,
          status: users.status,
          accountErasedAt: users.accountErasedAt,
        },
      })
      .from(schedules)
      .innerJoin(applications, eq(applications.id, schedules.applicationId))
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .leftJoin(
        attempts,
        and(
          eq(attempts.scheduleId, schedules.id),
          eq(attempts.applicationId, applications.id),
          eq(attempts.candidateId, candidates.id),
        ),
      )
      .leftJoin(users, eq(users.id, attempts.organizerId))
      .leftJoin(
        calendars,
        and(eq(calendars.userId, users.id), eq(calendars.tenantId, users.tenantId)),
      )
      .where(
        and(
          eq(schedules.id, scheduleId),
          eq(applications.candidateId, self.candidateId),
          eq(candidates.userId, self.userId),
          isNull(candidates.dataErasedAt),
          compliantCandidatePredicate(),
          or(eq(schedules.tenantId, applications.tenantId), eq(schedules.tenantId, jobs.tenantId)),
        ),
      )
      .limit(1);
    if (!row) return null;
    const context = {
      schedule: row.schedule,
      application: row.application,
      candidate: row.candidate,
      job: row.job,
    };
    // Only after canonical candidate ownership has matched, read the private
    // panel using its original staff organizer and this explicit admin reader.
    // Candidate tenant membership must never become staff calendar authority.
    let panel;
    if (row.organizer) {
      if (!(await memberAllowed(row.organizer, context, tx)))
        throw googleStaffFailure("google_panel_changed", 409);
      if (row.schedule.panelRevision)
        panel = await readGoogleInvitationPanel(tx, row.organizer, context);
    }
    return {
      context,
      connection: row.connection ?? undefined,
      attempt: row.attempt ?? undefined,
      organizer: row.organizer ?? undefined,
      hoursAllowed: false,
      ...(panel ? { panel } : {}),
    };
  });
}

async function verify(record: CandidateMeetRecord) {
  const config = googleStaffConfig();
  const c = record.connection;
  if (!config || !c?.refreshTokenEnc || c.clientFingerprint !== config.fingerprint) return false;
  const actor = { id: c.userId, tenantId: c.tenantId };
  const token = await googleStaffProvider(config).refresh(
    openGoogleCredential(actor, "refresh", c.refreshTokenEnc),
    true,
  );
  // Persist a provider rotation independently of later verification failures.
  if (
    token.refreshToken &&
    !(await dbAdmin.transaction((tx) =>
      googleStaffStore(tx).rotate(
        actor,
        c.revision,
        c.refreshTokenEnc!,
        sealGoogleCredential(actor, "refresh", token.refreshToken!),
      ),
    ))
  )
    return false;
  return verifyCandidateGoogleEvent(record, token.accessToken);
}

export async function candidateGoogleMeet(
  self: CandidateSession,
  scheduleId: string,
  verifyEvent: (record: CandidateMeetRecord) => Promise<boolean> = verify,
) {
  return readVerifiedCandidateGoogleMeet(
    {
      read: () => readRecord(self, scheduleId),
      verify: verifyEvent,
      fingerprint: () => googleStaffConfig()?.fingerprint,
    },
    self,
  );
}
