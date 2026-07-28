/**
 * objectStorage.test.ts — unit tests for the S3 object storage service.
 *
 * s3Client.send is mocked (no real AWS calls); presigned-URL generation is
 * pure local crypto thanks to dummy static credentials set before import.
 * Run: npx tsx --test src/lib/objectStorage.test.ts
 */
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "AKIAUNITTESTDUMMY000";
process.env.AWS_SECRET_ACCESS_KEY = "unit-test-dummy-secret-not-real";
process.env.AWS_S3_BUCKET = "unit-test-bucket";
process.env.AWS_S3_PRIVATE_PREFIX = "priv";
process.env.AWS_S3_PUBLIC_PREFIX = "pub1, pub2/";

const { s3Client } = await import("./s3");
const { ObjectStorageService, ObjectNotFoundError } = await import("./objectStorage");

const svc = new ObjectStorageService();
let sent: any[] = [];

function mockSend(handler: (cmd: any) => unknown) {
  return mock.method(s3Client, "send", async (cmd: any) => {
    sent.push(cmd);
    return handler(cmd);
  });
}

function notFound(): never {
  const err: any = new Error("NotFound");
  err.name = "NotFound";
  err.$metadata = { httpStatusCode: 404 };
  throw err;
}

beforeEach(() => {
  mock.restoreAll();
  sent = [];
});

test("env helpers: bucket, private prefix, public prefixes (trimmed, de-slashed)", () => {
  assert.equal(svc.getBucket(), "unit-test-bucket");
  assert.equal(svc.getPrivatePrefix(), "priv");
  assert.deepEqual(svc.getPublicPrefixes(), ["pub1", "pub2"]);
});

test("getObjectEntityFile resolves /objects/ path to bucket+key", async () => {
  mockSend(() => ({ ContentType: "application/pdf" }));
  const ref = await svc.getObjectEntityFile("/objects/uploads/abc-123");
  assert.deepEqual(ref, {
    bucket: "unit-test-bucket",
    key: "priv/uploads/abc-123",
    contentType: "application/pdf",
  });
  assert.ok(sent[0] instanceof HeadObjectCommand);
});

test("getObjectEntityFile rejects non-/objects/ paths without touching S3", async () => {
  mockSend(() => ({}));
  await assert.rejects(svc.getObjectEntityFile("uploads/abc"), ObjectNotFoundError);
  await assert.rejects(svc.getObjectEntityFile("/objects/"), ObjectNotFoundError);
  assert.equal(sent.length, 0);
});

test("getObjectEntityFile maps S3 404 to ObjectNotFoundError", async () => {
  mockSend(() => notFound());
  await assert.rejects(svc.getObjectEntityFile("/objects/uploads/missing"), ObjectNotFoundError);
});

test("searchPublicObject walks prefixes and returns the first hit", async () => {
  mockSend((cmd) => {
    if (cmd.input.Key === "pub1/logo.png") notFound();
    return { ContentType: "image/png" };
  });
  const ref = await svc.searchPublicObject("logo.png");
  assert.deepEqual(ref, {
    bucket: "unit-test-bucket",
    key: "pub2/logo.png",
    contentType: "image/png",
  });
});

test("searchPublicObject returns null when nothing matches", async () => {
  mockSend(() => notFound());
  assert.equal(await svc.searchPublicObject("nope.png"), null);
});

test("downloadObject streams body with private cache headers by default", async () => {
  mockSend((cmd) => {
    if (cmd instanceof GetObjectCommand) {
      return {
        ContentType: "text/plain",
        ContentLength: 5,
        Body: Readable.from([Buffer.from("hello")]),
      };
    }
    // ACL tag lookup — no policy stored
    return { TagSet: [] };
  });
  const res = await svc.downloadObject({ bucket: "unit-test-bucket", key: "priv/uploads/x" });
  assert.equal(res.headers.get("Content-Type"), "text/plain");
  assert.equal(res.headers.get("Content-Length"), "5");
  assert.equal(res.headers.get("Cache-Control"), "private, max-age=3600");
  assert.equal(await res.text(), "hello");
});

test("downloadObject uses public cache headers for public-tagged objects", async () => {
  mockSend((cmd) => {
    if (cmd instanceof GetObjectCommand) {
      return { ContentType: "image/png", Body: Readable.from([Buffer.from("img")]) };
    }
    return {
      TagSet: [{ Key: "acl-policy", Value: JSON.stringify({ owner: "u", visibility: "public" }) }],
    };
  });
  const res = await svc.downloadObject({ bucket: "b", key: "k" }, 60);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
});

test("getRecordingUploadURL returns a presigned PUT URL + sanitised object path", async () => {
  const { uploadUrl, objectPath } = await svc.getRecordingUploadURL("cand-1", "my file (1).webm");
  assert.ok(uploadUrl.startsWith("https://"));
  assert.ok(uploadUrl.includes("X-Amz-Signature="));
  assert.ok(uploadUrl.includes("X-Amz-Expires=1800"));
  assert.ok(objectPath.startsWith("/objects/priv/interview-recordings/cand-1/"));
  assert.ok(objectPath.endsWith("-my_file__1_.webm"), `sanitised: ${objectPath}`);
  assert.equal(sent.length, 0, "presigning must not call S3");
});

test("getObjectEntityUploadURL presigns under priv/uploads/ with 15 min TTL", async () => {
  const url = await svc.getObjectEntityUploadURL();
  assert.ok(url.includes("/priv/uploads/"));
  assert.ok(url.includes("X-Amz-Expires=900"));
});

test("uploadBuffer puts with SSE + content type and returns canonical path", async () => {
  mockSend(() => ({}));
  const path = await svc.uploadBuffer(Buffer.from("data"), "application/pdf", "resumes");
  assert.match(path, /^\/objects\/resumes\/[0-9a-f-]{36}$/);
  const cmd = sent[0];
  assert.ok(cmd instanceof PutObjectCommand);
  assert.equal(cmd.input.ServerSideEncryption, "AES256");
  assert.equal(cmd.input.ContentType, "application/pdf");
  assert.ok(cmd.input.Key.startsWith("priv/resumes/"));
});

test("normalizeObjectEntityPath handles canonical, virtual-host and path-style URLs", () => {
  assert.equal(svc.normalizeObjectEntityPath("/objects/uploads/a"), "/objects/uploads/a");
  assert.equal(
    svc.normalizeObjectEntityPath("https://unit-test-bucket.s3.us-east-1.amazonaws.com/priv/uploads/a?X-Amz-Signature=zz"),
    "/objects/uploads/a",
  );
  assert.equal(
    svc.normalizeObjectEntityPath("https://s3.amazonaws.com/unit-test-bucket/priv/uploads/a"),
    "/objects/uploads/a",
  );
  // Unrecognised strings pass through untouched.
  assert.equal(svc.normalizeObjectEntityPath("random-string"), "random-string");
});

test("deleteObjectByPath deletes the mapped key; rejects non-object paths", async () => {
  mockSend(() => ({}));
  const r = await svc.deleteObjectByPath("/objects/uploads/dead");
  assert.deepEqual(r, { ok: true });
  const cmd = sent[0];
  assert.ok(cmd instanceof DeleteObjectCommand);
  assert.equal(cmd.input.Key, "priv/uploads/dead");

  const bad = await svc.deleteObjectByPath("uploads/dead");
  assert.equal(bad.ok, false);
});

test("deleteObjectByPath surfaces S3 errors as {ok:false} without throwing", async () => {
  mockSend(() => {
    throw new Error("AccessDenied");
  });
  const r = await svc.deleteObjectByPath("/objects/uploads/x");
  assert.deepEqual(r, { ok: false, error: "AccessDenied" });
});

test("deleteObjectsUnderPrefix pages through listings and counts deletions", async () => {
  let listCall = 0;
  mockSend((cmd) => {
    if (cmd instanceof ListObjectsV2Command) {
      listCall += 1;
      assert.equal(cmd.input.Prefix, "priv/interview-recordings/cand-1/");
      if (listCall === 1) {
        return {
          Contents: [{ Key: "priv/x/1" }, { Key: "priv/x/2" }],
          IsTruncated: true,
          NextContinuationToken: "tok",
        };
      }
      return { Contents: [{ Key: "priv/x/3" }], IsTruncated: false };
    }
    assert.ok(cmd instanceof DeleteObjectsCommand);
    return {};
  });
  const r = await svc.deleteObjectsUnderPrefix("/interview-recordings/cand-1/");
  assert.deepEqual(r, { deleted: 3 });
  assert.equal(listCall, 2);
});

test("deleteObjectsUnderPrefix returns partial count + error on failure", async () => {
  mockSend((cmd) => {
    if (cmd instanceof ListObjectsV2Command) {
      return { Contents: [{ Key: "priv/x/1" }], IsTruncated: false };
    }
    throw new Error("boom");
  });
  const r = await svc.deleteObjectsUnderPrefix("x");
  assert.equal(r.deleted, 0);
  assert.equal(r.error, "boom");
});

test("canAccessObjectEntity defaults to READ permission and delegates to the ACL layer", async () => {
  mockSend(() => ({
    TagSet: [{ Key: "acl-policy", Value: JSON.stringify({ owner: "u1", visibility: "private" }) }],
  }));
  const objectFile = { bucket: "b", key: "k" };
  assert.equal(await svc.canAccessObjectEntity({ userId: "u1", objectFile }), true);
  assert.equal(await svc.canAccessObjectEntity({ userId: "u2", objectFile }), false);
});
