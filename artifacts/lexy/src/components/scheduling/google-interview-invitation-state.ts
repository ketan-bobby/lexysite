import type { GoogleInterviewInvitationStatus as Status } from "@workspace/api-client-react";
import type { InvitationSchedule } from "./outlook-invitation-state";

/** Only canonical Google Meet room links are ever rendered as links. */
export const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const STATUSES = ["unavailable", "ready", "needs_review", "accepted", "blocked_other_provider"];
const CONF = ["not_requested", "pending", "ready", "failed"];
const instant = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Strict read: any surprise throws and nothing is shown or sent. */
export function readGoogleInvitation(value: unknown, schedule: InvitationSchedule): Status {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") throw new Error("bad");
  const ok =
    v.provider === "google" &&
    v.scheduleId === schedule.id &&
    typeof v.version === "string" &&
    v.version.length > 0 &&
    (schedule.version === undefined || v.version === schedule.version) &&
    instant(v.scheduledAt) &&
    Date.parse(v.scheduledAt as string) === Date.parse(schedule.scheduledAt) &&
    v.durationMinutes === schedule.durationMinutes &&
    typeof v.jobTitle === "string" &&
    typeof v.recipientEmail === "string" &&
    EMAIL.test(v.recipientEmail) &&
    (v.panelRecipientEmails === undefined ||
      (Array.isArray(v.panelRecipientEmails) &&
        v.panelRecipientEmails.length <= 5 &&
        v.panelRecipientEmails.every(
          (email) =>
            typeof email === "string" &&
            EMAIL.test(email) &&
            email.toLowerCase() !== String(v.recipientEmail).toLowerCase() &&
            email.toLowerCase() !== String(v.organizerEmail).toLowerCase(),
        ) &&
        new Set(v.panelRecipientEmails.map((email) => String(email).toLowerCase())).size ===
          v.panelRecipientEmails.length)) &&
    (v.organizerEmail === null ||
      (typeof v.organizerEmail === "string" && EMAIL.test(v.organizerEmail))) &&
    (v.connectionRevision === null || typeof v.connectionRevision === "string") &&
    STATUSES.includes(String(v.status)) &&
    CONF.includes(String(v.conferenceStatus)) &&
    v.deliveryConfirmed === false &&
    (v.acceptedAt === null || instant(v.acceptedAt)) &&
    (v.approvalToken === null || typeof v.approvalToken === "string") &&
    (v.reviewExpiresAt === null || instant(v.reviewExpiresAt)) &&
    (v.meetUrl === null || (typeof v.meetUrl === "string" && MEET_RE.test(v.meetUrl))) &&
    // A link is only meaningful once Google reports the conference ready.
    (v.conferenceStatus === "ready" ? v.meetUrl !== null : v.meetUrl === null);
  if (!ok) throw new Error("bad");
  if (v.status === "ready") {
    if (
      !v.approvalToken ||
      !v.reviewExpiresAt ||
      !v.organizerEmail ||
      !v.connectionRevision ||
      v.conferenceStatus !== "not_requested"
    )
      throw new Error("bad");
  }
  if (v.status === "accepted" && !v.acceptedAt) throw new Error("bad");
  return v as unknown as Status;
}

export function identityMatches(a: Status, b: Status): boolean {
  return (
    a.provider === b.provider &&
    a.scheduleId === b.scheduleId &&
    a.version === b.version &&
    Date.parse(a.scheduledAt) === Date.parse(b.scheduledAt) &&
    a.durationMinutes === b.durationMinutes &&
    a.jobTitle === b.jobTitle &&
    a.recipientEmail === b.recipientEmail &&
    JSON.stringify(a.panelRecipientEmails ?? []) === JSON.stringify(b.panelRecipientEmails ?? []) &&
    a.organizerEmail === b.organizerEmail &&
    a.connectionRevision === b.connectionRevision
  );
}

/** Fresh pre-send read must match every immutable reviewed detail. Each read issues its own
 * proof, so token/expiry are deliberately NOT compared; the original proof is what gets posted. */
export function sameGoogleReview(a: Status | null, b: Status | null): boolean {
  return !!a && !!b && a.status === "ready" && b.status === "ready" && identityMatches(a, b);
}

export function isExpired(s: Status | null, now = Date.now()): boolean {
  return !s?.reviewExpiresAt || Date.parse(s.reviewExpiresAt) <= now;
}
