import type { InterviewTimeChangeView } from "@workspace/api-client-react";
export type TimeChangeView = InterviewTimeChangeView;
export function readTimeChangeView(value: unknown, scheduleId?: string): TimeChangeView {
  const v = value as TimeChangeView | null;
  if (
    !v ||
    typeof v !== "object" ||
    typeof v.scheduleId !== "string" ||
    !v.scheduleId ||
    (scheduleId !== undefined && v.scheduleId !== scheduleId) ||
    !/^v1_[a-f0-9]{64}$/.test(v.version) ||
    !Number.isFinite(Date.parse(v.scheduledAt)) ||
    !Number.isInteger(v.durationMinutes) ||
    v.durationMinutes < 5 ||
    v.durationMinutes > 480 ||
    typeof v.canRequest !== "boolean" ||
    typeof v.canWithdraw !== "boolean" ||
    v.appointmentChanged !== false ||
    v.invitationSent !== false ||
    (v.request !== null &&
      (!v.request ||
        typeof v.request.id !== "string" ||
        !v.request.id ||
        !Number.isFinite(Date.parse(v.request.requestedAt)) ||
        !(v.request.reviewedAt === null || Number.isFinite(Date.parse(v.request.reviewedAt))) ||
        !(
          v.request.withdrawnAt === null ||
          (typeof v.request.withdrawnAt === "string" &&
            Number.isFinite(Date.parse(v.request.withdrawnAt)))
        ) ||
        (!!v.request.reviewedAt && !!v.request.withdrawnAt) ||
        typeof v.request.currentProposal !== "boolean")) ||
    (v.canWithdraw &&
      (!v.request ||
        !v.request.currentProposal ||
        v.request.reviewedAt !== null ||
        v.request.withdrawnAt !== null))
  )
    throw new Error("The time-change request could not be verified. Reload before continuing.");
  return v;
}
