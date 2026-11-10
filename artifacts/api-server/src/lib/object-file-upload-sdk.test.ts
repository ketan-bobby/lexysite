import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// Run real SDK serialization/checksum/signing middleware, but replace its
// transport with an in-process receiver. No environment credentials or AWS I/O.
let received = Buffer.alloc(0);
let headers: Record<string, string> = {};
let fail = false;
let attempts = 0;
const client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "SYNTHETIC_FIXTURE_ACCESS_KEY",
    secretAccessKey: "synthetic-fixture-secret-not-a-real-credential",
  },
  maxAttempts: 1,
  requestHandler: {
    handle: async (request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body: unknown;
    }) => {
      attempts++;
      headers = request.headers;
      assert.equal(request.method, "PUT");
      assert.match(request.path, /fixture/);
      const parts: Buffer[] = [];
      for await (const part of request.body as AsyncIterable<Uint8Array>)
        parts.push(Buffer.from(part));
      received = Buffer.concat(parts);
      return {
        response: {
          statusCode: fail ? 503 : 200,
          headers: { "content-type": "application/xml" },
          body: Readable.from(fail ? ["<Error><Code>ServiceUnavailable</Code></Error>"] : []),
        },
      };
    },
  },
});
mock.module("./s3.ts", { namedExports: { s3Client: client } });
const { ObjectStorageService } = await import("./objectStorage");

test("installed AWS SDK sends streamed files with signed private metadata and exact source bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lexy-sdk-upload-fixture-"));
  const source = Buffer.alloc(128 * 1024, 29);
  const path = join(directory, "source");
  try {
    await writeFile(path, source, { mode: 0o600 });
    const storage = new ObjectStorageService();
    (storage as unknown as { getBucket: () => string }).getBucket = () =>
      "synthetic-fixture-bucket";
    const result = await storage.uploadFile(path, source.length, "audio/wav", "fixture", {
      owner: "meeting-notes-service",
      visibility: "private",
    });
    assert.match(result, /^\/objects\/fixture\//);
    assert.equal(attempts, 1);
    assert.match(headers.authorization!, /^AWS4-HMAC-SHA256 /);
    assert.equal(headers["x-amz-server-side-encryption"], "AES256");
    assert.match(headers["x-amz-tagging"]!, /acl-policy=/);
    // With checksum middleware the source may have AWS chunked framing.
    // Check the unframed source, not only that a stream object reached send().
    if (headers["content-encoding"]?.includes("aws-chunked")) {
      assert.equal(headers["x-amz-decoded-content-length"], String(source.length));
      const decoded: Buffer[] = [];
      let offset = 0;
      while (offset < received.length) {
        const end = received.indexOf("\r\n", offset);
        assert.ok(end >= offset);
        const size = Number.parseInt(received.subarray(offset, end).toString(), 16);
        assert.ok(Number.isFinite(size));
        if (size === 0) break;
        offset = end + 2;
        decoded.push(received.subarray(offset, offset + size));
        offset += size;
        assert.equal(received.subarray(offset, offset + 2).toString(), "\r\n");
        offset += 2;
      }
      assert.deepEqual(Buffer.concat(decoded), source);
    } else {
      assert.equal(headers["content-length"], String(source.length));
      assert.deepEqual(received, source);
    }
    fail = true;
    await assert.rejects(
      storage.uploadFile(path, source.length, "audio/wav", "fixture"),
      /ServiceUnavailable/,
    );
    assert.equal(attempts, 2, "a failed upload must not claim success or be silently replayed");
  } finally {
    client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
