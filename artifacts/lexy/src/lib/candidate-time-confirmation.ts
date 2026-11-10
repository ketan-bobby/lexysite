import type { CandidateTimeConfirmationReceipt } from "@workspace/api-client-react";

export function readCandidateConfirmationReceipt(
  value: unknown,
  reviewed: { id: string; scheduledAt: string; duration?: number | null },
): CandidateTimeConfirmationReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    !("scheduleId" in value) ||
    value.scheduleId !== reviewed.id ||
    !("status" in value) ||
    value.status !== "confirmed" ||
    !("scheduledAt" in value) ||
    typeof value.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(value.scheduledAt)) ||
    Date.parse(value.scheduledAt) !== Date.parse(reviewed.scheduledAt) ||
    !("durationMinutes" in value) ||
    value.durationMinutes !== reviewed.duration ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^v1_[0-9a-f]{64}$/.test(value.version) ||
    !("calendarReserved" in value) ||
    value.calendarReserved !== false ||
    !("invitationSent" in value) ||
    value.invitationSent !== false
  )
    throw new Error(
      "The saved confirmation could not be verified. The schedule may already have changed.",
    );
  return value as CandidateTimeConfirmationReceipt;
}
