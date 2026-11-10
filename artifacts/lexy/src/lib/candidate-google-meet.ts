import type { CandidateGoogleMeetView } from "@workspace/api-client-react";

/** Strict Meet code URL: https://meet.google.com/abc-defg-hij, nothing else. */
const MEET = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function safeMeetUrl(value: unknown): string | null {
  if (typeof value !== "string" || !MEET.test(value)) return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "meet.google.com" ||
      u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** Returns a safe URL only when the view matches the exact native id/start/duration. */
export function readReadyMeet(
  view: unknown,
  expected: { scheduleId: string; scheduledAt: string; durationMinutes: number },
): string | null {
  if (!view || typeof view !== "object") return null;
  const v = view as Partial<CandidateGoogleMeetView>;
  if (v.status !== "ready" || v.scheduleId !== expected.scheduleId) return null;
  if (typeof v.scheduledAt !== "string" || typeof v.durationMinutes !== "number") return null;
  const a = Date.parse(v.scheduledAt),
    b = Date.parse(expected.scheduledAt);
  if (!Number.isFinite(a) || a !== b || v.durationMinutes !== expected.durationMinutes) return null;
  return safeMeetUrl(v.meetUrl);
}
