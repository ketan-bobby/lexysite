/** Synthetic provider adapters for the existing fingerprint-guarded HTTP fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  candidatesTable,
  applicationsTable,
  interviewSchedulesTable,
  staffGoogleCalendarsTable,
  interviewCalendarInvitationAttemptsTable,
} from "@workspace/db";

const subject = "synthetic-meet-organizer",
  revision = randomUUID();
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(48)]);
let active = true,
  downloads = 0,
  revokeAfterDownload = false;
let onDownload: (() => Promise<void>) | null = null;
export async function setupMeetImportFixture() {
  const config = await import("../src/lib/google-staff-config");
  const provider = await import("../src/lib/google-meet-recordings-provider");
  const account = await import("../src/routes/google-meet-recording-account");
  const { default: accountRouter, ...accountExports } = account;
  const fingerprint = "synthetic-calendar-config";
  mock.module("../src/lib/google-staff-config.ts", {
    namedExports: {
      ...config,
      googleStaffConfig: () => ({
        clientId: "fixture",
        clientSecret: "synthetic-only",
        fingerprint,
        redirectUri: "https://example.invalid/api/google-calendar/callback",
        settingsUrl: "https://example.invalid/settings/calendar",
      }),
    },
  });
  mock.module("../src/routes/google-meet-recording-account.ts", {
    defaultExport: accountRouter,
    namedExports: {
      ...accountExports,
      makeMeetRecordingAccount: () => ({
        status: async () => ({ canReadRecordings: active, revision }),
        access: async () => ({ accessToken: "synthetic-meet-token", subject }),
      }),
    },
  });
  mock.module("../src/lib/google-meet-recordings-provider.ts", {
    namedExports: {
      ...provider,
      googleMeetRecordingsProvider: () => ({
        conferences: async () => [
          {
            name: "conferenceRecords/synthetic",
            space: "spaces/synthetic",
            startTime: "2026-11-04T10:00:00Z",
            endTime: "2026-11-04T10:01:00Z",
          },
        ],
        preview: async (_token: string, _window: unknown, name: string) => {
          assert.equal(name, "conferenceRecords/synthetic");
          return {
            conference: {
              name,
              space: "spaces/synthetic",
              startTime: "2026-11-04T10:00:00Z",
              endTime: "2026-11-04T10:01:00Z",
            },
            files: [
              {
                name: `${name}/recordings/synthetic`,
                conferenceName: name,
                spaceName: "spaces/synthetic",
                fileId: "synthetic-drive-file",
                start: "2026-11-04T10:00:00Z",
                end: "2026-11-04T10:01:00Z",
                bytes: mp4.length,
                durationMillis: 60_000,
                version: "1",
                md5Checksum: "0".repeat(32),
                modifiedTime: "2026-11-04T11:00:00Z",
                eligible: true,
                unavailableReason: null,
              },
            ],
          };
        },
        download: async () => {
          downloads++;
          await onDownload?.();
          if (revokeAfterDownload) active = false;
          return mp4;
        },
      }),
    },
  });
  return fingerprint;
}
export async function checkMeetImportFixture(input: {
  tenant: string;
  actor: string;
  job: string;
  candidate: string;
  application: string;
  candidateActor: string;
  unassignedActor: string;
  fingerprint: string;
  request: (path: string, method?: string, body?: BodyInit, actor?: string) => Promise<Response>;
}) {
  const { tenant, actor, job, candidate, application, request, fingerprint } = input;
  const scheduleId = randomUUID(),
    connectionRevision = randomUUID(),
    transactionId = randomUUID();
  const [originalJob] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, job));
  const config = await import("../src/lib/google-staff-config");
  const { googleInvitationSnapshot, googleCandidateInvitationSnapshot } =
    await import("../src/lib/google-invitation-identity");
  const { googleInterviewEventId } = await import("../src/lib/google-interview-event");
  const { invitationRecipientHash } = await import("../src/lib/outlook-candidate-invitation");
  const base = `/jobs/${job}/candidates/${candidate}/meeting-notes`;
  const path = `${base}/native-google-meet`;
  let noteId: string | undefined;
  try {
    await dbAdmin.update(jobsTable).set({ status: "active" }).where(eq(jobsTable.id, job));
    const [schedule] = await dbAdmin
      .insert(interviewSchedulesTable)
      .values({
        id: scheduleId,
        tenantId: tenant,
        applicationId: application,
        interviewerId: actor,
        scheduledAt: new Date("2026-11-04T10:00:00Z"),
        durationMinutes: 30,
        status: "confirmed",
        type: "video",
      })
      .returning();
    const [connection] = await dbAdmin
      .insert(staffGoogleCalendarsTable)
      .values({
        userId: actor,
        tenantId: tenant,
        revision: connectionRevision,
        clientFingerprint: fingerprint,
        subject,
        accountEmail: "organizer@example.invalid",
        refreshTokenEnc: "synthetic-encrypted-fixture",
        connectedAt: new Date(),
        invitationConsent: true,
      })
      .returning();
    const [jobRow] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, job));
    const [candidateRow] = await dbAdmin
      .select()
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidate));
    const [app] = await dbAdmin
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, application));
    const review = {
      context: { schedule: schedule!, job: jobRow!, candidate: candidateRow!, application: app! },
      connection,
      attempt: undefined,
      hoursAllowed: false,
    };
    const organizer = { id: actor, tenantId: tenant };
    await dbAdmin.insert(interviewCalendarInvitationAttemptsTable).values({
      scheduleId,
      candidateId: candidate,
      applicationId: application,
      organizerId: actor,
      transactionId,
      scheduleVersion: "fixture",
      recipientHash: invitationRecipientHash(candidateRow!.email),
      provider: "google",
      status: "accepted",
      acceptedAt: new Date(),
      eventId: googleInterviewEventId(transactionId),
      attemptedAt: new Date(),
      googleSnapshot: {
        connectionRevision,
        subjectHash: config.digest(subject),
        snapshotHash: googleInvitationSnapshot(review, organizer),
        candidateSnapshotHash: googleCandidateInvitationSnapshot(review, organizer),
        meetUrl: "https://meet.google.com/abc-defg-hij",
        conferenceStatus: "ready",
      },
    });
    for (const who of [input.candidateActor, input.unassignedActor]) {
      assert.ok(
        [401, 403, 404].includes(
          (await request(`${path}/appointments`, "GET", undefined, who)).status,
        ),
      );
    }
    const appointments = await request(`${path}/appointments`);
    assert.equal(appointments.status, 200);
    assert.ok(JSON.stringify(await appointments.json()).includes(scheduleId));
    assert.equal(
      (
        await request(
          `${path}/conferences`,
          "POST",
          JSON.stringify({ scheduleId, windowStart: "arbitrary" }),
        )
      ).status,
      400,
    );
    assert.equal(
      (await request(`${path}/conferences`, "POST", JSON.stringify({ scheduleId }))).status,
      200,
    );
    const previewInput = { scheduleId, conferenceName: "conferenceRecords/synthetic" };
    const preview = await request(`${path}/preview`, "POST", JSON.stringify(previewInput));
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as { files: Array<{ reviewToken: string }> };
    assert.equal(downloads, 0);
    const receipt = {
      reviewToken: body.files[0]!.reviewToken,
      title: "Synthetic Meet source",
      language: "en",
      consent: true,
      consentStatement:
        "All participants agreed; this exact instance belongs to this applicant and job.",
    };
    assert.equal(
      (await request(`${path}/import`, "POST", JSON.stringify({ ...receipt, consent: false })))
        .status,
      400,
    );
    const imported = await request(`${path}/import`, "POST", JSON.stringify(receipt));
    assert.equal(imported.status, 201);
    const note = (await imported.json()) as {
      id: string;
      status: string;
      nativeSource: { provider: string; meetingUuid: string };
    };
    noteId = note.id;
    assert.equal(note.status, "uploaded");
    assert.equal(note.nativeSource.provider, "google_meet");
    assert.equal(note.nativeSource.meetingUuid, previewInput.conferenceName);
    assert.equal(downloads, 1);
    const repeated = await request(`${path}/import`, "POST", JSON.stringify(receipt));
    assert.equal(repeated.status, 201);
    assert.equal(((await repeated.json()) as { id: string }).id, note.id);
    assert.equal(downloads, 1);
    assert.equal((await request(`${base}/${noteId}/recording`)).status, 200);
    assert.equal((await request(`${base}/${noteId}`, "DELETE")).status, 204);
    noteId = undefined;
    revokeAfterDownload = true;
    const denied = await request(`${path}/import`, "POST", JSON.stringify(receipt));
    assert.equal(denied.status, 409);
    const notes = await request(base);
    assert.ok(!JSON.stringify(await notes.json()).includes("Synthetic Meet source"));
    active = true;
    revokeAfterDownload = false;
    const { checkMeetPanelFixture } = await import("./meeting-notes-panel-fixture");
    const panelChecks = await checkMeetPanelFixture({
      review,
      actor,
      tenant,
      fingerprint,
      request,
      afterDownload: (fn) => {
        onDownload = fn;
      },
    });
    return 13 + panelChecks;
  } finally {
    active = true;
    revokeAfterDownload = false;
    if (noteId) await request(`${base}/${noteId}`, "DELETE");
    await dbAdmin.delete(interviewSchedulesTable).where(eq(interviewSchedulesTable.id, scheduleId));
    await dbAdmin
      .delete(staffGoogleCalendarsTable)
      .where(eq(staffGoogleCalendarsTable.userId, actor));
    if (originalJob)
      await dbAdmin
        .update(jobsTable)
        .set({ status: originalJob.status })
        .where(eq(jobsTable.id, job));
  }
}
