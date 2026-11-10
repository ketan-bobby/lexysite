import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { meetingUploadInput } from "./meeting-notes-core";
import { NativeRecordingError, type ZoomRecordingFile } from "./zoom-recordings-provider";

export const nativeZoomPreviewInput = z.object({ scheduleId: z.string().min(1).max(160) }).strict();
export const nativeZoomImportInput = meetingUploadInput
  .omit({ consent: true })
  .extend({
    consent: z.literal(true),
    reviewToken: z.string().min(1).max(8000),
  })
  .strict();
const claimsSchema = z
  .object({
    actorId: z.string(),
    tenantId: z.string(),
    jobId: z.string(),
    candidateId: z.string(),
    scheduleId: z.string(),
    scheduleVersion: z.string(),
    operationId: z.string(),
    snapshotHash: z.string(),
    accountRevision: z.string(),
    hostZoomId: z.string(),
    meetingId: z.string(),
    uuid: z.string(),
    fileId: z.string(),
    fileHash: z.string(),
    expires: z.number().int(),
  })
  .strict();
export type NativeRecordingClaims = z.infer<typeof claimsSchema>;
export const recordingFileHash = (row: ZoomRecordingFile) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        id: row.id,
        format: row.format,
        kind: row.kind,
        bytes: row.bytes,
        start: row.start,
        end: row.end,
      }),
    )
    .digest("hex");
export const nativeRecordingKey = (
  row: Pick<
    NativeRecordingClaims,
    "tenantId" | "jobId" | "candidateId" | "hostZoomId" | "uuid" | "fileId"
  >,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        row.tenantId,
        row.jobId,
        row.candidateId,
        row.hostZoomId,
        row.uuid,
        row.fileId,
      ]),
    )
    .digest("hex");
const secret = () => {
  if (!process.env.SESSION_SECRET)
    throw new NativeRecordingError(503, "Recording review is unavailable.");
  return process.env.SESSION_SECRET;
};
const signature = (body: string, key = secret()) =>
  createHmac("sha256", key).update(`native-zoom-recording:v1:${body}`).digest();
export function signRecordingReview(claims: NativeRecordingClaims, key?: string): string {
  const body = Buffer.from(JSON.stringify(claimsSchema.parse(claims))).toString("base64url");
  return `${body}.${signature(body, key).toString("base64url")}`;
}
export function readRecordingReview(
  token: string,
  now = Date.now(),
  key?: string,
): NativeRecordingClaims {
  try {
    const [body, sig, ...extra] = token.split(".");
    if (!body || !sig || extra.length) throw 0;
    const received = Buffer.from(sig, "base64url"),
      expected = signature(body, key);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw 0;
    const result = claimsSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (result.expires <= now || result.expires > now + 10 * 60_000 + 5000) throw 0;
    return result;
  } catch {
    throw new NativeRecordingError(
      409,
      "The recording preview changed or expired. Load a fresh preview before importing.",
    );
  }
}
