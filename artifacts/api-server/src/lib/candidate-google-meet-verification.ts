import type { CandidateGoogleMeetView } from "@workspace/api-zod";
import { projectCandidateGoogleMeet, type CandidateMeetRecord } from "./candidate-google-meet";
import { googleCandidateInvitationSnapshot } from "./google-invitation-identity";
import { digest } from "./google-staff-config";
import { googleInterviewEventChanges } from "./google-interview-event-changes";

/** Read only the known original event. Never adopt external edits into Lexy,
 * mutate an invitation, or return provider payloads to a candidate.
 */
export async function verifyCandidateGoogleEvent(
  r: CandidateMeetRecord,
  access: string,
  events = googleInterviewEventChanges(),
): Promise<boolean> {
  const s = r.context.schedule;
  const g = r.attempt?.googleSnapshot;
  if (!r.attempt || !g || !r.connection?.accountEmail) return false;
  const startAt = s.scheduledAt.toISOString();
  const endAt = new Date(s.scheduledAt.getTime() + s.durationMinutes * 60_000).toISOString();
  const remote = await events.observe(access, {
    transactionId: r.attempt.transactionId,
    binding: digest(`${s.tenantId}|${s.id}`),
    jobTitle: r.context.job.title,
    recipientEmail: r.context.candidate.email.trim().toLowerCase(),
    organizerEmail: r.connection.accountEmail,
    ...(r.panel
      ? {
          panelEmails: r.panel.recipients
            .map((p) => p.email)
            .filter((email) => email !== r.connection!.accountEmail!.trim().toLowerCase()),
        }
      : {}),
    startAt,
    endAt,
  });
  return (
    remote.startAt === startAt &&
    remote.endAt === endAt &&
    remote.conferenceStatus === "ready" &&
    remote.meetUrl === g.meetUrl &&
    remote.changeId === (g.operations?.at(-1)?.id ?? null)
  );
}

function evidence(r: CandidateMeetRecord) {
  return digest(
    JSON.stringify([
      googleCandidateInvitationSnapshot(r, r.organizer!),
      r.attempt?.transactionId,
      r.attempt?.eventId,
      r.attempt?.googleSnapshot,
    ]),
  );
}

/** Provider I/O is outside database locks. Re-read canonical self ownership,
 * consent and the exact receipt afterwards; a concurrent edit cannot publish a
 * link checked against a different booking. Failure never returns cached ready.
 */
export async function readVerifiedCandidateGoogleMeet(
  deps: {
    read: () => Promise<CandidateMeetRecord | null>;
    verify: (record: CandidateMeetRecord) => Promise<boolean>;
    fingerprint: () => string | undefined;
  },
  self: { candidateId: string; userId: string },
): Promise<CandidateGoogleMeetView | null> {
  const original = await deps.read();
  if (!original) return null;
  const fingerprint = deps.fingerprint();
  const view = projectCandidateGoogleMeet(original, self, fingerprint);
  if (!view || view.status !== "ready") return view;
  const hidden = { ...view, status: "unavailable" as const, meetUrl: null };
  try {
    const binding = evidence(original);
    if (!(await deps.verify(original))) return hidden;
    const current = await deps.read();
    if (!current) return null;
    const fresh = projectCandidateGoogleMeet(current, self, deps.fingerprint());
    if (!fresh || fresh.status !== "ready") return fresh;
    if (deps.fingerprint() !== fingerprint || evidence(current) !== binding)
      return { ...fresh, status: "unavailable", meetUrl: null };
    return fresh;
  } catch {
    return hidden;
  }
}
