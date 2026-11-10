import test from "node:test";
import assert from "node:assert/strict";
import { transcribeMeetingParts } from "./meeting-notes-transcription";

test("long-recording batches preserve source order and never exceed four provider calls", async () => {
  let active = 0;
  let maximum = 0;
  let checkpoints = 0;
  const parts = Array.from({ length: 144 }, (_, index) => String(index));
  const text = await transcribeMeetingParts(
    parts,
    async (part) => Buffer.from(part),
    async (bytes) => {
      active++;
      maximum = Math.max(maximum, active);
      const index = Number(bytes.toString());
      // Reverse completion within each batch, not source order.
      await new Promise((resolve) => setTimeout(resolve, 4 - (index % 4)));
      active--;
      return `  source part ${index}  `;
    },
    async () => {
      checkpoints++;
    },
  );
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    text.split("\n\n"),
    parts.map((part) => `source part ${part}`),
  );
  assert.ok(checkpoints >= 144 * 2);
});

test("failure waits for the active batch and never starts later parts or returns partial text", async () => {
  let completed = 0;
  const started: number[] = [];
  await assert.rejects(
    transcribeMeetingParts(
      ["0", "1", "2", "3", "4"],
      async (part) => Buffer.from(part),
      async (bytes) => {
        const index = Number(bytes.toString());
        started.push(index);
        if (index === 0) throw new Error("synthetic provider failure");
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed++;
        return `part ${index}`;
      },
      async () => {},
    ),
    /synthetic provider failure/,
  );
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(completed, 3);
});

test("authority loss after provider completion fences the result and subsequent batches", async () => {
  let authorized = true;
  let calls = 0;
  await assert.rejects(
    transcribeMeetingParts(
      ["0", "1", "2", "3", "4"],
      async (part) => Buffer.from(part),
      async () => {
        calls++;
        authorized = false;
        return "Do not persist this late result.";
      },
      async () => {
        if (!authorized) throw new Error("scope revoked");
      },
    ),
    /scope revoked/,
  );
  assert.equal(calls, 4);
});

test("empty recordings or missing chunk transcripts fail explicitly", async () => {
  await assert.rejects(
    transcribeMeetingParts(
      [],
      async () => Buffer.alloc(0),
      async () => "unused",
      async () => {},
    ),
    /No recording audio parts/,
  );
  await assert.rejects(
    transcribeMeetingParts(
      ["0"],
      async () => Buffer.from("audio"),
      async () => " ",
      async () => {},
    ),
    /could not be transcribed completely/,
  );
});
