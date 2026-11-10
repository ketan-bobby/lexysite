import type { GoogleInvitationOperationView as Op } from "@workspace/api-client-react";
import type { InvitationSchedule } from "./outlook-invitation-state";

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const TOKEN = /^gc_[0-9a-f]{64}$/;
const STATUSES = ["unavailable", "ready", "current", "accepted", "needs_review"];
const instant = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableInstant = (v: unknown) => v === null || instant(v);
const ms = (v: string | null) => (v === null ? null : Date.parse(v));

/** Kind is derived server-side from the native record: cancelled => cancel, else reschedule. */
export function expectedKind(schedule: { status: string }): "cancel" | "reschedule" {
  return schedule.status === "cancelled" ? "cancel" : "reschedule";
}

/** Strict read: any surprise throws, and nothing is shown or sent. */
export function readOperation(value: unknown, schedule: InvitationSchedule): Op {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") throw new Error("bad");
  const ok =
    v.provider === "google" &&
    v.scheduleId === schedule.id &&
    typeof v.version === "string" &&
    v.version.length > 0 &&
    (schedule.version === undefined || v.version === schedule.version) &&
    (v.kind === "reschedule" || v.kind === "cancel") &&
    STATUSES.includes(String(v.status)) &&
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
        new Set(v.panelRecipientEmails.map((email: string) => email.toLowerCase())).size ===
          v.panelRecipientEmails.length)) &&
    (v.organizerEmail === null ||
      (typeof v.organizerEmail === "string" && EMAIL.test(v.organizerEmail))) &&
    nullableInstant(v.previousStart) &&
    nullableInstant(v.previousEnd) &&
    nullableInstant(v.targetStart) &&
    nullableInstant(v.targetEnd) &&
    (v.sourceEtag === null || typeof v.sourceEtag === "string") &&
    (v.approvalToken === null || typeof v.approvalToken === "string") &&
    nullableInstant(v.reviewExpiresAt) &&
    (v.operationId === null || typeof v.operationId === "string") &&
    nullableInstant(v.acceptedAt) &&
    (v.meetUrl === null || typeof v.meetUrl === "string") &&
    v.deliveryConfirmed === false &&
    (v.kind !== "cancel" || (v.targetStart === null && v.targetEnd === null));
  if (!ok) throw new Error("bad");
  if (v.status === "ready") {
    if (
      v.kind !== expectedKind(schedule) ||
      typeof v.approvalToken !== "string" ||
      !TOKEN.test(v.approvalToken) ||
      !v.reviewExpiresAt ||
      !v.organizerEmail ||
      !v.sourceEtag ||
      !v.previousStart ||
      !v.previousEnd ||
      (v.kind === "reschedule" &&
        (!v.targetStart ||
          !v.targetEnd ||
          Date.parse(v.targetStart as string) !== Date.parse(schedule.scheduledAt)))
    )
      throw new Error("bad");
  }
  if (v.status === "accepted" && !v.acceptedAt) throw new Error("bad");
  return v as unknown as Op;
}

/** Immutable review details. Token and expiry rotate per read and are deliberately excluded. */
export function sameDetails(a: Op, b: Op): boolean {
  return (
    a.provider === b.provider &&
    a.scheduleId === b.scheduleId &&
    a.version === b.version &&
    a.kind === b.kind &&
    a.recipientEmail === b.recipientEmail &&
    JSON.stringify(a.panelRecipientEmails ?? []) === JSON.stringify(b.panelRecipientEmails ?? []) &&
    a.organizerEmail === b.organizerEmail &&
    ms(a.previousStart) === ms(b.previousStart) &&
    ms(a.previousEnd) === ms(b.previousEnd) &&
    ms(a.targetStart) === ms(b.targetStart) &&
    ms(a.targetEnd) === ms(b.targetEnd) &&
    a.sourceEtag === b.sourceEtag
  );
}

export function sameReview(a: Op | null, b: Op | null): boolean {
  return !!a && !!b && a.status === "ready" && b.status === "ready" && sameDetails(a, b);
}

export function expired(s: Op | null, now = Date.now()): boolean {
  return !s?.reviewExpiresAt || Date.parse(s.reviewExpiresAt) <= now;
}

/** Exact instant: local wall time with milliseconds and numeric offset, plus the raw ISO value. */
export function exactInstant(iso: string): { local: string; raw: string } {
  const d = new Date(iso);
  const local = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    timeZoneName: "longOffset",
  }).format(d);
  return { local, raw: iso };
}
