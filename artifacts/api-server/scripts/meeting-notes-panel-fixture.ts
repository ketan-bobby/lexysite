import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  staffGoogleCalendarsTable as grants,
  googlePanelConsentsTable as consents,
  interviewSchedulePanelsTable as panels,
  interviewSchedulesTable as schedules,
  interviewCalendarInvitationAttemptsTable as attempts,
} from "@workspace/db";
import { readGoogleInvitationPanel } from "../src/lib/google-invitation-panel";
import {
  googleInvitationSnapshot,
  googleCandidateInvitationSnapshot,
} from "../src/lib/google-invitation-identity";
import { calendarStaff } from "../src/lib/calendar-staff";
import { digest } from "../src/lib/google-staff-config";
import { scheduleVersion } from "../src/lib/coordinator-schedule-version";
import type { GoogleInvitationReview } from "../src/lib/google-invitation-store";

/** Real development joins/receipts + synthetic provider, not live panel approval. */
export async function checkMeetPanelFixture(input: {
  review: GoogleInvitationReview;
  actor: string;
  tenant: string;
  fingerprint: string;
  request: (path: string, method?: string, body?: BodyInit, actor?: string) => Promise<Response>;
  afterDownload: (fn: (() => Promise<void>) | null) => void;
}) {
  const { review, actor, tenant, request } = input;
  const { schedule, application, candidate } = review.context;
  const memberId = randomUUID(),
    panelRevision = randomUUID(),
    memberRevision = randomUUID(),
    grantedAt = new Date();
  const base = `/jobs/${application.jobId}/candidates/${candidate.id}/meeting-notes`;
  const path = `${base}/native-google-meet`,
    previewInput = { scheduleId: schedule.id, conferenceName: "conferenceRecords/synthetic" };
  let noteId: string | undefined;
  try {
    await dbAdmin.insert(usersTable).values({
      id: memberId,
      tenantId: tenant,
      email: `${memberId}@example.invalid`,
      name: "Synthetic panel member",
      role: "tenant_admin",
      status: "active",
      passwordHash: "synthetic-only",
    });
    await dbAdmin.insert(grants).values({
      userId: memberId,
      tenantId: tenant,
      revision: memberRevision,
      subject: "synthetic-panel-subject",
      accountEmail: "panel@example.invalid",
      refreshTokenEnc: "synthetic-only",
      connectedAt: new Date(),
      clientFingerprint: input.fingerprint,
    });
    await dbAdmin.insert(consents).values({
      userId: memberId,
      tenantId: tenant,
      connectionRevision: memberRevision,
      grantedAt,
    });
    await dbAdmin.update(schedules).set({ panelRevision }).where(eq(schedules.id, schedule.id));
    await dbAdmin.insert(panels).values({
      scheduleId: schedule.id,
      coordinatorId: actor,
      revision: panelRevision,
      members: [
        {
          provider: "google",
          userId: memberId,
          subjectHash: digest("synthetic-panel-subject"),
          connectionRevision: memberRevision,
          grantedAt: grantedAt.toISOString(),
        },
      ],
      bufferMinutes: 0,
    });
    // An old solo receipt cannot be silently promoted by saving a panel.
    assert.equal(
      (await request(`${path}/preview`, "POST", JSON.stringify(previewInput))).status,
      409,
    );
    const [currentSchedule] = await dbAdmin
      .select()
      .from(schedules)
      .where(eq(schedules.id, schedule.id));
    review.context.schedule = currentSchedule!;
    const caller = await calendarStaff(actor);
    review.panel = await dbAdmin.transaction((tx) =>
      readGoogleInvitationPanel(tx, caller, review.context, true),
    );
    assert.equal(review.panel!.recipients[0]!.userId, memberId);
    // Seed an explicitly synthetic accepted panel receipt, never a real approval.
    const [attempt] = await dbAdmin
      .select()
      .from(attempts)
      .where(eq(attempts.scheduleId, schedule.id));
    const google = {
      ...attempt!.googleSnapshot!,
      panelSnapshot: { revision: panelRevision, binding: review.panel!.binding },
      snapshotHash: googleInvitationSnapshot(review, caller),
      candidateSnapshotHash: googleCandidateInvitationSnapshot(review, caller),
    };
    await dbAdmin
      .update(attempts)
      .set({ googleSnapshot: google, scheduleVersion: scheduleVersion(currentSchedule!) })
      .where(eq(attempts.scheduleId, schedule.id));
    const { checkPanelPortalFixture } = await import("./meeting-notes-panel-portal-fixture");
    const portalChecks = await checkPanelPortalFixture({ review, actor: caller, memberId });
    let response = await request(`${path}/preview`, "POST", JSON.stringify(previewInput));
    assert.equal(response.status, 200);
    const preview = (await response.json()) as { files: Array<{ reviewToken: string }> };
    const receipt = {
      reviewToken: preview.files[0]!.reviewToken,
      consent: true,
      title: "Synthetic approved panel source",
      language: "en",
      consentStatement:
        "Every participant consented and I verified this exact candidate, job and panel recording.",
    };
    response = await request(`${path}/import`, "POST", JSON.stringify(receipt));
    assert.equal(response.status, 201);
    const note = (await response.json()) as {
      id: string;
      status: string;
      nativeSource: { provider: string };
    };
    noteId = note.id;
    assert.equal(note.status, "uploaded");
    assert.equal(note.nativeSource.provider, "google_meet");
    await dbAdmin.update(grants).set({ revision: randomUUID() }).where(eq(grants.userId, memberId));
    // Current panel member account rotation denies even an idempotent return.
    assert.equal((await request(`${path}/import`, "POST", JSON.stringify(receipt))).status, 409);
    await dbAdmin
      .update(grants)
      .set({ revision: memberRevision })
      .where(eq(grants.userId, memberId));
    await dbAdmin.update(usersTable).set({ role: "candidate" }).where(eq(usersTable.id, memberId));
    assert.equal((await request(`${path}/import`, "POST", JSON.stringify(receipt))).status, 409);
    await dbAdmin
      .update(usersTable)
      .set({ role: "tenant_admin" })
      .where(eq(usersTable.id, memberId));
    await dbAdmin
      .update(panels)
      .set({ coordinatorId: memberId })
      .where(eq(panels.scheduleId, schedule.id));
    assert.equal(
      (await request(`${path}/preview`, "POST", JSON.stringify(previewInput))).status,
      409,
    );
    await dbAdmin
      .update(panels)
      .set({ coordinatorId: actor })
      .where(eq(panels.scheduleId, schedule.id));
    assert.equal((await request(`${base}/${noteId}`, "DELETE")).status, 204);
    noteId = undefined;
    input.afterDownload(async () => {
      await dbAdmin.delete(consents).where(eq(consents.userId, memberId));
    });
    // Consent loss while downloading discards bytes before private persistence.
    assert.equal((await request(`${path}/import`, "POST", JSON.stringify(receipt))).status, 409);
    assert.ok(
      !JSON.stringify(await (await request(base)).json()).includes(
        "Synthetic approved panel source",
      ),
    );
    return 9 + portalChecks;
  } finally {
    input.afterDownload(null);
    if (noteId) await request(`${base}/${noteId}`, "DELETE");
    await dbAdmin.delete(panels).where(eq(panels.scheduleId, schedule.id));
    await dbAdmin
      .update(schedules)
      .set({ panelRevision: null })
      .where(eq(schedules.id, schedule.id));
    await dbAdmin.delete(consents).where(eq(consents.userId, memberId));
    await dbAdmin.delete(grants).where(eq(grants.userId, memberId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, memberId));
  }
}
