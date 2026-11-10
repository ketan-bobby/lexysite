import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { InterviewAnswerCapture } from "./interview-answer-capture";
import { InterviewRecordingSegments } from "./interview-recording-segments";

class FakeStream {
  constructor(public tracks: object[]) {}
  getAudioTracks() {
    return this.tracks.filter((track: any) => track.kind === "audio");
  }
}
class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: any) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: FakeStream) {
    super();
    Recorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["final-tail"]) });
      this.onstop?.();
    });
  }
}

test("continuous answer capture is audio-only, includes final tail, and finalizes once", async () => {
  const oldRecorder = globalThis.MediaRecorder,
    oldStream = globalThis.MediaStream;
  Object.assign(globalThis, { MediaRecorder: Recorder, MediaStream: FakeStream });
  try {
    const mic = { kind: "audio" },
      cam = { kind: "video" };
    const capture = new InterviewAnswerCapture(new FakeStream([mic, cam]) as any, "audio/webm");
    const rec = Recorder.instances.at(-1)!;
    assert.deepEqual(rec.stream.tracks, [mic]);
    rec.ondataavailable?.({ data: new Blob(["first-"]) });
    const result = capture.finish();
    assert.equal(capture.finish(), result);
    assert.equal(await (await result).text(), "first-final-tail");
  } finally {
    Object.assign(globalThis, { MediaRecorder: oldRecorder, MediaStream: oldStream });
  }
});

test("capture errors never validate a partial answer", async () => {
  const oldRecorder = globalThis.MediaRecorder,
    oldStream = globalThis.MediaStream;
  Object.assign(globalThis, { MediaRecorder: Recorder, MediaStream: FakeStream });
  try {
    const capture = new InterviewAnswerCapture(new FakeStream([{ kind: "audio" }]) as any, "");
    Recorder.instances.at(-1)!.onerror?.();
    await assert.rejects(capture.finish(), /capture failed/);
  } finally {
    Object.assign(globalThis, { MediaRecorder: oldRecorder, MediaStream: oldStream });
  }
});

test("checkpoints are serialized and resume creates a separate attempt without overwriting", async () => {
  const calls: Array<{ id: string; index: number; text: string }> = [];
  const upload = async (blob: Blob, id: string, index: number) => {
    calls.push({ id, index, text: await blob.text() });
  };
  const first = new InterviewRecordingSegments(upload, () =>
    assert.fail("unexpected upload failure"),
  );
  first.enqueue(new Blob(["header"]));
  first.enqueue(new Blob(["body"]));
  await first.flush({ state: "inactive" } as MediaRecorder);
  const resumed = new InterviewRecordingSegments(upload, () =>
    assert.fail("unexpected upload failure"),
  );
  resumed.enqueue(new Blob(["new-header"]));
  await resumed.flush({ state: "inactive" } as MediaRecorder);
  assert.notEqual(first.attemptId, resumed.attemptId);
  assert.deepEqual(
    calls.map((call) => [call.id, call.index]),
    [
      [first.attemptId, 0],
      [first.attemptId, 1],
      [resumed.attemptId, 0],
    ],
  );
  first.enqueue(new Blob(["after-close"]));
  assert.equal(calls.length, 3);
});

test("checkpoint flush includes requestData before closing upload admission", async () => {
  const calls: string[] = [];
  const uploads = new InterviewRecordingSegments(
    async (blob) => {
      calls.push(await blob.text());
    },
    () => assert.fail(),
  );
  const rec = new EventTarget() as EventTarget & { state: string; requestData(): void };
  rec.state = "recording";
  rec.requestData = () =>
    queueMicrotask(() => {
      uploads.enqueue(new Blob(["last"]));
      rec.dispatchEvent(new Event("dataavailable"));
    });
  await uploads.flush(rec as any);
  assert.deepEqual(calls, ["last"]);
});

test("oversized background chunks retain byte order within the upload size limit", async () => {
  const sizes: number[] = [],
    indexes: number[] = [];
  const uploads = new InterviewRecordingSegments(
    async (blob, _id, index) => {
      sizes.push(blob.size);
      indexes.push(index);
      assert.equal(blob.type, "video/webm");
    },
    () => assert.fail(),
  );
  uploads.enqueue(new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "video/webm" }));
  await uploads.flush({ state: "inactive" } as MediaRecorder);
  assert.deepEqual(indexes, [0, 1]);
  assert.deepEqual(sizes, [5 * 1024 * 1024, 1024 * 1024]);
});

test("stalled checkpoints have a bounded flush and cannot admit more chunks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: number[] = [];
  const uploads = new InterviewRecordingSegments(
    async (_blob, _id, index) => {
      calls.push(index);
      await new Promise<void>(() => {});
    },
    () => assert.fail(),
  );
  uploads.enqueue(new Blob(["pending"]));
  const result = uploads.flush({ state: "inactive" } as MediaRecorder);
  const rejected = assert.rejects(result, /uploads timed out/);
  uploads.enqueue(new Blob(["must-not-be-admitted"]));
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await rejected;
  assert.deepEqual(calls, [0]);
});

test("room validates continuous audio before persisting; failures require typed review", () => {
  const room = readFileSync(
    new URL("../pages/recruiter/interviews/room.tsx", import.meta.url),
    "utf8",
  );
  assert.match(room, /capture\.finish\(\)/);
  assert.match(room, /transcribeSegment\(sessionId, complete\.blob, lang\)/);
  assert.match(room, /couldn't validate the spoken answer/);
  assert.match(room, /isInterviewGreetingOnly\(answer\)/);
  assert.match(room, /recordingSegmentsRef\.current\.flush\(recorderRef\.current\)/);
  assert.match(room, /rec\.start\(15000\)/);
});
