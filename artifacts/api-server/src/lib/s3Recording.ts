/**
 * s3Recording.ts — Interview Video Recording Storage (S3)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Manages storage and retrieval of video interview recordings on AWS S3.
 * Uses the presigned-URL direct-upload pattern: the browser PUTs the video
 * blob directly to S3, so recording bytes never pass through the API server.
 *
 * ─── Key functions ────────────────────────────────────────────────────────────
 *   getRecordingUploadUrl()   — Generate a presigned PUT URL (browser upload)
 *   getRecordingPlaybackUrl() — Generate a presigned GET URL (time-limited playback)
 *   listRecordings()          — List all recordings for a candidate session
 *   isS3Configured()          — Feature check: returns false when AWS_S3_BUCKET not set
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *   AWS_REGION              S3 region (default "us-east-1")
 *   AWS_S3_BUCKET           Target bucket name (required for real uploads)
 *   AWS_ACCESS_KEY_ID       IAM user key (optional — use IAM role on EC2/ECS)
 *   AWS_SECRET_ACCESS_KEY   IAM user secret
 *   AWS_SESSION_TOKEN       STS session token (optional)
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/storage.ts    — presigned URL endpoints
 *   routes/interviews.ts — recording playback for session detail pages
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const S3_BUCKET  = process.env.AWS_S3_BUCKET ?? "";

function getS3Client(): S3Client {
  const config: ConstructorParameters<typeof S3Client>[0] = { region: AWS_REGION };

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken:    process.env.AWS_SESSION_TOKEN,
    };
  }
  // If running on EC2 / ECS with an IAM role, no credentials block needed —
  // the SDK picks up the instance profile automatically.

  return new S3Client(config);
}

export function isS3Configured(): boolean {
  return Boolean(S3_BUCKET);
}

/**
 * Generate a pre-signed PUT URL so the browser can upload a video blob
 * directly to S3 without routing the bytes through the API server.
 *
 * @returns uploadUrl  — PUT directly to this URL from the browser
 * @returns s3Key      — Store this key in the DB; use it later to get a playback URL
 */
export async function getRecordingUploadUrl(
  candidateId: string,
  filename = "interview.webm",
): Promise<{ uploadUrl: string; s3Key: string }> {
  if (!S3_BUCKET) {
    throw new Error(
      "AWS_S3_BUCKET is not set. Set this environment variable to enable video recording storage.",
    );
  }

  const safe    = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const s3Key   = `interview-recordings/${candidateId}/${randomUUID()}-${safe}`;
  const client  = getS3Client();

  const command = new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         s3Key,
    ContentType: "video/webm",
    ServerSideEncryption: "AES256",
    Metadata: {
      candidateId,
      uploadedAt: new Date().toISOString(),
    },
  });

  // URL valid for 30 minutes — enough for large recordings to upload
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 1800 });
  return { uploadUrl, s3Key };
}

/**
 * Generate a time-limited pre-signed GET URL so admins can play back a recording.
 * Default expiry: 1 hour.
 */
export async function getRecordingPlaybackUrl(
  s3Key: string,
  expiresInSec = 3600,
): Promise<string> {
  if (!S3_BUCKET) throw new Error("AWS_S3_BUCKET is not set.");

  const client  = getS3Client();
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key });
  return getSignedUrl(client, command, { expiresIn: expiresInSec });
}

/**
 * List all part keys for a chunked screen recording, sorted in upload order.
 * `sessionId` is the UUID used when the parts were uploaded.
 * `privatePrefix` defaults to "private" (matches ObjectStorageService).
 */
export async function listRecordingParts(
  sessionId: string,
  privatePrefix = process.env.AWS_S3_PRIVATE_PREFIX?.replace(/\/$/, "") ?? "private",
): Promise<{ key: string; size: number }[]> {
  if (!S3_BUCKET) throw new Error("AWS_S3_BUCKET is not set.");

  const client  = getS3Client();
  const prefix  = `${privatePrefix}/recordings/${sessionId}/`;
  const parts: { key: string; size: number }[] = [];

  let continuationToken: string | undefined;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const resp = await client.send(cmd);
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) parts.push({ key: obj.Key, size: obj.Size ?? 0 });
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  // Sort by key name — zero-padded part numbers ensure lexicographic = chronological
  parts.sort((a, b) => a.key.localeCompare(b.key));
  return parts;
}

/**
 * Stream all parts of a chunked recording to the given writable stream.
 * Parts are streamed sequentially in upload order.
 */
export async function streamRecordingParts(
  sessionId: string,
  out: NodeJS.WritableStream,
): Promise<void> {
  if (!S3_BUCKET) throw new Error("AWS_S3_BUCKET is not set.");
  const client  = getS3Client();
  const parts   = await listRecordingParts(sessionId);
  if (parts.length === 0) throw new Error("No recording parts found.");

  const { Readable } = await import("stream");
  for (const part of parts) {
    const resp  = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: part.key }));
    const body  = resp.Body as import("stream").Readable | null;
    if (!body) continue;
    await new Promise<void>((resolve, reject) => {
      body.on("error", reject);
      body.on("end",   resolve);
      body.pipe(out, { end: false });
    });
  }
}

/**
 * Check whether a recording actually exists in S3 (for admin verification).
 */
export async function recordingExists(s3Key: string): Promise<boolean> {
  if (!S3_BUCKET) return false;
  try {
    const client = getS3Client();
    await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    return true;
  } catch {
    return false;
  }
}
