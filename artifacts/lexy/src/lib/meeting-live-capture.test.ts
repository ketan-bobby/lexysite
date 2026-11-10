import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createMeetingCaptureSession } from "./meeting-live-capture";

class Track {
  readyState = "live";
  onended: (() => void) | null = null;
  constructor(public kind: "audio" | "video" = "audio") {}
  stop() {
    this.readyState = "ended";
  }
}
class Stream {
  constructor(public tracks: Track[] = [new Track()]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}
class Context {
  static instances: Context[] = [];
  state = "running";
  connections = 0;
  resumed = false;
  output = new Stream();
  constructor(public options?: unknown) {
    Context.instances.push(this);
  }
  async resume() {
    this.resumed = true;
  }
  async close() {
    this.state = "closed";
  }
  createMediaStreamDestination() {
    return { stream: this.output, disconnect: () => {} };
  }
  createMediaStreamSource() {
    return { connect: () => this.connections++, disconnect: () => {} };
  }
}
class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor(public stream: Stream) {
    Recorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }
}

const originals = ["navigator", "MediaStream", "AudioContext", "MediaRecorder"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const sessions: ReturnType<typeof createMeetingCaptureSession>[] = [];
afterEach(() => {
  mock.timers.reset();
  sessions.splice(0).forEach((session) => session.discard());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  Context.instances = [];
  Recorder.instances = [];
});

function setup(display = new Stream([new Track(), new Track("video")])) {
  const microphone = new Stream();
  let micCalls = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => display,
        getUserMedia: async () => {
          micCalls++;
          return microphone;
        },
      },
    },
  });
  Object.assign(globalThis, {
    MediaStream: Stream,
    AudioContext: Context,
    MediaRecorder: Recorder,
  });
  const states: string[] = [];
  const files: File[] = [];
  const errors: string[] = [];
  const session = createMeetingCaptureSession({
    onState: (state) => states.push(state),
    onComplete: (file) => files.push(file),
    onError: (message) => errors.push(message),
  });
  sessions.push(session);
  return { session, display, microphone, states, files, errors, micCalls: () => micCalls };
}

test("mixes only meeting audio and microphone; stop produces local file and releases resources", async () => {
  const fixture = setup();
  await fixture.session.start();
  assert.deepEqual(fixture.states, ["requesting", "recording"]);
  assert.equal(Context.instances[0].connections, 2);
  assert.deepEqual(Context.instances[0].options, { sinkId: { type: "none" } });
  assert.equal(Recorder.instances[0].stream.getTracks().length, 1);
  Recorder.instances[0].ondataavailable?.({ data: new Blob(["synthetic audio"]) });
  assert.equal(fixture.files.length, 0);
  fixture.session.stop();
  await Promise.resolve();
  assert.equal(fixture.files.length, 1);
  assert.match(fixture.files[0].name, /\.webm$/);
  assert.equal(fixture.files[0].size, 15);
  assert.equal(fixture.errors.length, 0);
  assert.ok(
    [...fixture.display.getTracks(), ...fixture.microphone.getTracks()].every(
      (t) => t.readyState === "ended",
    ),
  );
  assert.equal(Context.instances[0].state, "closed");
});

test("missing shared audio fails explicitly before acquiring microphone", async () => {
  const fixture = setup(new Stream([new Track("video")]));
  await fixture.session.start();
  assert.match(fixture.errors[0], /No meeting audio/);
  assert.equal(fixture.micCalls(), 0);
  assert.equal(fixture.files.length, 0);
  assert.equal(fixture.display.getTracks()[0].readyState, "ended");
});

test("Web Audio is resumed during the initiating click, before permission promises settle", async () => {
  const fixture = setup();
  const starting = fixture.session.start();
  assert.equal(Context.instances.length, 1);
  assert.equal(Context.instances[0].resumed, true);
  assert.equal(fixture.micCalls(), 0);
  await starting;
  fixture.session.discard();
  assert.equal(Context.instances[0].state, "closed");
});

test("cancelled sharing releases the audio context without acquiring a microphone", async () => {
  const fixture = setup();
  Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
    value: async () => {
      throw new Error("permission cancelled");
    },
  });
  await fixture.session.start();
  assert.match(fixture.errors[0], /sharing was not started/);
  assert.equal(Context.instances[0].state, "closed");
  assert.equal(fixture.micCalls(), 0);
  assert.equal(fixture.files.length, 0);
});

test("discard after permission prompt resolves stops late streams without starting recording", async () => {
  const fixture = setup();
  const starting = fixture.session.start();
  fixture.session.discard();
  await starting;
  assert.equal(fixture.micCalls(), 0);
  assert.equal(Recorder.instances.length, 0);
  assert.equal(fixture.files.length, 0);
  assert.ok(fixture.display.getTracks().every((t) => t.readyState === "ended"));
});

test("discard during microphone permission releases the late microphone and prestarted context", async () => {
  const fixture = setup();
  let resolveMicrophone!: (stream: Stream) => void;
  let requested!: () => void;
  const microphoneRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: () => {
      requested();
      return new Promise<Stream>((resolve) => {
        resolveMicrophone = resolve;
      });
    },
  });
  const starting = fixture.session.start();
  await microphoneRequested;
  fixture.session.discard();
  resolveMicrophone(fixture.microphone);
  await starting;
  assert.equal(Context.instances[0].state, "closed");
  assert.ok(
    [...fixture.display.getTracks(), ...fixture.microphone.getTracks()].every(
      (t) => t.readyState === "ended",
    ),
  );
  assert.equal(Recorder.instances.length, 0);
  assert.equal(fixture.files.length, 0);
});

test("failed audio activation releases both capture sources without creating a recorder", async () => {
  const fixture = setup();
  class BlockedContext extends Context {
    async resume() {
      throw new Error("activation rejected");
    }
  }
  Object.assign(globalThis, { AudioContext: BlockedContext });
  await fixture.session.start();
  assert.match(fixture.errors[0], /could not activate audio/);
  assert.equal(Context.instances[0].state, "closed");
  assert.ok(
    [...fixture.display.getTracks(), ...fixture.microphone.getTracks()].every(
      (t) => t.readyState === "ended",
    ),
  );
  assert.equal(Recorder.instances.length, 0);
});

test("explicit discard cannot emit or retain a partial recording", async () => {
  const fixture = setup();
  await fixture.session.start();
  Recorder.instances[0].ondataavailable?.({ data: new Blob(["private recording"]) });
  fixture.session.discard();
  await Promise.resolve();
  assert.equal(fixture.files.length, 0);
  assert.equal(fixture.errors.length, 0);
  assert.equal(Context.instances[0].state, "closed");
});

test("ending screen sharing finalizes once; ending microphone fails closed", async () => {
  const fixture = setup();
  await fixture.session.start();
  Recorder.instances[0].ondataavailable?.({ data: new Blob(["audio"]) });
  fixture.display.getTracks()[0].onended?.();
  fixture.session.stop();
  await Promise.resolve();
  assert.equal(fixture.files.length, 1);
  const broken = setup();
  await broken.session.start();
  broken.microphone.getTracks()[0].onended?.();
  await Promise.resolve();
  assert.match(broken.errors[0], /Microphone access ended/);
  assert.equal(broken.files.length, 0);
});

test("empty capture and recorder failure never become successful recordings", async () => {
  const empty = setup();
  await empty.session.start();
  empty.session.stop();
  await Promise.resolve();
  assert.match(empty.errors[0], /No audio data/);
  const failed = setup();
  await failed.session.start();
  Recorder.instances.at(-1)?.onerror?.();
  await Promise.resolve();
  assert.match(failed.errors[0], /Recording failed/);
  assert.equal(failed.files.length, 0);
});

test("size overflow discards the recording without exposing a truncated success", async () => {
  const fixture = setup();
  await fixture.session.start();
  Recorder.instances[0].ondataavailable?.({ data: { size: 100 * 1024 * 1024 + 1 } as Blob });
  await Promise.resolve();
  assert.match(fixture.errors[0], /exceeded 100 MB/);
  assert.equal(fixture.files.length, 0);
  assert.equal(Context.instances[0].state, "closed");
});

test("duration limit stops and finalizes once without a provider or upload", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup();
  await fixture.session.start();
  Recorder.instances[0].ondataavailable?.({ data: new Blob(["bounded audio"]) });
  mock.timers.tick(15 * 60 * 1000);
  await Promise.resolve();
  assert.equal(fixture.files.length, 0, "must not stop at the former 15-minute cap");
  mock.timers.tick(45 * 60 * 1000);
  await Promise.resolve();
  assert.equal(fixture.files.length, 1);
  assert.deepEqual(fixture.states, ["requesting", "recording", "stopping"]);
});
