import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { request } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { meetingUploadHeader, receiveMeetingUpload, removeMeetingUpload } from "./meeting-upload";
import { MAX_MEETING_BYTES } from "./meeting-notes-core";

const boundary = "lexy-fixture-boundary";
const prefix = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../private.webm"\r\nContent-Type: video/webm\r\n\r\n`,
);
const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
const chunk = Buffer.alloc(64 * 1024, 17);

async function folders() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("lexy-meeting-upload-"));
}

test(
  "disk uploads handle concurrency, exact limit, overflow, downstream failure and abort",
  {
    timeout: 60_000,
  },
  async () => {
    const before = new Set(await folders());
    let accepted = 0;
    let active = 0;
    let peak = 0;
    const app = express();
    app.post("/", async (req, res) => {
      try {
        await receiveMeetingUpload(req, res);
        assert.ok(req.file);
        assert.equal(req.file.buffer, undefined, "whole recordings must not be buffered");
        assert.equal((await stat(req.file.path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(req.file.destination))).mode & 0o777, 0o700);
        assert.equal((await meetingUploadHeader(req.file.path)).length, 64);
        assert.equal(req.file.filename, "recording", "caller filename is never a disk path");
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active--;
        if (req.query.fail) throw new Error("synthetic persistence failure");
        accepted++;
        res.status(201).json({ size: req.file.size });
      } catch (error) {
        if (!req.aborted)
          res.status((error as { code?: string }).code === "LIMIT_FILE_SIZE" ? 413 : 400).end();
      } finally {
        if (req.file?.path) await removeMeetingUpload(req.file.path);
      }
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    async function send(size: number, query = "", abort = false): Promise<number> {
      const req = request({
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: `/${query}`,
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      });
      const response = new Promise<number>((resolve, reject) => {
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", (error) => (abort ? resolve(0) : reject(error)));
      });
      req.write(prefix);
      for (let remaining = size; remaining > 0; remaining -= chunk.length) {
        if (!req.write(chunk.subarray(0, Math.min(remaining, chunk.length))))
          await once(req, "drain");
      }
      if (abort) req.destroy();
      else req.end(suffix);
      return response;
    }
    try {
      assert.deepEqual(
        await Promise.all(Array.from({ length: 4 }, () => send(8 * 1024 * 1024))),
        [201, 201, 201, 201],
      );
      assert.ok(peak > 1 && peak <= 4, "fixture must overlap real HTTP uploads");
      assert.equal(await send(MAX_MEETING_BYTES), 201);
      assert.equal(await send(MAX_MEETING_BYTES + 1), 413);
      assert.equal(await send(1024, "?fail=1"), 400);
      assert.equal(await send(1024 * 1024, "", true), 0);
      assert.equal(accepted, 5, "overflow, failure and aborted sources must not persist");
      // HTTP responses can precede finally cleanup; allow bounded I/O settlement.
      for (let i = 0; i < 100; i++) {
        if ((await folders()).every((name) => before.has(name))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(
        (await folders()).filter((name) => !before.has(name)),
        [],
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
