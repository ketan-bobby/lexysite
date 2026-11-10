import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  usersTable as users,
  candidatesTable as candidates,
  jobsTable as jobs,
  interviewSchedulesTable as schedules,
  interviewCalendarInvitationAttemptsTable as attempts,
  staffGoogleCalendarsTable as grants,
  googlePanelConsentsTable as consents,
} from "@workspace/db";
import type { GoogleInvitationReview } from "../src/lib/google-invitation-store";
import {
  googleCandidateInvitationSnapshot,
  googleInvitationSnapshot,
} from "../src/lib/google-invitation-identity";

/** Called only inside the fingerprint-guarded, synthetic development fixture.
 * Restore the recording fixture's past appointment/receipt after testing Join.
 */
export async function checkPanelPortalFixture(input: {
  review: GoogleInvitationReview;
  actor: { id: string; tenantId: string | null };
  memberId: string;
}) {
  const { review, actor, memberId } = input;
  const { candidate, schedule } = review.context;
  const { candidateGoogleMeet } = await import("../src/lib/candidate-google-meet-store");
  const [originalAttempt] = await dbAdmin
    .select()
    .from(attempts)
    .where(eq(attempts.scheduleId, schedule.id));
  const [originalGrant] = await dbAdmin.select().from(grants).where(eq(grants.userId, memberId));
  const [originalConsent] = await dbAdmin
    .select()
    .from(consents)
    .where(eq(consents.userId, memberId));
  const portalUser = randomUUID();
  const [originalOrganizer] = await dbAdmin.select().from(users).where(eq(users.id, actor.id));
  const self = { userId: portalUser, candidateId: candidate.id, tenantId: actor.tenantId! };
  const originalSchedule = structuredClone(schedule);
  try {
    await dbAdmin.insert(users).values({
      id: portalUser,
      tenantId: self.tenantId,
      role: "candidate",
      status: "active",
      name: "Synthetic portal candidate",
      email: `${portalUser}@example.invalid`,
      passwordHash: "synthetic-only",
    });
    await dbAdmin
      .update(candidates)
      .set({ userId: portalUser })
      .where(eq(candidates.id, candidate.id));
    review.context.schedule = { ...schedule, scheduledAt: new Date(Date.now() + 86_400_000) };
    await dbAdmin
      .update(schedules)
      .set({ scheduledAt: review.context.schedule.scheduledAt })
      .where(eq(schedules.id, schedule.id));
    const google = {
      ...originalAttempt!.googleSnapshot!,
      snapshotHash: googleInvitationSnapshot(review, actor),
      candidateSnapshotHash: googleCandidateInvitationSnapshot(review, actor),
      operations: [],
    };
    await dbAdmin
      .update(attempts)
      .set({ googleSnapshot: google })
      .where(eq(attempts.scheduleId, schedule.id));

    // Only provider I/O is synthetic; canonical reads run through the real
    // store twice, including the post-provider ownership/consent fence.
    const verifyEvent = async () => true;
    const read = () => candidateGoogleMeet(self, schedule.id, verifyEvent);
    const view = await read();
    assert.equal(view?.status, "ready");
    assert.deepEqual(Object.keys(view!).sort(), [
      "durationMinutes",
      "meetUrl",
      "scheduleId",
      "scheduledAt",
      "status",
    ]);
    assert.doesNotMatch(
      JSON.stringify(view),
      /organizer|panel@|subject|refresh|binding|recipients/i,
    );
    assert.equal(
      await candidateGoogleMeet({ ...self, userId: memberId }, schedule.id, verifyEvent),
      null,
    );
    assert.equal(
      await candidateGoogleMeet({ ...self, candidateId: randomUUID() }, schedule.id, verifyEvent),
      null,
    );
    assert.equal((await candidateGoogleMeet(self, schedule.id, async () => false))?.meetUrl, null);
    assert.equal(
      (
        await candidateGoogleMeet(self, schedule.id, async () => {
          throw new Error("Synthetic provider failure");
        })
      )?.meetUrl,
      null,
    );
    assert.equal(
      (
        await candidateGoogleMeet(self, schedule.id, async () => {
          await dbAdmin
            .update(schedules)
            .set({ status: "cancelled" })
            .where(eq(schedules.id, schedule.id));
          return true;
        })
      )?.meetUrl,
      null,
    );
    await dbAdmin
      .update(schedules)
      .set({ status: originalSchedule.status })
      .where(eq(schedules.id, schedule.id));

    await dbAdmin
      .update(schedules)
      .set({ feedbackNotes: "private panel feedback" })
      .where(eq(schedules.id, schedule.id));
    assert.equal((await read())?.status, "ready");
    await dbAdmin
      .update(schedules)
      .set({ status: "cancelled" })
      .where(eq(schedules.id, schedule.id));
    assert.equal((await read())?.meetUrl, null);
    await dbAdmin
      .update(schedules)
      .set({ status: originalSchedule.status })
      .where(eq(schedules.id, schedule.id));

    await dbAdmin.update(grants).set({ revision: randomUUID() }).where(eq(grants.userId, memberId));
    await assert.rejects(read);
    await dbAdmin
      .update(grants)
      .set({ revision: originalGrant!.revision })
      .where(eq(grants.userId, memberId));
    await dbAdmin.update(users).set({ status: "suspended" }).where(eq(users.id, memberId));
    await assert.rejects(read);
    await dbAdmin.update(users).set({ status: "active" }).where(eq(users.id, memberId));
    await dbAdmin.delete(consents).where(eq(consents.userId, memberId));
    await assert.rejects(read);
    await dbAdmin.insert(consents).values(originalConsent!);
    assert.equal((await read())?.status, "ready");

    const { checkPanelAvailabilityFixture } =
      await import("./meeting-notes-panel-availability-fixture");
    const availabilityChecks = await checkPanelAvailabilityFixture(actor.id, memberId, schedule.id);

    // Exercise the real recruiter ownership path, not only an admin bypass.
    await dbAdmin.update(users).set({ role: "recruiter" }).where(eq(users.id, actor.id));
    await dbAdmin
      .update(jobs)
      .set({ assignedRecruiterId: actor.id })
      .where(eq(jobs.id, review.context.job.id));
    assert.equal((await read())?.status, "ready");
    await dbAdmin
      .update(jobs)
      .set({ assignedRecruiterId: null })
      .where(eq(jobs.id, review.context.job.id));
    await assert.rejects(read);
    await dbAdmin
      .update(users)
      .set({ role: originalOrganizer!.role })
      .where(eq(users.id, actor.id));
    await dbAdmin
      .update(jobs)
      .set({ assignedRecruiterId: review.context.job.assignedRecruiterId })
      .where(eq(jobs.id, review.context.job.id));

    const { panelSnapshot: _panel, ...solo } = google;
    await dbAdmin
      .update(attempts)
      .set({ googleSnapshot: solo })
      .where(eq(attempts.scheduleId, schedule.id));
    assert.equal((await read())?.meetUrl, null);
    return 14 + availabilityChecks;
  } finally {
    review.context.schedule = originalSchedule;
    await dbAdmin
      .update(schedules)
      .set({
        scheduledAt: originalSchedule.scheduledAt,
        status: originalSchedule.status,
        feedbackNotes: originalSchedule.feedbackNotes,
      })
      .where(eq(schedules.id, schedule.id));
    await dbAdmin
      .update(attempts)
      .set({ googleSnapshot: originalAttempt!.googleSnapshot })
      .where(eq(attempts.scheduleId, schedule.id));
    await dbAdmin
      .update(candidates)
      .set({ userId: candidate.userId })
      .where(eq(candidates.id, candidate.id));
    await dbAdmin
      .update(users)
      .set({ role: originalOrganizer!.role })
      .where(eq(users.id, actor.id));
    await dbAdmin
      .update(jobs)
      .set({ assignedRecruiterId: review.context.job.assignedRecruiterId })
      .where(eq(jobs.id, review.context.job.id));
    await dbAdmin.update(users).set({ status: "active" }).where(eq(users.id, memberId));
    await dbAdmin
      .update(grants)
      .set({ revision: originalGrant!.revision })
      .where(eq(grants.userId, memberId));
    await dbAdmin.insert(consents).values(originalConsent!).onConflictDoNothing();
    await dbAdmin.delete(users).where(eq(users.id, portalUser));
  }
}
