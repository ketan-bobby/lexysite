import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { GoogleMeetRecordingError } from "./google-meet-recordings-provider";

export const nativeMeetPreviewInput = z
  .object({
    scheduleId: z.string().min(1).max(160),
    conferenceName: z.string().regex(/^conferenceRecords\/[A-Za-z0-9_-]{1,160}$/),
  })
  .strict();
const reviewSchema = z
  .object({
    actorId: z.string(),
    tenantId: z.string(),
    jobId: z.string(),
    candidateId: z.string(),
    scheduleId: z.string(),
    binding: z.string(),
    accountRevision: z.string(),
    subjectHash: z.string(),
    spaceName: z.string(),
    conferenceName: z.string(),
    fileId: z.string(),
    fileHash: z.string(),
    expires: z.number().int(),
  })
  .strict();
export type NativeMeetReview = z.infer<typeof reviewSchema>;
export const meetRecordingChanged = () =>
  new GoogleMeetRecordingError(
    409,
    "The appointment, recording account or selected recording changed. Load and review a fresh preview.",
  );
const secret = () => {
  if (!process.env.SESSION_SECRET)
    throw new GoogleMeetRecordingError(503, "Recording review is unavailable.");
  return process.env.SESSION_SECRET;
};
const signature = (body: string, key = secret()) =>
  createHmac("sha256", key).update(`native-google-meet-recording:v1:${body}`).digest();
export function signMeetRecordingReview(claims: NativeMeetReview, key?: string) {
  const body = Buffer.from(JSON.stringify(reviewSchema.parse(claims))).toString("base64url");
  return `${body}.${signature(body, key).toString("base64url")}`;
}
export function readMeetRecordingReview(
  token: string,
  now = Date.now(),
  key?: string,
): NativeMeetReview {
  try {
    const [body, sig, ...extra] = token.split(".");
    if (!body || !sig || extra.length || token.length > 8000) throw 0;
    const actual = Buffer.from(sig, "base64url"),
      expected = signature(body, key);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw 0;
    const claims = reviewSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (claims.expires <= now || claims.expires > now + 605_000) throw 0;
    return claims;
  } catch {
    throw meetRecordingChanged();
  }
}
export const meetRecordingSourceKey = (claims: NativeMeetReview) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "google_meet",
        claims.tenantId,
        claims.jobId,
        claims.candidateId,
        claims.subjectHash,
        claims.spaceName,
        claims.conferenceName,
        claims.fileId,
      ]),
    )
    .digest("hex");
