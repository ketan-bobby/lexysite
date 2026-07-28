/**
 * routes/storage.ts — File Upload, Download & Multipart Video Upload
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * All file I/O routes: requesting presigned upload URLs, serving private object
 * downloads, and the server-side multipart upload API for large video recordings
 * that can't use a single presigned PUT (>5 GB or unreliable mobile connections).
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /objects/upload-url      Request a presigned S3 PUT URL for a file.
 *                                 Returns { uploadUrl, objectPath } where
 *                                 objectPath is the canonical /objects/… key to
 *                                 store in the DB after the browser PUT succeeds.
 *   GET  /objects/*               Download / proxy a private S3 object.
 *                                 Enforces ACL + ownership before streaming.
 *   POST /objects/multipart/start   Initiate a multipart upload (CreateMultipart)
 *   POST /objects/multipart/part    Get a presigned URL for one part
 *   POST /objects/multipart/complete Complete the multipart upload
 *   POST /objects/multipart/abort  Abort an in-progress multipart upload
 *
 * ─── Presigned URL pattern ───────────────────────────────────────────────────
 * Browsers PUT bytes directly to S3 using the presigned URL — bytes never
 * transit the API server. This keeps API memory pressure low for large files
 * (resumes, recordings up to 500 MB). After the PUT succeeds, the client
 * calls the relevant resource endpoint (candidate PATCH, interview session
 * PATCH) to associate the /objects/… path with the DB record.
 *
 * ─── Auth guard ──────────────────────────────────────────────────────────────
 * resolveCaller() requires a valid demo_token_<userId> Bearer token. Anonymous
 * access is rejected because presigned URLs incur S3 storage costs, making
 * unauthenticated access a DoS / cost-abuse vector.
 *
 * ─── ACL enforcement (GET /objects/*) ────────────────────────────────────────
 * canAccessObjectEntity() reads the S3 object tag (objectAcl.ts) and checks:
 *   public visibility → always allowed
 *   private → caller must be owner OR have an explicit ACL grant
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { Readable } from "stream";
import multer from "multer";
import { randomUUID } from "crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";

/* Multipart upload chunk + part endpoints accept a small set of form-data
 * fields alongside the file. Validate inline (post-multer) for the same
 * reason as candidate-import: req.body doesn't exist until multer parses
 * the envelope, so the validate() middleware can't run upstream. */
/* IMPORTANT: do NOT use bare `z.coerce.number()` on multipart string fields.
 * `Number("") === 0`, so an empty string would silently pass as chunk 0
 * (or part 0) and let the handler execute on malformed input. We require
 * the raw value be a non-empty string of digits BEFORE coercing, which is
 * the only way to fail-closed on missing/empty multipart fields. */
const intStringField = (min: number, max: number) =>
  z.string().regex(/^\d+$/, "must be a non-empty integer string")
    .transform((s) => Number(s))
    .pipe(z.number().int().min(min).max(max));

const ChunkFields = z.object({
  uploadId: z.string().trim().min(1).max(200),
  chunkIndex: intStringField(0, 99_999),
  totalChunks: intStringField(1, 100_000),
  /* Optional: lets the multipart completion attach the recording pointer to the
     interview session in-request, mirroring POST /storage/uploads/recording. */
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "sessionId must be a UUID").optional(),
}).strict();

const PartFields = z.object({
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "sessionId must be a UUID"),
  partNumber: intStringField(1, 9999),
}).strict();
import { ObjectStorageService, ObjectNotFoundError, s3Client } from "../lib/objectStorage";
import { ObjectPermission, getObjectAclPolicy } from "../lib/objectAcl";
import { controlDb, db, usersTable, interviewSessionsTable, candidatesTable, candidateCareerProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveCandidateId } from "../lib/portal-auth";
import { getAuthUserId } from "../lib/auth-token";
import { getAllowedTenantIds } from "../lib/tenantUtils";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * isCallerAuthorizedForSession — the ownership/capability check that gates every
 * recording write for a given interview session. A caller is authorized when
 * they are the platform admin, the session's own candidate (matched by the
 * candidates.user_id FK, NEVER by email), or a recruiter/admin inside the
 * session's tenant subtree. Returns false when the session does not exist so a
 * non-owner can't distinguish "wrong session" from "no such session".
 *
 * This is the single source of truth shared by attachRecordingToSession (the
 * pointer write on POST /recording and /chunk) and the POST /recording/part
 * S3 write, whose object key is derived from the caller-supplied sessionId and
 * therefore MUST be ownership-checked before any storage I/O.
 */
async function isCallerAuthorizedForSession(callerId: string, sessionId: string, req: Request): Promise<boolean> {
  const [session] = await db.select().from(interviewSessionsTable).where(eq(interviewSessionsTable.id, sessionId)).limit(1);
  if (!session) return false;
  const [callerUser] = await controlDb.select().from(usersTable).where(eq(usersTable.id, callerId)).limit(1);

  if (callerUser?.role === "platform_admin") return true;
  /* Candidate-owner: match the session's candidate by FK, never by email. */
  if (session.candidateId) {
    const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, session.candidateId)).limit(1);
    if (cand?.userId && cand.userId === callerId) return true;
  }
  /* Tenant recruiter/admin fallback (e.g. a recruiter re-uploading). */
  if (callerUser) {
    const allowed = await getAllowedTenantIds(callerUser as any);
    if (allowed === null || (session.tenantId && allowed.includes(session.tenantId))) return true;
  }
  return false;
}

/**
 * attachRecordingToSession — persist `recordingUrl` on an interview session
 * from inside the (already authenticated) upload request.
 *
 * Why here and not the separate PATCH /interviews/:id/recording: the recording
 * upload is fired in the BACKGROUND at interview completion and is slow, so by
 * the time it finishes the candidate's per-session interview cookie has been
 * cleared by /end and the session is `completed`. The candidate is NOT a tenant
 * member, so the tenant-gated PATCH rejects them and the pointer is silently
 * lost (file uploaded, but recruiter sees "No recording available"). Attaching
 * here — authorized by the candidate's own user FK (candidates.user_id, NEVER
 * email) or a tenant recruiter/admin — closes that gap without weakening the
 * standalone PATCH. Returns true when the pointer was written.
 */
async function attachRecordingToSession(callerId: string, sessionId: string, objectPath: string, req: Request): Promise<boolean> {
  const authorized = await isCallerAuthorizedForSession(callerId, sessionId, req);
  if (!authorized) {
    req.log.warn({ sessionId, callerId }, "[storage] recording not attached — caller not authorized for session");
    return false;
  }
  await db.update(interviewSessionsTable).set({ recordingUrl: objectPath }).where(eq(interviewSessionsTable.id, sessionId));
  return true;
}

/* Mirror the demo-token auth pattern used in routes/interviews.ts so the
 * recording upload endpoint can't be hit anonymously (it accepts up to
 * 500 MB per request — unauthenticated access would be a DoS / S3 cost
 * abuse vector). */
async function resolveCaller(req: Request): Promise<{ id: string } | null> {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ? { id: u.id } : null;
}

/* Auth gate for upload endpoints. Runs BEFORE multer so an unauthenticated
 * request is rejected before its body is buffered into server memory (prevents
 * anonymous upload / cost-abuse). Stashes the caller for the handler. */
async function requireCaller(req: Request, res: Response, next: NextFunction) {
  const caller = await resolveCaller(req);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).caller = caller;
  next();
}

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* Photo uploads (e.g. recruiter intro avatar). 8 MB matches the UI hint. */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

/* Larger limit for interview recordings — videos are big.
 * 500 MB is enough for ~45 min of 800 kbps webm. */
const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

/* Chunks must be >= 5 MB (S3 multipart minimum per-part size, last part exempt).
 * 6 MB multer limit gives headroom for multipart form overhead. */
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

/* Screen recording parts — each part is a complete standalone object.
 * Screen recordings at 30s / 720p can reach ~30 MB per chunk; 50 MB limit
 * is generous headroom. */
const partUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/* S3-multipart-backed store for chunked recording uploads.
 *
 * Each chunk is forwarded directly to S3 as a multipart part — zero disk I/O,
 * zero RAM accumulation beyond a single in-flight multer buffer (~5.5 MB).
 * The Map holds only tiny metadata per session: S3 UploadId + ETags.
 *
 * S3 multipart constraints:
 *   - Parts must be >= 5 MB except the last one → frontend sends 5.5 MB chunks.
 *   - Max 10,000 parts → 10,000 × 5.5 MB = ~55 GB max recording (more than enough).
 *   - Incomplete uploads are billed until aborted; the 30-min eviction timer
 *     calls AbortMultipartUpload to prevent orphaned-part costs.
 */
interface MultipartEntry {
  s3UploadId: string;
  s3Key: string;
  etags: Map<number, string>;   // partNumber (1-based) → ETag
  totalChunks: number;
  mimeType: string;
  timer: ReturnType<typeof setTimeout>;
  /* Capability sessionId bound at init so retried chunks of the same upload
     don't re-fail the DB capability check after the final chunk sets recordingUrl. */
  capabilitySessionId?: string | null;
  /* Set once the multipart upload has completed. A retried final chunk (whose
     response was lost on a flaky connection) returns this cached result instead
     of 401-ing or trying to re-complete an already-finished S3 upload. */
  completed?: { objectPath: string; attached: boolean };
}
const multipartStore = new Map<string, MultipartEntry>();

async function evictMultipartEntry(uploadId: string) {
  const entry = multipartStore.get(uploadId);
  if (!entry) return;
  clearTimeout(entry.timer);
  multipartStore.delete(uploadId);
  /* Abort so S3 doesn't keep billing for orphaned parts */
  try {
    await s3Client.send(new AbortMultipartUploadCommand({
      Bucket: objectStorageService.getBucket(),
      Key: entry.s3Key,
      UploadId: entry.s3UploadId,
    }));
  } catch { /* best-effort */ }
}

const ALLOWED_RESUME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
];

const ALLOWED_RECORDING_TYPES = [
  "video/webm",
  "video/mp4",
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
];

/**
 * POST /storage/uploads/file
 *
 * Server-side file upload proxy — receives the file as multipart/form-data
 * and uploads it directly to object storage via the server SDK, avoiding
 * any browser CORS restrictions with presigned URLs.
 */
router.post(
  "/storage/uploads/file",
  requireCaller,
  resumeUpload.single("file"),
  async (req: Request, res: Response) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    if (!ALLOWED_RESUME_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: "Only PDF and Word documents (.pdf, .doc, .docx) are accepted" });
      return;
    }
    try {
      const objectPath = await objectStorageService.uploadBuffer(file.buffer, file.mimetype);
      res.json({ objectPath });
    } catch (err) {
      req.log.error({ err }, "Server-side file upload failed");
      res.status(500).json({ error: "Failed to upload file" });
    }
  }
);

/**
 * POST /storage/uploads/image
 *
 * Server-side image upload proxy — for photos such as the recruiter intro
 * avatar. Mirrors /uploads/file but accepts image mime types instead of
 * documents. Returns the same { objectPath } shape.
 */
router.post(
  "/storage/uploads/image",
  requireCaller,
  imageUpload.single("file"),
  async (req: Request, res: Response) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: "Only JPG, PNG, or WebP images are accepted" });
      return;
    }
    try {
      const objectPath = await objectStorageService.uploadBuffer(file.buffer, file.mimetype);
      res.json({ objectPath });
    } catch (err) {
      req.log.error({ err }, "Server-side image upload failed");
      res.status(500).json({ error: "Failed to upload image" });
    }
  }
);

/**
 * POST /storage/uploads/recording
 *
 * Server-proxied upload for interview recordings (and other A/V media). The
 * browser POSTs the blob as multipart/form-data here and we stream it to
 * object storage via the server SDK. This bypasses S3 CORS — presigned-URL
 * PUTs from the browser fail when the bucket lacks a CORS policy and the
 * IAM user can't run s3:PutBucketCORS to fix it (which is the case in this
 * deployment). Returns the same { objectPath } shape so the existing
 * `/interviews/:id/recording` PATCH still works.
 */
router.post(
  "/storage/uploads/recording",
  recordingUpload.single("file"),
  async (req: Request, res: Response) => {
    /* Auth gate — without this anyone could push 500 MB blobs to our S3
     * bucket. Primary: Bearer token (recruiters + portal users with a userId).
     * Fallback: sessionId capability — if the multipart body contains a
     * sessionId that refers to a session completed within the last 30 minutes
     * with no recording attached yet, treat the UUID itself as a capability
     * token. This handles candidates who have no portal account (userId=null)
     * and therefore can't receive a Bearer token via /upload-token. */
    const caller = await resolveCaller(req);
    let sessionCapabilityId: string | null = null;

    if (!caller) {
      const sid = (req.body?.sessionId ?? "").toString().trim();
      if (sid && UUID_RE.test(sid)) {
        const [capSess] = await db
          .select({
            status:       interviewSessionsTable.status,
            completedAt:  interviewSessionsTable.completedAt,
            recordingUrl: interviewSessionsTable.recordingUrl,
          })
          .from(interviewSessionsTable)
          .where(eq(interviewSessionsTable.id, sid))
          .limit(1);

        const ageMs = capSess?.completedAt
          ? Date.now() - new Date(capSess.completedAt).getTime()
          : Infinity;

        if (capSess?.status === "completed" && !capSess.recordingUrl && ageMs < 30 * 60 * 1000) {
          sessionCapabilityId = sid;
          req.log.info({ sessionId: sid, ageMs }, "[storage] recording upload auth via session capability");
        }
      }
      if (!sessionCapabilityId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    /* MediaRecorder commonly emits mime types with codec parameters such as
     * `video/webm;codecs=vp9,opus`. Strip the parameters before checking
     * against the allowed list so a perfectly valid recording isn't rejected.
     * Also fall back to the filename extension when the part header was
     * mangled by a proxy or the browser failed to set the blob's type. */
    const baseMime = (file.mimetype || "").split(";")[0].trim().toLowerCase();
    const extMime = (() => {
      const name = (file.originalname || "").toLowerCase();
      if (name.endsWith(".webm")) return "video/webm";
      if (name.endsWith(".mp4")) return "video/mp4";
      if (name.endsWith(".m4a")) return "audio/mp4";
      if (name.endsWith(".ogg")) return "audio/ogg";
      return "";
    })();
    const effectiveMime = ALLOWED_RECORDING_TYPES.includes(baseMime)
      ? baseMime
      : (ALLOWED_RECORDING_TYPES.includes(extMime) ? extMime : "");
    if (!effectiveMime) {
      req.log.warn(
        { receivedMime: file.mimetype, baseMime, originalname: file.originalname, size: file.size },
        "[storage] Recording upload rejected — unsupported media type",
      );
      res.status(400).json({ error: `Unsupported media type: ${file.mimetype}` });
      return;
    }
    try {
      const objectPath = await objectStorageService.uploadBuffer(file.buffer, effectiveMime, "recordings");
      req.log.info({ size: file.size, mime: effectiveMime, rawMime: file.mimetype, objectPath }, "Interview recording uploaded");
      /* Attach to the session in this same authenticated request when a valid
       * sessionId is supplied — the candidate can't reliably hit the separate
       * tenant-gated PATCH after /end. Best-effort: a failure here still returns
       * the objectPath so the client can fall back to the PATCH. */
      let attached = false;
      const sessionId = (req.body?.sessionId ?? "").toString().trim();
      if (sessionId && UUID_RE.test(sessionId)) {
        try {
          if (sessionCapabilityId) {
            /* Candidate with no portal account — attach directly since we
             * already validated the session capability above. */
            await db
              .update(interviewSessionsTable)
              .set({ recordingUrl: objectPath })
              .where(eq(interviewSessionsTable.id, sessionCapabilityId));
            attached = true;
            req.log.info({ sessionId: sessionCapabilityId, objectPath }, "[storage] recording attached via session capability");
          } else {
            attached = await attachRecordingToSession(caller!.id, sessionId, objectPath, req);
          }
        } catch (e: any) {
          req.log.error({ err: e?.message, sessionId }, "[storage] recording attach failed");
        }
      }
      res.json({ objectPath, attached });
    } catch (err: any) {
      req.log.error({ err: err?.message, stack: err?.stack }, "Recording upload failed");
      res.status(500).json({ error: err?.message || "Failed to upload recording" });
    }
  },
);

/**
 * POST /storage/uploads/recording/chunk
 *
 * S3 Multipart Upload — each chunk is forwarded directly to S3 as a numbered
 * part. No disk I/O, no RAM accumulation; the Map holds only tiny metadata
 * (S3 UploadId + ETags). S3 assembles the final object natively when
 * CompleteMultipartUpload is called on the last chunk.
 *
 * S3 constraint: all parts except the last must be >= 5 MB.
 * The frontend sends 5.5 MB chunks to satisfy this.
 *
 * Fields (multipart/form-data):
 *   file        — the chunk bytes
 *   uploadId    — UUID identifying this upload session (client-generated)
 *   chunkIndex  — 0-based index of this chunk
 *   totalChunks — total number of chunks in this upload
 */
router.post(
  "/storage/uploads/recording/chunk",
  chunkUpload.single("file"),
  async (req: Request, res: Response) => {
    const caller = await resolveCaller(req);
    /* Same dual auth as POST /storage/uploads/recording: a Bearer token, or —
       for a portal-less candidate — the sessionId as a capability token when it
       refers to a session completed in the last 30 min with no recording yet.
       The capability is validated once (at multipart init) and then BOUND to the
       upload entry, so retried chunks of the same upload don't re-fail the DB
       check once the final chunk has set recordingUrl. */
    const uploadIdRaw = (req.body?.uploadId ?? "").toString().trim();
    const existingEntry = uploadIdRaw ? multipartStore.get(uploadIdRaw) : undefined;
    let sessionCapabilityId: string | null = null;
    if (!caller) {
      if (existingEntry?.capabilitySessionId) {
        sessionCapabilityId = existingEntry.capabilitySessionId;
      } else {
        const sid = (req.body?.sessionId ?? "").toString().trim();
        if (sid && UUID_RE.test(sid)) {
          const [capSess] = await db
            .select({
              status:       interviewSessionsTable.status,
              completedAt:  interviewSessionsTable.completedAt,
              recordingUrl: interviewSessionsTable.recordingUrl,
            })
            .from(interviewSessionsTable)
            .where(eq(interviewSessionsTable.id, sid))
            .limit(1);
          const ageMs = capSess?.completedAt
            ? Date.now() - new Date(capSess.completedAt).getTime()
            : Infinity;
          if (capSess?.status === "completed" && !capSess.recordingUrl && ageMs < 30 * 60 * 1000) {
            sessionCapabilityId = sid;
          }
        }
      }
      if (!sessionCapabilityId) { res.status(401).json({ error: "Authentication required" }); return; }
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ error: "No chunk provided" }); return; }

    const parsed = ChunkFields.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "VALIDATION_FAILED",
        message: "Chunk fields did not match the expected schema.",
        issues: parsed.error.issues,
      });
      return;
    }
    const { uploadId, chunkIndex, totalChunks, sessionId: bodySessionId } = parsed.data;

    /* Reject malformed chunk metadata that would corrupt the completion set. */
    if (chunkIndex >= totalChunks) {
      res.status(400).json({ error: "chunkIndex out of range for totalChunks" });
      return;
    }

    const bucket         = objectStorageService.getBucket();
    const privatePrefix  = objectStorageService.getPrivatePrefix();

    let entry = multipartStore.get(uploadId);

    /* Idempotent retry: the final chunk's response was lost in transit and the
       client re-sent it. The upload already completed — return the cached result
       instead of re-completing (the S3 multipart session is gone) or 401-ing. */
    if (entry?.completed) {
      res.json({ done: true, objectPath: entry.completed.objectPath, attached: entry.completed.attached });
      return;
    }

    /* A given uploadId must keep a consistent totalChunks across its chunks. */
    if (entry && entry.totalChunks !== totalChunks) {
      res.status(400).json({ error: "totalChunks mismatch for this uploadId" });
      return;
    }

    /* Get or initiate the S3 multipart upload session */
    if (!entry) {
      const baseMime  = (file.mimetype || "video/webm").split(";")[0].trim().toLowerCase();
      const mimeType  = ALLOWED_RECORDING_TYPES.includes(baseMime) ? baseMime : "video/webm";
      const s3Key     = `${privatePrefix}/uploads/${randomUUID()}`;

      const initResult = await s3Client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: s3Key,
        ContentType: mimeType,
      }));

      /* Auto-abort after 30 min to avoid orphaned-part costs */
      const timer = setTimeout(() => evictMultipartEntry(uploadId), 30 * 60 * 1000);
      entry = { s3UploadId: initResult.UploadId!, s3Key, etags: new Map(), totalChunks, mimeType, timer, capabilitySessionId: sessionCapabilityId };
      multipartStore.set(uploadId, entry);
    }

    /* Upload this chunk as a multipart part (S3 part numbers are 1-based) */
    const partNumber = chunkIndex + 1;
    const partResult = await s3Client.send(new UploadPartCommand({
      Bucket: bucket,
      Key: entry.s3Key,
      UploadId: entry.s3UploadId,
      PartNumber: partNumber,
      Body: file.buffer,
      ContentLength: file.buffer.length,
    }));
    entry.etags.set(partNumber, partResult.ETag!);

    req.log.info(
      { uploadId, partNumber, totalChunks, received: entry.etags.size, size: file.size },
      "Recording part uploaded to S3",
    );

    /* Not all parts in yet */
    if (entry.etags.size < entry.totalChunks) {
      res.json({ done: false, received: entry.etags.size, total: entry.totalChunks });
      return;
    }

    /* All parts uploaded — complete the multipart upload. Pause eviction while
       we finish; we re-arm a timer below for both the success and failure cases. */
    const { s3UploadId, s3Key, mimeType, etags } = entry;
    clearTimeout(entry.timer);

    try {
      const parts = Array.from(etags.entries())
        .sort(([a], [b]) => a - b)
        .map(([PartNumber, ETag]) => ({ PartNumber, ETag }));

      await s3Client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: s3Key,
        UploadId: s3UploadId,
        MultipartUpload: { Parts: parts },
      }));

      /* Return objectPath in the same /objects/... shape as uploadBuffer() */
      const objectPath = `/objects/${s3Key.slice(privatePrefix.length + 1)}`;
      req.log.info({ uploadId, s3Key, parts: parts.length, mimeType, objectPath }, "Multipart recording completed");
      /* Attach the pointer to the session in this same authenticated request —
         mirrors POST /storage/uploads/recording so a portal-less candidate (who
         can't reach the tenant-gated PATCH after /end) still gets the recording
         linked. Best-effort: a failure still returns objectPath for a client PATCH. */
      let attached = false;
      if (bodySessionId && UUID_RE.test(bodySessionId)) {
        try {
          if (sessionCapabilityId) {
            await db
              .update(interviewSessionsTable)
              .set({ recordingUrl: objectPath })
              .where(eq(interviewSessionsTable.id, sessionCapabilityId));
            attached = true;
          } else if (caller) {
            attached = await attachRecordingToSession(caller.id, bodySessionId, objectPath, req);
          }
        } catch (e: any) {
          req.log.error({ err: e?.message, sessionId: bodySessionId }, "[storage] multipart recording attach failed");
        }
      }
      /* Keep the entry briefly (parts freed) so a retried final chunk whose
         response was lost returns this cached result. The S3 upload is already
         complete, so the short TTL timer just removes the in-memory entry — no
         AbortMultipartUpload (that would be a no-op error on a completed upload). */
      entry.etags.clear();
      entry.completed = { objectPath, attached };
      entry.timer = setTimeout(() => multipartStore.delete(uploadId), 5 * 60 * 1000);
      res.json({ done: true, objectPath, attached });
    } catch (err: any) {
      /* Completion failed — keep the entry and its parts so the client's retried
         final chunk can overwrite the part and re-attempt completion. Re-arm the
         eviction timer so a genuinely abandoned upload is still aborted (and not
         leaked) after 30 min. */
      entry.timer = setTimeout(() => evictMultipartEntry(uploadId), 30 * 60 * 1000);
      req.log.error({ err: err?.message }, "Multipart recording completion failed");
      res.status(500).json({ error: err?.message || "Failed to complete multipart recording upload" });
    }
  },
);

/**
 * POST /storage/uploads/recording/part
 *
 * Saves one screen-recording chunk as a complete, immediately-downloadable
 * S3 object. Each part is independent — no multipart session, no assembly
 * step. Parts land at:
 *
 *   private/recordings/<sessionId>/part_<NNNN>.<ext>
 *
 * NNNN is zero-padded to 4 digits so alphabetical order = chronological
 * order when listing/downloading.  If the interview is abandoned, all
 * successfully uploaded parts are already in S3 and can be reviewed or
 * concatenated (e.g. `ffmpeg -f concat`) into a single video.
 *
 * Fields (multipart/form-data):
 *   file       — the chunk bytes (30 s of screen recording at ~720p)
 *   sessionId  — UUID generated once per interview session (client-side)
 *   partNumber — 1-based sequence number for this chunk
 */
router.post(
  "/storage/uploads/recording/part",
  partUpload.single("file"),
  async (req: Request, res: Response) => {
    const caller = await resolveCaller(req);
    if (!caller) { res.status(401).json({ error: "Authentication required" }); return; }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) { res.status(400).json({ error: "No file provided" }); return; }

    /* sessionId UUID check + partNumber range are inside the schema so
     * the path-traversal guard can't accidentally be removed in a later
     * refactor. */
    const parsed = PartFields.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "VALIDATION_FAILED",
        message: "Part fields did not match the expected schema.",
        issues: parsed.error.issues,
      });
      return;
    }
    const { sessionId, partNumber } = parsed.data;

    /* Ownership gate — the S3 key below is derived from the caller-supplied
     * sessionId (private/recordings/<sessionId>/…), so without this ANY
     * authenticated caller could inject or clobber parts inside another
     * candidate's recording folder. Apply the SAME ownership/capability check
     * the sibling /recording and /chunk routes use (isCallerAuthorizedForSession)
     * BEFORE any storage I/O. A caller who does not own the session — or a
     * session that does not exist — gets a 404 so ownership can't be probed. */
    const authorized = await isCallerAuthorizedForSession(caller.id, sessionId, req);
    if (!authorized) {
      req.log.warn({ sessionId, callerId: caller.id }, "[storage] recording part rejected — caller not authorized for session");
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const bucket       = objectStorageService.getBucket();
    const privatePrefix = objectStorageService.getPrivatePrefix();
    const pad          = String(partNumber).padStart(4, "0");
    const baseMime     = (file.mimetype || "video/webm").split(";")[0].trim().toLowerCase();
    const mimeType     = ALLOWED_RECORDING_TYPES.includes(baseMime) ? baseMime : "video/webm";
    const ext          = mimeType.includes("mp4") ? "mp4" : "webm";
    const s3Key        = `${privatePrefix}/recordings/${sessionId}/part_${pad}.${ext}`;

    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: file.buffer,
        ContentType: mimeType,
      }));

      const objectPath = `/objects/recordings/${sessionId}/part_${pad}.${ext}`;
      req.log.info({ sessionId, partNumber, size: file.size, objectPath }, "Screen recording part saved");

      /* On the FIRST successfully-uploaded chunk, write the recording pointer
       * to the candidate's career profile. This makes the footage findable even
       * if the candidate abruptly closes the tab before the end-of-interview
       * save-recording call runs. Because the pointer only appears once part 1
       * (~10s of footage) exists, recordings shorter than the minimum length
       * never surface — short/abandoned attempts are handled separately.
       * Best-effort: never fail the upload if the pointer write errors. */
      if (partNumber === 1) {
        try {
          const candidateId = await resolveCandidateId(req);
          if (candidateId) {
            await db
              .insert(candidateCareerProfilesTable)
              .values({ candidateId, recordingUrl: `/recordings/${sessionId}/`, recordingStatus: null })
              .onConflictDoUpdate({
                target: candidateCareerProfilesTable.candidateId,
                set: { recordingUrl: `/recordings/${sessionId}/`, recordingStatus: null, updatedAt: new Date() },
              });
          }
        } catch (ptrErr: any) {
          req.log.warn({ err: ptrErr?.message, sessionId }, "Failed to write recording pointer on first chunk (non-fatal)");
        }
      }

      res.json({ ok: true, objectPath, partNumber, sessionId });
    } catch (err: any) {
      req.log.error({ err: err?.message }, "Screen recording part upload failed");
      res.status(500).json({ error: err?.message || "Failed to upload recording part" });
    }
  },
);

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", requireCaller, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
/**
 * canCallerReadObject — shared read-authorization for private objects, used by
 * both the streaming proxy (GET /storage/objects/*) and the presigned playback
 * URL endpoint (GET /storage/object-url/*). Standard ACL check first, then the
 * interview-recording fallback documented inline below.
 */
async function canCallerReadObject(
  callerId: string,
  objectPath: string,
  objectFile: Awaited<ReturnType<typeof objectStorageService.getObjectEntityFile>>,
  req: Request,
): Promise<boolean> {
    let canAccess = await objectStorageService.canAccessObjectEntity({
      userId: callerId,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    /* Interview-recording fallback: the ACL tag names the CANDIDATE as owner
     * (or is missing entirely — uploadBuffer() never tags), so a recruiter
     * streaming a recording always fails the plain owner check. If this object
     * is the recording of an interview session, defer to the canonical session
     * authorization (candidate-owner FK, tenant-subtree recruiter/admin, or
     * platform admin) — the same rule that gates recording writes.
     *
     * IDOR seal — a tenant user can repoint recording_url via the PATCH, so
     * session authorization alone would let them exfiltrate ANY private
     * object. The fallback therefore additionally requires:
     *   (a) the object is A/V media (recordings are video/audio; resumes and
     *       other private docs are not), and
     *   (b) the ACL owner, when a policy exists, is consistent with the
     *       session — the session's own candidate user or the caller. A
     *       missing policy is allowed (legacy uploadBuffer recordings).
     *
     * KNOWN GAP (accepted): an UNTAGGED, UNCLAIMED A/V object could still be
     * bound to a session via the (tenant-gated, A/V-checked, 409-on-claimed)
     * PATCH and then read here. Exploitation requires leaking the object's
     * random-UUID path AND tenant credentials; full closure needs upload-time
     * provenance binding, which is out of proportion to that threat. */
    if (!canAccess) {
      /* Fail-closed on ambiguous bindings: a recording must map to exactly ONE
       * session. Two sessions claiming the same object means someone repointed
       * a recording_url at another session's file — deny and log rather than
       * authorize via whichever row happened to come back first. */
      const recSessions = await db
        .select({ id: interviewSessionsTable.id, candidateId: interviewSessionsTable.candidateId })
        .from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.recordingUrl, objectPath))
        .limit(2);
      if (recSessions.length > 1) {
        req.log.warn({ objectPath }, "[storage] recording fallback denied — object referenced by multiple sessions");
      }
      const recSession = recSessions.length === 1 ? recSessions[0] : null;
      /* Presigned browser PUTs (the legacy /objects/uploads/… flow) often store
       * recordings with no ContentType or application/octet-stream, so treat
       * those as acceptable alongside real A/V types. Documents uploaded
       * server-side (resumes etc.) DO carry their real mime type and stay
       * excluded; the octet-stream allowance folds into the KNOWN GAP above. */
      const ct = (objectFile.contentType ?? "").toLowerCase();
      const isAvMedia = /^(video|audio)\//.test(ct) || ct === "" || ct === "application/octet-stream" || ct === "binary/octet-stream";
      if (recSession && isAvMedia && (await isCallerAuthorizedForSession(callerId, recSession.id, req))) {
        const policy = await getObjectAclPolicy(objectFile).catch(() => null);
        if (!policy || policy.owner === callerId) {
          canAccess = true;
        } else if (recSession.candidateId) {
          const [cand] = await db
            .select({ userId: candidatesTable.userId })
            .from(candidatesTable)
            .where(eq(candidatesTable.id, recSession.candidateId))
            .limit(1);
          canAccess = !!cand?.userId && policy.owner === cand.userId;
        }
        if (!canAccess) {
          req.log.warn({ objectPath, sessionId: recSession.id }, "[storage] recording fallback denied — ACL owner inconsistent with session");
        }
      } else if (!canAccess) {
        req.log.warn(
          { objectPath, sessionMatches: recSessions.length, contentType: objectFile.contentType ?? null },
          "[storage] recording fallback denied — no unique session match, non-A/V object, or caller not authorized for session",
        );
      }
    }
    return canAccess;
}

router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    /* Private objects require a valid caller AND an ACL grant. Resolve the
     * caller first so an unauthenticated request 401s before we reveal whether
     * the object exists. */
    const caller = await resolveCaller(req);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    if (!(await canCallerReadObject(caller.id, objectPath, objectFile, req))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

/**
 * GET /storage/object-url/*path
 *
 * Return a short-lived presigned S3 GET URL for a private object the caller is
 * authorized to read (same authorization as the streaming proxy above). Lets
 * the browser <video> element stream large interview recordings directly from
 * S3 with Range/seek support instead of proxying (or blob-downloading) the
 * whole file. When the stored ContentType isn't A/V (legacy presigned PUTs
 * stored octet-stream), override the response content type so browsers play
 * it rather than downloading it.
 */
router.get("/storage/object-url/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const caller = await resolveCaller(req);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    if (!(await canCallerReadObject(caller.id, objectPath, objectFile, req))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const ct = (objectFile.contentType ?? "").toLowerCase();
    const isAv = /^(video|audio)\//.test(ct);
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: objectFile.bucket,
        Key: objectFile.key,
        ...(isAv ? {} : { ResponseContentType: "video/webm" }),
      }),
      { expiresIn: 900 },
    );
    res.json({ url, expiresIn: 900 });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error presigning object URL");
    res.status(500).json({ error: "Failed to presign object URL" });
  }
});

export default router;
