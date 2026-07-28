/**
 * objectStorage.ts — S3 Object Storage Service
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides a unified interface for storing and retrieving user-uploaded files
 * (resumes, interview recordings, profile assets, etc.) backed by Amazon S3.
 * All file references in the DB use the canonical `/objects/<key>` path format
 * so storage backends can be swapped without touching route code.
 *
 * ─── Path conventions ────────────────────────────────────────────────────────
 *   /objects/<private-prefix>/uploads/<uuid>           Generic entity uploads
 *   /objects/<private-prefix>/interview-recordings/…   Video recordings
 *   <public-prefix>/<filepath>                         Publicly readable assets
 *
 * ─── Key methods ─────────────────────────────────────────────────────────────
 *   getRecordingUploadURL()   Presigned PUT URL (30 min TTL) for browser-direct
 *                             video uploads — bytes never pass through the API.
 *   getObjectEntityUploadURL() Presigned PUT URL (15 min TTL) for generic files.
 *   getObjectEntityFile()     Resolve an /objects/… path → S3ObjectRef.
 *   downloadObject()          Stream an S3 object back as a web Response.
 *   uploadBuffer()            Server-side upload of a Buffer (e.g. parsed resume).
 *   normalizeObjectEntityPath() Convert raw S3 / presigned URLs → /objects/… canonical paths.
 *
 * ─── ACL / access control ────────────────────────────────────────────────────
 * Access control is stored as an S3 object tag (see objectAcl.ts). Public
 * objects get a permissive Cache-Control header; private objects get "private".
 * canAccessObjectEntity() enforces ownership + ACL rule checks before serving.
 *
 * ─── Environment variables ───────────────────────────────────────────────────
 *   AWS_S3_BUCKET           Target bucket name (required)
 *   AWS_S3_PRIVATE_PREFIX   Key prefix for private objects (default "private")
 *   AWS_S3_PUBLIC_PREFIX    Comma-separated prefixes for public objects (default "public")
 */
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { s3Client } from "./s3";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

export { s3Client };

/* ── S3ObjectRef replaces GCS File ────────────────────────────────────────── */

export interface S3ObjectRef {
  bucket: string;
  key: string;
  contentType?: string;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/* ── ObjectStorageService ─────────────────────────────────────────────────── */

export class ObjectStorageService {
  getBucket(): string {
    const bucket = process.env.AWS_S3_BUCKET || "";
    if (!bucket) throw new Error("AWS_S3_BUCKET is not set.");
    return bucket;
  }

  getPrivatePrefix(): string {
    return (process.env.AWS_S3_PRIVATE_PREFIX || "private").replace(/\/$/, "");
  }

  getPublicPrefixes(): string[] {
    return (process.env.AWS_S3_PUBLIC_PREFIX || "public")
      .split(",")
      .map((p) => p.trim().replace(/\/$/, ""))
      .filter(Boolean);
  }

  /* ── Public object search ───────────────────────────────────────────────── */

  async searchPublicObject(filePath: string): Promise<S3ObjectRef | null> {
    const bucket = this.getBucket();
    for (const prefix of this.getPublicPrefixes()) {
      const key = `${prefix}/${filePath}`;
      try {
        const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { bucket, key, contentType: head.ContentType };
      } catch (err: any) {
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) continue;
        throw err;
      }
    }
    return null;
  }

  /* ── Download ───────────────────────────────────────────────────────────── */

  async downloadObject(obj: S3ObjectRef, cacheTtlSec = 3600): Promise<Response> {
    const aclPolicy = await getObjectAclPolicy(obj).catch(() => null);
    const isPublic = aclPolicy?.visibility === "public";

    const result = await s3Client.send(new GetObjectCommand({ Bucket: obj.bucket, Key: obj.key }));
    const contentType = result.ContentType || "application/octet-stream";
    const contentLength = result.ContentLength;

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);

    const nodeStream = result.Body as NodeJS.ReadableStream;
    const webStream = Readable.toWeb(nodeStream as Readable) as ReadableStream;

    return new Response(webStream, { headers });
  }

  /* ── Presigned upload URL for interview recordings ──────────────────────── */

  async getRecordingUploadURL(
    candidateId: string,
    filename: string
  ): Promise<{ uploadUrl: string; objectPath: string }> {
    const bucket = this.getBucket();
    const objectId = randomUUID();
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${this.getPrivatePrefix()}/interview-recordings/${candidateId}/${objectId}-${safeFilename}`;

    const uploadUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ServerSideEncryption: "AES256" }),
      { expiresIn: 1800 }
    );

    return { uploadUrl, objectPath: `/objects/${key}` };
  }

  /* ── Presigned upload URL for generic entities ──────────────────────────── */

  async getObjectEntityUploadURL(): Promise<string> {
    const bucket = this.getBucket();
    const objectId = randomUUID();
    const key = `${this.getPrivatePrefix()}/uploads/${objectId}`;

    return getSignedUrl(
      s3Client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ServerSideEncryption: "AES256" }),
      { expiresIn: 900 }
    );
  }

  /* ── Resolve /objects/... path → S3ObjectRef ────────────────────────────── */

  async getObjectEntityFile(objectPath: string): Promise<S3ObjectRef> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();

    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) throw new ObjectNotFoundError();

    const bucket = this.getBucket();
    const key = `${this.getPrivatePrefix()}/${entityId}`;

    try {
      const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { bucket, key, contentType: head.ContentType };
    } catch (err: any) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        throw new ObjectNotFoundError();
      }
      throw err;
    }
  }

  /* ── Hard delete ────────────────────────────────────────────────────────
   *
   * Used by the GDPR / IL-AIVI right-to-erasure flow (routes/admin-deletion.ts).
   * Two flavours:
   *
   *   • deleteObjectByPath(/objects/...) — single object. Best-effort: a
   *     missing object resolves successfully so the erasure cascade does
   *     not block on a row whose file was already manually deleted.
   *
   *   • deleteObjectsUnderPrefix(prefix) — page-by-page delete of every
   *     object under a key prefix. Used for catch-all interview-recording
   *     cleanup keyed by /interview-recordings/<candidateId>/ so chunks /
   *     parts the DB never recorded a row for (failed uploads, abandoned
   *     multipart parts) are still removed.
   */
  async deleteObjectByPath(objectPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!objectPath || !objectPath.startsWith("/objects/")) {
      return { ok: false, error: "not_an_object_path" };
    }
    const bucket = this.getBucket();
    const key = `${this.getPrivatePrefix()}/${objectPath.slice("/objects/".length)}`;
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /** Delete every object whose key starts with `${privatePrefix}/${prefix}`.
   *  Returns the count deleted. Pages through S3's 1000-object listing limit. */
  async deleteObjectsUnderPrefix(prefix: string): Promise<{ deleted: number; error?: string }> {
    const bucket = this.getBucket();
    const fullPrefix = `${this.getPrivatePrefix()}/${prefix.replace(/^\/+|\/+$/g, "")}/`;
    let deleted = 0;
    let continuationToken: string | undefined = undefined;
    try {
      do {
        const list = await s3Client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }));
        const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
        if (objects.length > 0) {
          await s3Client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }));
          deleted += objects.length;
        }
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);
      return { deleted };
    } catch (err: any) {
      return { deleted, error: err?.message ?? String(err) };
    }
  }

  /* ── Server-side buffer upload ──────────────────────────────────────────── */

  async uploadBuffer(buffer: Buffer, contentType: string, folder = "uploads"): Promise<string> {
    const bucket = this.getBucket();
    const objectId = randomUUID();
    const key = `${this.getPrivatePrefix()}/${folder}/${objectId}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }));

    return `/objects/${folder}/${objectId}`;
  }

  /* ── Normalize raw S3 / presigned URL → /objects/... path ──────────────── */

  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("/objects/")) return rawPath;

    try {
      const url = new URL(rawPath);
      const bucket = this.getBucket();
      const privatePrefix = this.getPrivatePrefix();

      // e.g. https://<bucket>.s3.<region>.amazonaws.com/<prefix>/uploads/<id>
      const pathname = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const prefixWithSlash = `${privatePrefix}/`;
      if (pathname.startsWith(prefixWithSlash)) {
        return `/objects/${pathname.slice(prefixWithSlash.length)}`;
      }
      // Bucket-in-path style: https://s3.amazonaws.com/<bucket>/<key>
      const bucketPrefix = `${bucket}/${privatePrefix}/`;
      if (pathname.startsWith(bucketPrefix)) {
        return `/objects/${pathname.slice(bucketPrefix.length)}`;
      }
    } catch {
      // not a URL — fall through
    }

    return rawPath;
  }

  /* ── ACL helpers ────────────────────────────────────────────────────────── */

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/objects/")) return normalizedPath;

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: S3ObjectRef;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}
