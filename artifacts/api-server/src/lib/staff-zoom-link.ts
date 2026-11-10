import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { CalendarError } from "./outlook-calendar-core";
import type { PanelSchedule } from "./calendar-panel-access";
import { eligible } from "../routes/outlook-candidate-invitations";

export const zoomDraft = z.strictObject({
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
  expectedPublicationId: z.uuid().nullable(),
  joinUrl: z.string().min(1).max(2048),
});
export const zoomApproval = zoomDraft.extend({
  confirm: z.literal(true),
  approvalToken: z.string().regex(/^zl_[a-f0-9]{64}$/),
  reviewExpiresAt: z.iso.datetime({ offset: true }),
});
export const zoomRemoval = z.strictObject({
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
  expectedPublicationId: z.uuid(),
  confirm: z.literal(true),
});
export const zoomChanged = () =>
  new CalendarError(
    409,
    "zoom_review_changed",
    "The appointment, link or approval changed. Reload and review again.",
  );

/** Only participant join links; never start URLs, host tokens, redirects or fetches. */
export function zoomJoinUrl(raw: string): string {
  try {
    if (raw !== raw.trim() || /[\u0000-\u0020\\]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?zoom\.us$/.test(url.hostname) ||
      !/^\/j\/[0-9]{9,11}\/?$/.test(url.pathname)
    )
      throw new Error();
    const keys = [...url.searchParams.keys()];
    if (
      keys.length > 1 ||
      keys.some((key) => key !== "pwd") ||
      (keys.length && !/^[A-Za-z0-9._~-]{1,256}$/.test(url.searchParams.get("pwd") ?? ""))
    )
      throw new Error();
    // Normalize only after checking the raw path: dot-segment URLs are not accepted.
    if (!/^https:\/\/[^/]+\/j\/[0-9]{9,11}\/?(?:\?[^#]*)?$/.test(raw)) throw new Error();
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.href;
  } catch {
    throw new CalendarError(
      400,
      "invalid_zoom_join_link",
      "Use an HTTPS Zoom participant /j/ link, with only an optional meeting passcode. Host/start links are not accepted.",
    );
  }
}

export function zoomLinkReason(row: PanelSchedule, hasInvitation: boolean) {
  if (hasInvitation) return "calendar_invitation_exists" as const;
  try {
    eligible(row);
    return null;
  } catch {
    return "schedule_ineligible" as const;
  }
}

/** Public appointment evidence only; private notes/feedback do not invalidate a link. */
export function zoomSnapshot(row: PanelSchedule): string {
  const { schedule: s, application: a, job: j, candidate: c } = row;
  return createHash("sha256")
    .update(
      JSON.stringify([
        s.id,
        s.tenantId,
        s.applicationId,
        s.scheduledAt.toISOString(),
        s.durationMinutes,
        s.type,
        s.status,
        s.interviewerId,
        s.panelRevision ?? null,
        a.id,
        a.tenantId,
        a.candidateId,
        a.jobId,
        j.id,
        j.tenantId,
        c.id,
        c.userId,
        c.tenantId,
        c.email.trim().toLowerCase(),
      ]),
    )
    .digest("hex");
}

export function zoomReviewToken(
  secret: string,
  actorId: string,
  snapshot: string,
  nativeVersion: string,
  publicationId: string | null,
  url: string,
  expiry: string,
) {
  return `zl_${createHmac("sha256", secret)
    .update(JSON.stringify([actorId, snapshot, nativeVersion, publicationId, url, expiry]))
    .digest("hex")}`;
}
export function assertZoomApproval(expected: string, actual: string, expiry: string, now: number) {
  const until = Date.parse(expiry);
  if (
    !Number.isFinite(until) ||
    until <= now ||
    until > now + 10 * 60_000 ||
    !/^zl_[a-f0-9]{64}$/.test(actual) ||
    expected.length !== actual.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  )
    throw zoomChanged();
}
