import type { OutlookPanelInvitationStatus } from "@workspace/api-client-react";
import type { InvitationSchedule } from "./outlook-invitation-state";

const VERSION = /^v1_[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const STATUSES = ["unavailable", "not_sent", "needs_review", "accepted"];

/** Reads are only trusted for this long while the dialog is open. */
export const PANEL_READ_FRESH_MS = 90_000;

const isDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

export function readPanelStatus(value: unknown, scheduleId: string): OutlookPanelInvitationStatus {
  const v = value as Record<string, unknown> | null;
  const bad = () => new Error("Panel invitation status was not understood.");
  if (!v || typeof v !== "object") throw bad();
  if (
    v.scheduleId !== scheduleId ||
    typeof v.version !== "string" ||
    !VERSION.test(v.version) ||
    !isDate(v.scheduledAt) ||
    typeof v.durationMinutes !== "number" ||
    !Number.isInteger(v.durationMinutes) ||
    v.durationMinutes < 5 ||
    v.durationMinutes > 480 ||
    typeof v.recipientEmail !== "string" ||
    !EMAIL.test(v.recipientEmail) ||
    !(
      v.organizerEmail === null ||
      (typeof v.organizerEmail === "string" && EMAIL.test(v.organizerEmail))
    ) ||
    !(
      v.approvalToken === null ||
      (typeof v.approvalToken === "string" && TOKEN.test(v.approvalToken))
    ) ||
    !STATUSES.includes(String(v.status)) ||
    !(v.acceptedAt === null || isDate(v.acceptedAt)) ||
    !Array.isArray(v.panelRecipients)
  )
    throw bad();
  const seen = new Set<string>();
  for (const r of v.panelRecipients as unknown[]) {
    const p = r as Record<string, unknown> | null;
    if (
      !p ||
      typeof p.userId !== "string" ||
      !p.userId ||
      typeof p.name !== "string" ||
      typeof p.email !== "string" ||
      !EMAIL.test(p.email) ||
      seen.has(p.userId)
    )
      throw bad();
    seen.add(p.userId);
  }
  return v as unknown as OutlookPanelInvitationStatus;
}

export function canReviewPanelInvitation(
  schedule: InvitationSchedule,
  s: OutlookPanelInvitationStatus | null,
  now = Date.now(),
) {
  if (!s) return false;
  const time = Date.parse(schedule.scheduledAt);
  return (
    schedule.status === "confirmed" &&
    Number.isFinite(time) &&
    time > now &&
    !!schedule.version &&
    s.version === schedule.version &&
    s.scheduleId === schedule.id &&
    Date.parse(s.scheduledAt) === time &&
    s.durationMinutes === schedule.durationMinutes &&
    s.status === "not_sent" &&
    !!s.organizerEmail &&
    !!s.approvalToken &&
    s.panelRecipients.length > 0
  );
}

const roster = (s: OutlookPanelInvitationStatus) =>
  s.panelRecipients
    .map((p) => `${p.userId}\n${p.name}\n${p.email.toLowerCase()}`)
    .sort()
    .join("\u0000");

/** Everything a human approved: must be identical on current reads and on receipts. */
export function samePanelReview(
  reviewed: OutlookPanelInvitationStatus | null,
  current: OutlookPanelInvitationStatus | null,
) {
  return (
    !!reviewed &&
    !!current &&
    reviewed.scheduleId === current.scheduleId &&
    reviewed.version === current.version &&
    !!reviewed.approvalToken &&
    reviewed.approvalToken === current.approvalToken &&
    !!reviewed.organizerEmail &&
    reviewed.organizerEmail.toLowerCase() === current.organizerEmail?.toLowerCase() &&
    reviewed.recipientEmail.toLowerCase() === current.recipientEmail.toLowerCase() &&
    Date.parse(reviewed.scheduledAt) === Date.parse(current.scheduledAt) &&
    reviewed.durationMinutes === current.durationMinutes &&
    roster(reviewed) === roster(current)
  );
}

/** A receipt is trusted only if it matches the reviewed approval exactly. */
export function receiptMatchesReview(
  reviewed: OutlookPanelInvitationStatus,
  receipt: OutlookPanelInvitationStatus,
) {
  return samePanelReview(reviewed, receipt);
}

export function isPanelReadFresh(loadedAt: number | null, now = Date.now()) {
  return loadedAt !== null && now - loadedAt >= 0 && now - loadedAt < PANEL_READ_FRESH_MS;
}
