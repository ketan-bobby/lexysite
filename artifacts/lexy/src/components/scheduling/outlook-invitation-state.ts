export type OutlookCandidateInvitationStatus = {
  scheduleId: string;
  version: string;
  scheduledAt: string;
  durationMinutes: number;
  recipientEmail: string;
  status: "not_sent" | "needs_review" | "accepted";
  acceptedAt: string | null;
};
export type InvitationSchedule = {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  version?: string;
};
const VERSION = /^v1_[a-f0-9]{64}$/;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export function readInvitationStatus(
  value: unknown,
  scheduleId: string,
): OutlookCandidateInvitationStatus {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") throw new Error("Invitation status was not understood.");
  if (
    v.scheduleId !== scheduleId ||
    typeof v.version !== "string" ||
    !VERSION.test(v.version) ||
    typeof v.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(v.scheduledAt)) ||
    typeof v.durationMinutes !== "number" ||
    !Number.isInteger(v.durationMinutes) ||
    v.durationMinutes < 5 ||
    v.durationMinutes > 480 ||
    typeof v.recipientEmail !== "string" ||
    !EMAIL.test(v.recipientEmail) ||
    !["not_sent", "needs_review", "accepted"].includes(String(v.status)) ||
    !(
      v.acceptedAt === null ||
      (typeof v.acceptedAt === "string" && Number.isFinite(Date.parse(v.acceptedAt)))
    )
  )
    throw new Error("Invitation status was not understood.");
  return v as unknown as OutlookCandidateInvitationStatus;
}
export function canSendInvitation(
  schedule: InvitationSchedule,
  status: OutlookCandidateInvitationStatus | null,
  now = Date.now(),
) {
  if (!status) return false;
  const time = Date.parse(schedule.scheduledAt);
  return (
    schedule.status === "confirmed" &&
    Number.isFinite(time) &&
    time > now &&
    !!schedule.version &&
    status.version === schedule.version &&
    status.scheduleId === schedule.id &&
    Date.parse(status.scheduledAt) === time &&
    status.durationMinutes === schedule.durationMinutes &&
    status.status === "not_sent"
  );
}

/** Delivery status can change, but the human-reviewed invitation must not. */
export function sameInvitationDetails(
  reviewed: OutlookCandidateInvitationStatus | null,
  current: OutlookCandidateInvitationStatus | null,
) {
  return (
    !!reviewed &&
    !!current &&
    reviewed.scheduleId === current.scheduleId &&
    reviewed.version === current.version &&
    reviewed.recipientEmail === current.recipientEmail &&
    Date.parse(reviewed.scheduledAt) === Date.parse(current.scheduledAt) &&
    reviewed.durationMinutes === current.durationMinutes
  );
}
