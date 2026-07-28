/**
 * objectAcl.test.ts — unit tests for the S3 tag-based ACL layer.
 *
 * The shared s3Client's `send` method is mocked so no real AWS calls occur.
 * Run: npx tsx --test src/lib/objectAcl.test.ts
 */
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  PutObjectTaggingCommand,
  GetObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { s3Client } from "./s3";
import {
  ObjectPermission,
  setObjectAclPolicy,
  getObjectAclPolicy,
  canAccessObject,
  type ObjectAclPolicy,
} from "./objectAcl";

const obj = { bucket: "test-bucket", key: "uploads/abc" };

/** Install a mock for s3Client.send that returns `result` (or throws). */
function mockSend(handler: (cmd: unknown) => unknown) {
  return mock.method(s3Client, "send", async (cmd: unknown) => handler(cmd));
}

/** Build a GetObjectTagging response containing the given policy JSON. */
function taggingResponse(value: string | null) {
  return {
    TagSet: value === null ? [] : [{ Key: "acl-policy", Value: value }],
  };
}

beforeEach(() => {
  mock.restoreAll();
});

test("setObjectAclPolicy writes the policy as an S3 tag", async () => {
  const sent: unknown[] = [];
  mockSend((cmd) => {
    sent.push(cmd);
    return {};
  });

  const policy: ObjectAclPolicy = { owner: "user-1", visibility: "private" };
  await setObjectAclPolicy(obj, policy);

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof PutObjectTaggingCommand);
  const input = (sent[0] as PutObjectTaggingCommand).input;
  assert.equal(input.Bucket, "test-bucket");
  assert.equal(input.Key, "uploads/abc");
  const tag = input.Tagging?.TagSet?.[0];
  assert.equal(tag?.Key, "acl-policy");
  assert.deepEqual(JSON.parse(tag?.Value ?? ""), policy);
});

test("getObjectAclPolicy parses the stored tag", async () => {
  mockSend((cmd) => {
    assert.ok(cmd instanceof GetObjectTaggingCommand);
    return taggingResponse(JSON.stringify({ owner: "u9", visibility: "public" }));
  });
  const policy = await getObjectAclPolicy(obj);
  assert.deepEqual(policy, { owner: "u9", visibility: "public" });
});

test("getObjectAclPolicy returns null when no acl tag exists", async () => {
  mockSend(() => taggingResponse(null));
  assert.equal(await getObjectAclPolicy(obj), null);
});

test("getObjectAclPolicy returns null when S3 errors (e.g. object missing)", async () => {
  mockSend(() => {
    throw new Error("NoSuchKey");
  });
  assert.equal(await getObjectAclPolicy(obj), null);
});

test("canAccessObject denies when no policy exists (fail closed)", async () => {
  mockSend(() => taggingResponse(null));
  const allowed = await canAccessObject({
    userId: "user-1",
    objectFile: obj,
    requestedPermission: ObjectPermission.READ,
  });
  assert.equal(allowed, false);
});

test("public object allows anonymous READ", async () => {
  mockSend(() =>
    taggingResponse(JSON.stringify({ owner: "u1", visibility: "public" })),
  );
  const allowed = await canAccessObject({
    userId: undefined,
    objectFile: obj,
    requestedPermission: ObjectPermission.READ,
  });
  assert.equal(allowed, true);
});

test("public object does NOT allow anonymous WRITE", async () => {
  mockSend(() =>
    taggingResponse(JSON.stringify({ owner: "u1", visibility: "public" })),
  );
  const allowed = await canAccessObject({
    userId: undefined,
    objectFile: obj,
    requestedPermission: ObjectPermission.WRITE,
  });
  assert.equal(allowed, false);
});

test("private object denies anonymous READ", async () => {
  mockSend(() =>
    taggingResponse(JSON.stringify({ owner: "u1", visibility: "private" })),
  );
  const allowed = await canAccessObject({
    userId: undefined,
    objectFile: obj,
    requestedPermission: ObjectPermission.READ,
  });
  assert.equal(allowed, false);
});

test("private object allows the owner (READ and WRITE)", async () => {
  mockSend(() =>
    taggingResponse(JSON.stringify({ owner: "owner-7", visibility: "private" })),
  );
  for (const perm of [ObjectPermission.READ, ObjectPermission.WRITE]) {
    const allowed = await canAccessObject({
      userId: "owner-7",
      objectFile: obj,
      requestedPermission: perm,
    });
    assert.equal(allowed, true, `owner should have ${perm}`);
  }
});

test("private object denies a non-owner user", async () => {
  mockSend(() =>
    taggingResponse(JSON.stringify({ owner: "owner-7", visibility: "private" })),
  );
  const allowed = await canAccessObject({
    userId: "intruder-1",
    objectFile: obj,
    requestedPermission: ObjectPermission.READ,
  });
  assert.equal(allowed, false);
});

test("public object WRITE still requires ownership", async () => {
  mockSend(() =>
    taggingResponse(JSON.stringify({ owner: "owner-7", visibility: "public" })),
  );
  const asStranger = await canAccessObject({
    userId: "someone-else",
    objectFile: obj,
    requestedPermission: ObjectPermission.WRITE,
  });
  assert.equal(asStranger, false);
  const asOwner = await canAccessObject({
    userId: "owner-7",
    objectFile: obj,
    requestedPermission: ObjectPermission.WRITE,
  });
  assert.equal(asOwner, true);
});

test("stray legacy aclRules key in the stored tag is ignored", async () => {
  mockSend(() =>
    taggingResponse(
      JSON.stringify({
        owner: "owner-7",
        visibility: "private",
        aclRules: [{ group: "x", permission: "read" }],
      }),
    ),
  );
  const allowed = await canAccessObject({
    userId: "member-of-x",
    objectFile: obj,
    requestedPermission: ObjectPermission.READ,
  });
  assert.equal(allowed, false, "legacy group rules must not grant access");
});
