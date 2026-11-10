import { digest } from "./google-staff-config";
import { scheduleVersion } from "./coordinator-schedule-version";
import type { GoogleInvitationCaller, GoogleInvitationReview } from "./google-invitation-store";
import { candidateTimeVersion } from "./candidate-schedule-confirmation";

/** Candidate publication ignores staff-only notes and feedback. Only persist
 * this binding after a provider-verified acceptance or accepted event change.
 */
export function googleCandidateInvitationSnapshot(
  r: GoogleInvitationReview,
  caller: Pick<GoogleInvitationCaller, "id" | "tenantId">,
) {
  const {
    context: { schedule, application, candidate, job },
    connection: c,
  } = r;
  return digest(
    JSON.stringify([
      candidateTimeVersion(schedule),
      application.id,
      candidate.id,
      candidate.email.trim().toLowerCase(),
      job.title,
      caller.id,
      caller.tenantId,
      c?.revision,
      c?.subject,
      c?.accountEmail,
      c?.clientFingerprint,
      ...(r.panel ? [r.panel.binding] : []),
    ]),
  );
}

export function googleInvitationSnapshot(
  r: GoogleInvitationReview,
  caller: Pick<GoogleInvitationCaller, "id" | "tenantId">,
) {
  const {
    context: { schedule, application, candidate, job },
    connection: c,
  } = r;
  return digest(
    JSON.stringify([
      schedule.id,
      application.id,
      candidate.id,
      scheduleVersion(schedule),
      candidate.email.trim().toLowerCase(),
      job.title,
      caller.id,
      caller.tenantId,
      c?.revision,
      c?.subject,
      c?.accountEmail,
      c?.clientFingerprint,
      ...(r.panel ? [r.panel.binding] : []),
    ]),
  );
}
