/** Keep real path/ACL/ownership logic; replace only the SDK's network boundary. */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mock } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";

export async function useMemoryS3() {
  const s3Client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" },
  });
  mock.module(new URL("../lib/s3.ts", import.meta.url), {
    namedExports: { s3Client, S3_DEFAULT_SSE: "AES256" },
  });
  const { ObjectStorageService } = await import("../lib/objectStorage");
  const objects = new Map<string, { body: Buffer; contentType?: string; tags: any[] }>();
  mock.method(ObjectStorageService.prototype, "getBucket", () => "fixture-bucket");
  mock.method(ObjectStorageService.prototype, "getPrivatePrefix", () => "fixture-private");
  mock.method(s3Client, "send", async (command: any) => {
    const input = command.input;
    const name = command.constructor.name;
    if (name === "PutObjectCommand") {
      objects.set(input.Key, {
        body: Buffer.from(input.Body),
        contentType: input.ContentType,
        tags: [],
      });
      return {};
    }
    if (name === "ListObjectsV2Command") {
      return {
        Contents: [...objects.keys()]
          .filter((k) => k.startsWith(input.Prefix))
          .map((Key) => ({ Key })),
      };
    }
    if (name === "DeleteObjectsCommand") {
      for (const item of input.Delete.Objects) objects.delete(item.Key);
      return {};
    }
    if (name === "DeleteObjectCommand") {
      objects.delete(input.Key);
      return {};
    }
    const object = objects.get(input.Key);
    if (!object)
      throw Object.assign(new Error("Fixture object missing"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
    if (name === "HeadObjectCommand")
      return { ContentType: object.contentType, ContentLength: object.body.length };
    if (name === "GetObjectTaggingCommand") return { TagSet: object.tags };
    if (name === "PutObjectTaggingCommand") {
      object.tags = input.Tagging.TagSet;
      return {};
    }
    if (name === "GetObjectCommand")
      return {
        Body: Readable.from([object.body]),
        ContentType: object.contentType,
        ContentLength: object.body.length,
      };
    assert.fail(`Unexpected fixture S3 operation: ${name}`);
  });
  return { storage: new ObjectStorageService(), objects };
}
