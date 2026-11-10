import type { GoogleInvitationReview } from "./google-invitation-store";
import {
  googleCandidateInvitationSnapshot,
  googleInvitationSnapshot,
} from "./google-invitation-identity";
import { googleInterviewEventId, safeGoogleMeetUrl } from "./google-interview-event";
import { digest } from "./google-staff-config";
import { scheduleVersion } from "./coordinator-schedule-version";
import { invitationRecipientHash } from "./outlook-candidate-invitation";
import { isJobApproved } from "./job-approval-gate";
import { meetRecordingChanged } from "./native-meet-recording-review";
import type { GoogleStaffActor } from "./google-staff-store";
import { z } from "zod/v4";
import { sameGoogleInvitationPanel } from "./google-invitation-panel";

const history = z
  .array(
    z.object({
      id: z.uuid(),
      priorId: z.uuid().nullable(),
      kind: z.enum(["reschedule", "cancel"]),
      nativeVersion: z.string(),
      targetSnapshotHash: z.string(),
      acceptedAt: z.iso.datetime({ offset: true }),
    }),
  )
  .max(1000);
/** Current provider-accepted organizer evidence; never treats a pasted link as proof. */
export function verifyNativeMeetReceipt(
  review: GoogleInvitationReview,
  actor: GoogleStaffActor,
  fingerprint: string | undefined,
) {
  const {
    context: { schedule, application, candidate, job },
    connection: c,
    attempt: a,
  } = review;
  const g = a?.googleSnapshot;
  if (
    !fingerprint ||
    !c ||
    !a ||
    !g ||
    !isJobApproved(job.status) ||
    !["confirmed", "completed"].includes(schedule.status) ||
    schedule.type === "ai_interview" ||
    a.panelSnapshot ||
    !sameGoogleInvitationPanel(schedule.panelRevision, review.panel, g.panelSnapshot) ||
    a.provider !== "google" ||
    a.status !== "accepted" ||
    !a.acceptedAt ||
    a.eventId !== googleInterviewEventId(a.transactionId) ||
    a.organizerId !== actor.id ||
    c.userId !== actor.id ||
    c.tenantId !== actor.tenantId ||
    !c.subject ||
    !c.refreshTokenEnc ||
    !c.accountEmail ||
    !c.connectedAt ||
    c.needsReconnect ||
    !c.invitationConsent ||
    c.clientFingerprint !== fingerprint ||
    g.connectionRevision !== c.revision ||
    g.subjectHash !== digest(c.subject) ||
    g.conferenceStatus !== "ready" ||
    !safeGoogleMeetUrl(g.meetUrl) ||
    a.scheduleId !== schedule.id ||
    a.applicationId !== application.id ||
    a.candidateId !== candidate.id ||
    application.candidateId !== candidate.id ||
    application.jobId !== job.id ||
    a.recipientHash !== invitationRecipientHash(candidate.email)
  )
    throw meetRecordingChanged();
  const snapshot = googleInvitationSnapshot(review, actor);
  if (g.candidateSnapshotHash !== undefined) {
    if (g.candidateSnapshotHash !== googleCandidateInvitationSnapshot(review, actor))
      throw meetRecordingChanged();
  } else if (g.snapshotHash !== snapshot) throw meetRecordingChanged();
  const ops = history.safeParse(g.operations ?? []);
  if (!ops.success) throw meetRecordingChanged(); // pending/uncertain operations fail closed
  const ids = new Set<string>();
  for (let i = 0; i < ops.data.length; i++) {
    const op = ops.data[i]!;
    if (op.kind === "cancel" || ids.has(op.id) || op.priorId !== (i ? ops.data[i - 1]!.id : null))
      throw meetRecordingChanged();
    ids.add(op.id);
  }
  const last = ops.data.at(-1);
  if (
    last &&
    (last.targetSnapshotHash !== snapshot || last.nativeVersion !== scheduleVersion(schedule))
  )
    throw meetRecordingChanged();
  const start = schedule.scheduledAt.getTime(),
    minutes = schedule.durationMinutes;
  if (!Number.isFinite(start) || !Number.isInteger(minutes) || minutes < 5 || minutes > 480)
    throw meetRecordingChanged();
  const meetingCode = new URL(g.meetUrl!).pathname.slice(1);
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingCode)) throw meetRecordingChanged();
  return {
    subjectHash: g.subjectHash,
    binding: digest(
      JSON.stringify([
        actor,
        scheduleVersion(schedule),
        application.id,
        candidate.id,
        job.id,
        a.transactionId,
        a.acceptedAt,
        a.eventId,
        g,
        ...(review.panel ? [review.panel.binding] : []),
        c.revision,
        c.clientFingerprint,
      ]),
    ),
    window: {
      meetingCode,
      // No caller-controlled time expansion. Exact historical instance is selected afterward.
      windowStart: new Date(start - 30 * 60_000).toISOString(),
      windowEnd: new Date(start + (minutes + 60) * 60_000).toISOString(),
    },
  };
}
