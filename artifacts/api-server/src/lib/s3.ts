/**
 * s3.ts — Shared S3 Client
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Exports a singleton S3Client used by objectStorage.ts and objectAcl.ts.
 *
 * ─── Bucket CORS is NOT configured by the application ───────────────────────
 * Browser-direct uploads (presigned PUT/POST) require the bucket itself to
 * allow the frontend origins (app.lexy.ai, us.lexy.ai, in.lexy.ai, …). This
 * is configured ONCE per environment via Terraform/IaC or the AWS console as
 * part of infrastructure setup — see docs/RELEASE_CHECKLIST.md.
 *
 * The application's IAM role intentionally does NOT carry s3:PutBucketCORS;
 * letting a running server rewrite bucket policy on boot is both a least-
 * privilege violation and a foot-gun (a misdeploy could open uploads to *).
 *
 * If browser uploads start failing with CORS errors after a fresh deploy,
 * the bucket policy is the place to look, not this file.
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *   AWS_REGION              S3 region (default "us-east-1")
 *   AWS_ACCESS_KEY_ID       IAM key (optional — use IAM role on EC2/ECS)
 *   AWS_SECRET_ACCESS_KEY   IAM secret
 */
import { S3Client } from "@aws-sdk/client-s3";

export const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  // Only supply explicit credentials when the env vars are present.
  // If they are absent (e.g. EC2 / ECS / Lambda with an IAM role), leave
  // credentials undefined so the AWS SDK falls back to the full credential
  // provider chain: env → shared config → EC2 instance metadata (IMDS).
  // Passing `{ accessKeyId: undefined, secretAccessKey: undefined }` bypasses
  // IMDS entirely and causes every request to fail with InvalidSignatureException.
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN
            ? { sessionToken: process.env.AWS_SESSION_TOKEN }
            : {}),
        },
      }
    : {}),
});

/** Default server-side encryption applied to every PutObject in the platform.
 *  AES256 is bucket-default for most setups, but specifying it explicitly
 *  guarantees the object is encrypted regardless of bucket configuration. */
export const S3_DEFAULT_SSE = "AES256" as const;
