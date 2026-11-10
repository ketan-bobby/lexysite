import type { CandidateOfferedTimes, StaffOfferedTimes } from "@workspace/api-client-react";

const VERSION = /^v1_[0-9a-f]{64}$/;
export const MAX_ALTERNATIVES = 4;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const validInstant = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

export function offeredTimesError(value: unknown, fallback: string): string {
  return isObj(value) && typeof value.error === "string" && value.error.length > 0
    ? value.error
    : fallback;
}

export function parseCandidateOfferedTimes(
  value: unknown,
  scheduleId: string,
): CandidateOfferedTimes {
  const bad = () => new Error("The offered times could not be verified. Reload and try again.");
  if (!isObj(value) || value.scheduleId !== scheduleId) throw bad();
  const { version, offerVersion, scheduledAt, durationMinutes, startsAt, expiresAt } = value;
  if (typeof version !== "string" || !VERSION.test(version)) throw bad();
  if (offerVersion !== null && typeof offerVersion !== "string") throw bad();
  if (!validInstant(scheduledAt)) throw bad();
  if (
    typeof durationMinutes !== "number" ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 480
  )
    throw bad();
  if (
    !Array.isArray(startsAt) ||
    startsAt.length < 1 ||
    startsAt.length > MAX_ALTERNATIVES + 1 ||
    !startsAt.every(validInstant)
  )
    throw bad();
  if (Date.parse(startsAt[0]) !== Date.parse(scheduledAt)) throw bad();
  if (new Set(startsAt.map((s) => Date.parse(s))).size !== startsAt.length) throw bad();
  if (expiresAt !== null && !validInstant(expiresAt)) throw bad();
  if (
    offerVersion === null
      ? startsAt.length !== 1 || expiresAt !== null
      : !offerVersion || expiresAt === null
  )
    throw bad();
  return value as unknown as CandidateOfferedTimes;
}

export function parseStaffOfferedTimes(value: unknown, scheduleId: string): StaffOfferedTimes {
  if (!isObj(value) || typeof value.version !== "string" || !VERSION.test(value.version))
    throw new Error("The offered times could not be verified. Reload and try again.");
  parseCandidateOfferedTimes(value.proposal, scheduleId);
  return value as unknown as StaffOfferedTimes;
}

/** Response to a PUT must match what was sent exactly. */
export function verifyPublished(
  value: unknown,
  scheduleId: string,
  sent: string[],
  previous?: StaffOfferedTimes,
): StaffOfferedTimes {
  const out = parseStaffOfferedTimes(value, scheduleId);
  if (
    previous &&
    (out.version !== previous.version ||
      out.proposal.version !== previous.proposal.version ||
      Date.parse(out.proposal.scheduledAt) !== Date.parse(previous.proposal.scheduledAt) ||
      out.proposal.durationMinutes !== previous.proposal.durationMinutes)
  )
    throw new Error("The original proposal changed. Reload before publishing again.");
  const got = out.proposal.startsAt.slice(1).map((s) => Date.parse(s));
  const want = sent.map((s) => Date.parse(s));
  if (got.length !== want.length || got.some((t, i) => t !== want[i]))
    throw new Error(
      "Lexy did not confirm the alternatives you sent. Reload the latest times before retrying.",
    );
  return out;
}

export function canOfferTimes(
  s: { status?: unknown; type?: unknown; scheduledAt?: unknown },
  now = Date.now(),
): boolean {
  return (
    s.status === "pending" &&
    s.type !== "ai_interview" &&
    validInstant(s.scheduledAt) &&
    Date.parse(s.scheduledAt) > now
  );
}

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local datetime-local strings to sorted unique ISO instants, or an error message. */
export function normalizeAlternatives(
  locals: string[],
  originalIso: string,
  now = Date.now(),
  anchors: string[] = [],
): { ok: true; value: string[] } | { ok: false; error: string } {
  const filled = locals.map((s) => s.trim());
  if (filled.some((s) => !s))
    return { ok: false, error: "Enter a time for each alternative, or remove the empty row." };
  if (filled.length > MAX_ALTERNATIVES)
    return { ok: false, error: "Offer at most four alternatives." };
  const times: number[] = [];
  for (const s of filled) {
    // Preserve exact UTC instants for unchanged inputs, including milliseconds
    // and DST-fold offsets. Ambiguous saved wall times require deliberate edits.
    const matches = anchors.filter((anchor) => toLocalInput(anchor) === s);
    if (matches.length > 1)
      return {
        ok: false,
        error:
          "Two saved times share this local clock time. Remove or change an alternative before publishing.",
      };
    const parsed = new Date(s);
    if (!Number.isFinite(parsed.getTime()))
      return { ok: false, error: "Enter a valid date and time for every alternative." };
    if (toLocalInput(parsed.toISOString()) !== s)
      return { ok: false, error: "This local time does not exist. Choose another time." };
    const t = matches.length ? Date.parse(matches[0]) : parsed.getTime();
    if (!Number.isFinite(t))
      return { ok: false, error: "Enter a valid date and time for every alternative." };
    if (t <= now) return { ok: false, error: "Alternatives must be in the future." };
    if (t === Date.parse(originalIso))
      return { ok: false, error: "An alternative matches the original time." };
    if (times.includes(t)) return { ok: false, error: "Two alternatives are the same time." };
    times.push(t);
  }
  times.sort((a, b) => a - b);
  return { ok: true, value: times.map((t) => new Date(t).toISOString()) };
}

/** Mirrors the stated policy: earliest proposed time or 7 days, whichever is sooner. */
export function expectedExpiry(startsAt: string[], now = Date.now()): string {
  const earliest = Math.min(...startsAt.map(Date.parse));
  return new Date(Math.min(earliest, now + 7 * 86_400_000)).toISOString();
}
