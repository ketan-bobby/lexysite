import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const calls: Record<string, unknown>[] = [];
let fail = false;
let lastBody: Readable | undefined;
mock.module("./s3.ts", {
  namedExports: {
    s3Client: {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command.input);
        const body = command.input.Body;
        if (body instanceof Readable) {
          lastBody = body;
          if (fail) throw new Error("synthetic storage failure");
          const parts: Buffer[] = [];
          for await (const part of body) parts.push(Buffer.from(part));
          assert.equal(Buffer.concat(parts).toString(), "private synthetic source");
        }
        return {};
      },
    },
  },
});
const { ObjectStorageService } = await import("./objectStorage");

test("file uploads stream with private tags, encryption and length; failures close streams", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lexy-storage-fixture-"));
  const path = join(directory, "source");
  try {
    const bytes = Buffer.from("private synthetic source");
    await writeFile(path, bytes, { mode: 0o600 });
    const storage = new ObjectStorageService();
    (storage as unknown as { getBucket: () => string }).getBucket = () =>
      "synthetic-fixture-bucket";
    const result = await storage.uploadFile(path, bytes.length, "audio/wav", "fixture", {
      owner: "meeting-notes-service",
      visibility: "private",
    });
    assert.match(result, /^\/objects\/fixture\/[a-f0-9-]+$/);
    assert.equal(calls[0]!.ContentLength, bytes.length);
    assert.equal(calls[0]!.ServerSideEncryption, "AES256");
    assert.match(String(calls[0]!.Tagging), /acl-policy=/);
    assert.equal(lastBody?.destroyed, true);
    fail = true;
    await assert.rejects(storage.uploadFile(path, bytes.length, "audio/wav"), /synthetic/);
    assert.equal(lastBody?.destroyed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
