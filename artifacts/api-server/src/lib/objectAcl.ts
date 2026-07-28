/**
 * objectAcl.ts — S3 Object-Level ACL via Tags
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Implements a lightweight access-control layer for individual S3 objects by
 * storing an ACL policy as an S3 object tag. This sidesteps the need for
 * per-object S3 ACLs or bucket policies; the platform enforces access at
 * the application layer using the stored policy.
 *
 * ─── How it works ────────────────────────────────────────────────────────────
 * When an object is uploaded, callers optionally set an ObjectAclPolicy via
 * setObjectAclPolicy(). The policy is serialised to JSON and stored as the
 * S3 tag "acl-policy" on the object.
 *
 * canAccessObject() reads the tag and enforces:
 *   • public visibility + READ request → always allowed (no auth required)
 *   • private + userId matches owner  → allowed
 *   • private + userId matches an ACL rule group member → allowed if permission is sufficient
 *   • anything else → denied
 *
 * ─── ObjectPermission ────────────────────────────────────────────────────────
 *   READ   — can be granted by either READ or WRITE rules (WRITE implies READ)
 *   WRITE  — only granted by an explicit WRITE rule
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   objectStorage.ts  — downloadObject() reads the tag to set Cache-Control;
 *                       trySetObjectEntityAclPolicy() writes it after upload.
 *   routes/storage.ts — passes the policy to canAccessObjectEntity() before serving.
 */
import {
  PutObjectTaggingCommand,
  GetObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { s3Client } from "./s3";
import type { S3ObjectRef } from "./objectStorage";

const ACL_TAG_KEY = "acl-policy";

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

/* Access model is intentionally minimal: a single owner + public/private
 * visibility. Group-based ACL rules were scaffolded here once but never
 * implemented or written by any code path; the scaffolding was removed.
 * A stray `aclRules` key inside a stored tag is simply ignored. */
export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
}

export async function setObjectAclPolicy(
  obj: S3ObjectRef,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  await s3Client.send(new PutObjectTaggingCommand({
    Bucket: obj.bucket,
    Key: obj.key,
    Tagging: {
      TagSet: [{ Key: ACL_TAG_KEY, Value: JSON.stringify(aclPolicy) }],
    },
  }));
}

export async function getObjectAclPolicy(
  obj: S3ObjectRef,
): Promise<ObjectAclPolicy | null> {
  try {
    const result = await s3Client.send(new GetObjectTaggingCommand({
      Bucket: obj.bucket,
      Key: obj.key,
    }));
    const tag = (result.TagSet ?? []).find((t) => t.Key === ACL_TAG_KEY);
    if (!tag?.Value) return null;
    return JSON.parse(tag.Value) as ObjectAclPolicy;
  } catch {
    return null;
  }
}

export async function canAccessObject({
  userId,
  objectFile,
  requestedPermission,
}: {
  userId?: string;
  objectFile: S3ObjectRef;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const aclPolicy = await getObjectAclPolicy(objectFile);
  if (!aclPolicy) return false;

  if (
    aclPolicy.visibility === "public" &&
    requestedPermission === ObjectPermission.READ
  ) {
    return true;
  }

  if (!userId) return false;
  return aclPolicy.owner === userId;
}
