import type { CandidateGoogleMeetView } from "@workspace/api-zod";
import type { GoogleInvitationCaller, GoogleInvitationReview } from "./google-invitation-store";
import {
  googleInvitationSnapshot,
  googleCandidateInvitationSnapshot,
} from "./google-invitation-identity";
import { digest } from "./google-staff-config";
import { googleInterviewEventId, safeGoogleMeetUrl } from "./google-interview-event";
import { invitationRecipientHash } from "./outlook-candidate-invitation";
import { isJobApproved } from "./job-approval-gate";
import { scheduleVersion } from "./coordinator-schedule-version";
import { z } from "zod/v4";
import { sameGoogleInvitationPanel } from "./google-invitation-panel";

const instant = z.iso.datetime({ offset: true });
const operationHistory = z
  .array(
    z.object({
      id: z.uuid(),
      priorId: z.uuid().nullable(),
      kind: z.enum(["reschedule", "cancel"]),
      nativeVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
      targetSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      sourceEtag: z.string().regex(/^"[\x21\x23-\x7e]{1,200}"$/),
      previousStart: instant,
      previousEnd: instant,
      targetStart: instant.nullable(),
      targetEnd: instant.nullable(),
      meetUrl: z.string().nullable(),
      approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
      attemptedAt: instant,
      acceptedAt: instant.nullable(),
    }),
  )
  .max(1000);

export type CandidateMeetRecord = GoogleInvitationReview & {
  organizer:
    | Pick<GoogleInvitationCaller, "id" | "tenantId" | "role" | "status" | "accountErasedAt">
    | undefined;
};

/** Stored provider acceptance, not a live Google availability or delivery claim.
 * Never refresh credentials, reconcile receipts, or make provider calls here.
 */
export function projectCandidateGoogleMeet(
  record: CandidateMeetRecord,
  self: { candidateId: string; userId: string },
  fingerprint: string | undefined,
  now = Date.now(),
): CandidateGoogleMeetView | null {
  const {
    context: { schedule, application, candidate },
    connection: c,
    attempt: a,
    organizer,
  } = record;
  if (
    candidate.id !== self.candidateId ||
    candidate.userId !== self.userId ||
    application.candidateId !== self.candidateId
  )
    return null;
  const hidden: CandidateGoogleMeetView = {
    scheduleId: schedule.id,
    scheduledAt: schedule.scheduledAt,
    durationMinutes: schedule.durationMinutes,
    status: "unavailable",
    meetUrl: null,
  };
  try {
    // Sending must precede the appointment; joining must also work during it.
    // Keep a one-hour reconnection grace after the scheduled end.
    const start = schedule.scheduledAt.getTime();
    if (
      schedule.status !== "confirmed" ||
      schedule.type === "ai_interview" ||
      !Number.isFinite(start) ||
      !Number.isInteger(schedule.durationMinutes) ||
      schedule.durationMinutes < 5 ||
      schedule.durationMinutes > 480 ||
      now >= start + (schedule.durationMinutes + 60) * 60_000 ||
      !isJobApproved(record.context.job.status) ||
      candidate.dataErasedAt ||
      candidate.doNotContact ||
      !z.email().safeParse(candidate.email).success
    )
      return hidden;
    if (
      !fingerprint ||
      !organizer ||
      organizer.status !== "active" ||
      organizer.accountErasedAt ||
      ![
        "platform_admin",
        "tenant_admin",
        "recruiter_admin",
        "recruiter",
        "hiring_manager",
        "interviewer",
      ].includes(organizer.role) ||
      !c ||
      c.userId !== organizer.id ||
      c.tenantId !== organizer.tenantId ||
      !c.refreshTokenEnc ||
      !c.subject ||
      !c.accountEmail ||
      !c.connectedAt ||
      c.needsReconnect ||
      !c.invitationConsent ||
      c.clientFingerprint !== fingerprint ||
      !a ||
      a.panelSnapshot ||
      !sameGoogleInvitationPanel(
        schedule.panelRevision,
        record.panel,
        a.googleSnapshot?.panelSnapshot,
      ) ||
      a.scheduleId !== schedule.id ||
      a.applicationId !== application.id ||
      a.candidateId !== candidate.id ||
      a.organizerId !== organizer.id ||
      a.provider !== "google" ||
      a.status !== "accepted" ||
      !a.acceptedAt ||
      a.eventId !== googleInterviewEventId(a.transactionId) ||
      a.recipientHash !== invitationRecipientHash(candidate.email) ||
      !a.googleSnapshot ||
      a.googleSnapshot.subjectHash !== digest(c.subject) ||
      a.googleSnapshot.conferenceStatus !== "ready" ||
      !safeGoogleMeetUrl(a.googleSnapshot.meetUrl)
    )
      return hidden;
    const g = a.googleSnapshot;
    const candidateBinding = g.candidateSnapshotHash !== undefined;
    if (
      candidateBinding &&
      (typeof g.candidateSnapshotHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(g.candidateSnapshotHash))
    )
      return hidden;
    const parsed = operationHistory.safeParse(g.operations === undefined ? [] : g.operations);
    if (!parsed.success) return hidden;
    const ops = parsed.data;
    const ids = new Set<string>();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (
        !op ||
        typeof op.id !== "string" ||
        !op.id ||
        ids.has(op.id) ||
        op.priorId !== (i === 0 ? null : ops[i - 1].id) ||
        op.kind !== "reschedule" ||
        typeof op.acceptedAt !== "string" ||
        !Number.isFinite(Date.parse(op.acceptedAt)) ||
        (op.meetUrl !== null && op.meetUrl !== g.meetUrl)
      )
        return hidden;
      ids.add(op.id);
    }
    const last = ops.at(-1);
    if (
      last &&
      ((!candidateBinding && last.nativeVersion !== scheduleVersion(schedule)) ||
        !last.targetStart ||
        Date.parse(last.targetStart) !== schedule.scheduledAt.getTime() ||
        !last.targetEnd ||
        Date.parse(last.targetEnd) !==
          schedule.scheduledAt.getTime() + schedule.durationMinutes * 60_000)
    )
      return hidden;
    if (
      candidateBinding
        ? g.candidateSnapshotHash !== googleCandidateInvitationSnapshot(record, organizer)
        : (last?.targetSnapshotHash ?? g.snapshotHash) !==
          googleInvitationSnapshot(record, organizer)
    )
      return hidden;
    return { ...hidden, status: "ready", meetUrl: g.meetUrl };
  } catch {
    // Missing/malformed private evidence must never become a usable URL.
    return hidden;
  }
}
