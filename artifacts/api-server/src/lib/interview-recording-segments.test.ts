import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  groupRecordingSegments,
  uploadRecordingSegment,
  downloadRecordingSegment,
  recordingSegmentUpload,
} from "./interview-recording-segments";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { ObjectStorageService, s3Client } from "./objectStorage";

// Exercise the actual frontend implementation without pulling the frontend
// into the API compiler's root. Its owning project still typechecks the source.
const recordingModule: unknown = await import(
  new URL("../../../lexy/src/lib/interview-recording-segments.ts", import.meta.url).href
);
const { recordingSegmentForm } = z
  .object({
    recordingSegmentForm: z.custom<
      (blob: Blob, attemptId: string, index: number, recorderMimeType: string) => FormData
    >((value) => typeof value === "function"),
  })
  .parse(recordingModule);

const first = "11111111-1111-4111-8111-111111111111";
const resumed = "22222222-2222-4222-8222-222222222222";
const item = (id: string, index: number, modified: string) => ({
  key: `private/recording-segments/session/${id}/part_${String(index).padStart(4, "0")}.webm`,
  size: 42,
  modified,
});
test("separate resume attempts are ordered without combining container headers", () => {
  const groups = groupRecordingSegments([
    item(resumed, 0, "2026-01-02"),
    item(first, 1, "2026-01-01"),
    item(first, 0, "2026-01-01"),
  ]);
  assert.deepEqual(
    groups.map((g) => g.attemptId),
    [first, resumed],
  );
  assert.equal(groups[0].partCount, 2);
  assert.equal(groups[0].bytes, 84);
  assert.equal(groups[0].contiguous, true);
});
test("missing initial or middle chunks are not presented as complete recordings", () => {
  assert.equal(groupRecordingSegments([item(first, 1, "a")])[0].contiguous, false);
  assert.equal(
    groupRecordingSegments([item(first, 0, "a"), item(first, 2, "b")])[0].contiguous,
    false,
  );
  assert.deepEqual(groupRecordingSegments([{ key: "../foreign", size: 1, modified: "" }]), []);
});
test("write gates precede upload; playback inherits existing session read authorization", () => {
  const routes = readFileSync(new URL("../routes/interviews.ts", import.meta.url), "utf8");
  assert.match(
    routes,
    /"\/interviews\/:interviewId\/recording-segments",\s*requireSameOriginPost,\s*requireInterviewSessionCookie,\s*requireActiveAiConsent,\s*recordingSegmentUpload/,
  );
  assert.match(routes, /recording-segments", gateInterviewRead, listRecordingSegments/);
  assert.match(
    routes,
    /recording-segments\/:attemptId", gateInterviewRead, downloadRecordingSegment/,
  );
  assert.match(routes, /GREETING_ONLY/);
});
test("erasure sweeps all per-session checkpoint prefixes, including abandoned attempts", () => {
  const deletion = readFileSync(new URL("../routes/admin-deletion.ts", import.meta.url), "utf8");
  const cleanup = readFileSync(new URL("./erasure-cleanup.ts", import.meta.url), "utf8");
  assert.match(deletion, /SELECT id, recording_url FROM interview_sessions WHERE candidate_id/);
  assert.ok(deletion.includes("push(`/objects/recording-segments/${r.id}/`)"));
  assert.match(deletion, /stageErasureCleanup/);
  assert.match(
    cleanup,
    /item\.kind === "prefix"[\s\S]*?storage\.deleteObjectsUnderPrefix\(item\.path\.slice\("\/objects\/"\.length\)\)/,
  );
  assert.ok(cleanup.includes("Boolean(response.error)"));
});

function response() {
  return {
    statusCode: 200,
    data: null as any,
    headers: {} as Record<string, unknown>,
    headersSent: false,
    destroyed: false,
    chunks: [] as Uint8Array[],
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.data = data;
      return this;
    },
    setHeader(key: string, value: unknown) {
      this.headers[key] = value;
      return this;
    },
    write(bytes: Uint8Array) {
      this.headersSent = true;
      this.chunks.push(bytes);
      return true;
    },
    end() {},
    destroy() {
      this.destroyed = true;
    },
  };
}
const sessionId = "33333333-3333-4333-8333-333333333333";
const fakeRequest = () => ({
  params: { interviewId: sessionId, attemptId: first },
  body: { attemptId: first, index: "0" },
  file: { size: 5, buffer: Buffer.from("audio"), mimetype: "video/webm" },
  log: { error() {} },
});

test("real multipart parser accepts normalized recorder chunks without altering bytes", async () => {
  const original = s3Client.send;
  const stored: Array<{ type: string; bytes: Buffer; key: string }> = [];
  (s3Client as any).send = async (command: any) => {
    assert.equal(command instanceof PutObjectCommand, true);
    stored.push({
      type: command.input.ContentType,
      bytes: command.input.Body,
      key: command.input.Key,
    });
    return {};
  };
  const parsedTypes: string[] = [];
  const app = express();
  app.post("/:interviewId", recordingSegmentUpload.single("file"), (req, res) => {
    parsedTypes.push(req.file?.mimetype ?? "");
    void uploadRecordingSegment(req, res);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${sessionId}`;
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3]);
  try {
    // The actual browser label is malformed as a multipart Content-Type:
    // the codecs parameter's comma needs quoting. Busboy falls back to text/plain.
    const raw = new FormData();
    raw.append(
      "file",
      new Blob([bytes], { type: "video/webm;codecs=vp9,opus" }),
      "checkpoint.webm",
    );
    raw.append("attemptId", first);
    raw.append("index", "0");
    const rejected = await fetch(url, { method: "POST", body: raw });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "Unsupported recording segment type" });
    assert.equal(parsedTypes[0], "text/plain");
    assert.equal(stored.length, 0);

    for (const [i, mime] of [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "audio/webm;codecs=opus",
      "video/mp4;codecs=avc1.424028,mp4a.40.2",
      "audio/mp4",
    ].entries()) {
      const form = recordingSegmentForm(new Blob([bytes], { type: mime }), first, i, mime);
      const file = form.get("file") as File;
      const type = mime.split(";")[0];
      assert.equal(file.type, type);
      assert.equal(file.name, `checkpoint.${type.endsWith("mp4") ? "mp4" : "webm"}`);
      const uploaded = await fetch(url, { method: "POST", body: form });
      assert.equal(uploaded.status, 200);
      assert.deepEqual(await uploaded.json(), { saved: true, attemptId: first, index: i });
      assert.equal(stored[i].type, type);
      assert.deepEqual(stored[i].bytes, bytes);
    }
    // A missing timeslice type uses the known recorder container, not a guess.
    const untyped = recordingSegmentForm(
      new Blob([bytes]),
      resumed,
      0,
      "video/webm;codecs=vp9,opus",
    );
    const resumedUpload = await fetch(url, { method: "POST", body: untyped });
    assert.equal(resumedUpload.status, 200);
    await resumedUpload.json();
    assert.equal(stored.at(-1)?.key.endsWith(`/${resumed}/part_0000.webm`), true);
    assert.deepEqual(stored.at(-1)?.bytes, bytes);
    assert.throws(
      () => recordingSegmentForm(new Blob([bytes]), first, 0, "text/plain"),
      /Unsupported recording container/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    s3Client.send = original;
  }
});

test("immutable checkpoint writes and identical retries are acknowledged; changed bytes cannot overwrite", async () => {
  const original = s3Client.send;
  let storedHash = "",
    puts = 0;
  (s3Client as any).send = async (command: any) => {
    if (command instanceof PutObjectCommand) {
      puts++;
      assert.equal(
        command.input.Key?.endsWith(`/recording-segments/${sessionId}/${first}/part_0000.webm`),
        true,
      );
      assert.equal(command.input.IfNoneMatch, "*");
      assert.equal(command.input.ServerSideEncryption, "AES256");
      if (storedHash) throw { $metadata: { httpStatusCode: 412 } };
      assert.ok(command.input.Metadata, "checkpoint uploads must include digest metadata");
      storedHash = command.input.Metadata.sha256;
      return {};
    }
    assert.equal(command instanceof HeadObjectCommand, true);
    return { Metadata: { sha256: storedHash } };
  };
  try {
    const req = fakeRequest(),
      initial = response(),
      retry = response(),
      changed = response();
    await uploadRecordingSegment(req as any, initial as any);
    await uploadRecordingSegment(req as any, retry as any);
    assert.equal(initial.data.saved, true);
    assert.equal(retry.data.saved, true);
    assert.equal(storedHash, createHash("sha256").update("audio").digest("hex"));
    req.file.buffer = Buffer.from("other");
    await uploadRecordingSegment(req as any, changed as any);
    assert.equal(changed.statusCode, 409);
    assert.equal(puts, 3);
  } finally {
    s3Client.send = original;
  }
});

test("playback streams only the selected attempt in byte order, not resumed container headers", async () => {
  const original = s3Client.send;
  const root = `${new ObjectStorageService().getPrivatePrefix()}/recording-segments/${sessionId}/`;
  const fetched: string[] = [];
  (s3Client as any).send = async (command: any) => {
    if (command instanceof ListObjectsV2Command)
      return {
        Contents: [
          { Key: `${root}${first}/part_0001.webm`, Size: 3, LastModified: new Date("2026-01-01") },
          {
            Key: `${root}${resumed}/part_0000.webm`,
            Size: 7,
            LastModified: new Date("2026-01-02"),
          },
          { Key: `${root}${first}/part_0000.webm`, Size: 3, LastModified: new Date("2026-01-01") },
        ],
      };
    assert.equal(command instanceof GetObjectCommand, true);
    const suffix = command.input.Key.slice(root.length);
    fetched.push(suffix);
    return {
      ContentType: "video/webm",
      Body: (async function* () {
        yield Buffer.from(suffix.includes("0000") ? "one" : "two");
      })(),
    };
  };
  try {
    const res = response();
    await downloadRecordingSegment(fakeRequest() as any, res as any);
    assert.deepEqual(fetched, [`${first}/part_0000.webm`, `${first}/part_0001.webm`]);
    assert.equal(Buffer.concat(res.chunks).toString(), "onetwo");
    assert.equal(res.headers["Content-Length"], 6);
  } finally {
    s3Client.send = original;
  }
});
