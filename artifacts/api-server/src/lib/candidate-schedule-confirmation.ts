import { createHash } from "node:crypto";
import { isJobApprovedForInterview } from "./job-approval";

// Only candidate-visible fields: never publish a digest of withheld feedback.
export function candidateTimeVersion(schedule: Record<string, unknown>) {
  return `v1_${createHash("sha256")
    .update(
      JSON.stringify([
        "candidate-proposed-time",
        schedule.id,
        new Date(schedule.scheduledAt as string | Date).getTime(),
        schedule.durationMinutes,
        schedule.type,
        schedule.status,
        // Random revision invalidates proposals without hashing private panel identities.
        ...(schedule.panelRevision ? [schedule.panelRevision] : []),
      ]),
    )
    .digest("hex")}`;
}

export class CandidateConfirmationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertCandidateTimeConfirmation(
  schedule: Record<string, unknown>,
  expectedVersion: string,
  jobStatus: string,
  now = Date.now(),
) {
  if (
    schedule.status !== "pending" ||
    schedule.type === "ai_interview" ||
    !Number.isInteger(schedule.durationMinutes) ||
    (schedule.durationMinutes as number) < 5 ||
    (schedule.durationMinutes as number) > 480 ||
    !Number.isFinite(new Date(schedule.scheduledAt as string | Date).getTime()) ||
    new Date(schedule.scheduledAt as string | Date).getTime() <= now ||
    !isJobApprovedForInterview(jobStatus) ||
    candidateTimeVersion(schedule) !== expectedVersion
  )
    throw new CandidateConfirmationError(
      409,
      "This proposed time changed or can no longer be confirmed. Reload your interviews and check with your recruiter.",
    );
}
