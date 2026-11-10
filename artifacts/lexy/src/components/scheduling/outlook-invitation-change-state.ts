export type InvitationChange = {
  scheduleId: string;
  version: string;
  scheduledAt: string;
  durationMinutes: number;
  recipientEmail: string;
  status: "unavailable" | "ready" | "current" | "needs_review";
  approvalVersion: string | null;
  organizerEmail: string | null;
  previousScheduledAt: string | null;
  previousEndAt: string | null;
};
const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
export function readInvitationChange(value: unknown, id: string): InvitationChange {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    v.scheduleId !== id ||
    typeof v.version !== "string" ||
    !/^v1_[a-f0-9]{64}$/.test(v.version) ||
    !validDate(v.scheduledAt) ||
    !Number.isInteger(v.durationMinutes) ||
    Number(v.durationMinutes) < 5 ||
    Number(v.durationMinutes) > 480 ||
    typeof v.recipientEmail !== "string" ||
    !v.recipientEmail.includes("@") ||
    !["unavailable", "ready", "current", "needs_review"].includes(String(v.status)) ||
    !(v.organizerEmail === null || typeof v.organizerEmail === "string") ||
    !(
      v.approvalVersion === null ||
      (typeof v.approvalVersion === "string" && /^change_[a-f0-9]{64}$/.test(v.approvalVersion))
    ) ||
    !(v.previousScheduledAt === null || validDate(v.previousScheduledAt)) ||
    !(v.previousEndAt === null || validDate(v.previousEndAt)) ||
    (v.status === "ready" &&
      (!v.approvalVersion || !v.organizerEmail || !v.previousScheduledAt || !v.previousEndAt))
  )
    throw new Error("Outlook change status was not understood.");
  return v as unknown as InvitationChange;
}
export function sameChange(a: InvitationChange | null, b: InvitationChange | null) {
  return (
    !!a &&
    !!b &&
    a.scheduleId === b.scheduleId &&
    a.version === b.version &&
    a.recipientEmail === b.recipientEmail &&
    a.scheduledAt === b.scheduledAt &&
    a.durationMinutes === b.durationMinutes &&
    a.organizerEmail === b.organizerEmail &&
    a.approvalVersion === b.approvalVersion &&
    a.previousScheduledAt === b.previousScheduledAt &&
    a.previousEndAt === b.previousEndAt
  );
}
