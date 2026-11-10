import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  InterviewRecordingMicrophone,
  waitForInterviewMedia,
} from "./interview-recording-microphone.js";

class Track extends EventTarget {
  readyState = "live";
  enabled = true;
  muted = false;
}
class Context extends EventTarget {
  state = "running";
  sources: { disconnects: number; connections: unknown[] }[] = [];
  createMediaStreamSource() {
    const source = {
      disconnects: 0,
      connections: [] as unknown[],
      connect(destination: unknown) {
        this.connections.push(destination);
      },
      disconnect() {
        this.disconnects++;
      },
    };
    this.sources.push(source);
    return source;
  }
}
const stream = (...tracks: Track[]) => ({ getAudioTracks: () => tracks }) as unknown as MediaStream;
function fixture() {
  const context = new Context();
  const destination = {} as MediaStreamAudioDestinationNode;
  const statuses: string[] = [];
  const mixer = new InterviewRecordingMicrophone(
    context as unknown as AudioContext,
    destination,
    (status) => statuses.push(status),
    (tracks) => ({ getAudioTracks: () => tracks }) as MediaStream,
  );
  return { context, destination, statuses, mixer };
}

test("a microphone arriving after recording starts is connected", () => {
  const { mixer, context, destination, statuses } = fixture();
  assert.equal(mixer.attach(null), false);
  assert.equal(statuses.at(-1), "unavailable");
  assert.equal(mixer.attach(stream(new Track())), true);
  assert.deepEqual(context.sources[0].connections, [destination]);
  assert.equal(statuses.at(-1), "ready");
});

test("repeated attachment does not double microphone volume", () => {
  const { mixer, context } = fixture();
  const media = stream(new Track());
  mixer.attach(media);
  mixer.attach(media);
  assert.equal(context.sources.length, 1);
});

test("retry replaces the previous source and removes old event listeners", () => {
  const { mixer, context, statuses } = fixture();
  const old = new Track();
  mixer.attach(stream(old));
  mixer.attach(stream(new Track()));
  assert.equal(context.sources[0].disconnects, 1);
  const count = statuses.length;
  old.dispatchEvent(new Event("ended"));
  assert.equal(statuses.length, count);
});

test("muted, unmuted and ended tracks update recording status honestly", () => {
  const { mixer, statuses } = fixture();
  const track = new Track();
  mixer.attach(stream(track));
  track.enabled = false;
  mixer.refreshStatus();
  assert.equal(statuses.at(-1), "muted");
  track.enabled = true;
  track.dispatchEvent(new Event("unmute"));
  assert.equal(statuses.at(-1), "ready");
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  assert.equal(statuses.at(-1), "unavailable");
});

test("a suspended recording graph is not reported as ready", () => {
  const { mixer, context, statuses } = fixture();
  context.state = "suspended";
  mixer.attach(stream(new Track()));
  assert.equal(statuses.at(-1), "unavailable");
  context.state = "running";
  context.dispatchEvent(new Event("statechange"));
  assert.equal(statuses.at(-1), "ready");
});

test("closed graph and absent live tracks cannot be attached", () => {
  const { mixer, context } = fixture();
  const ended = new Track();
  ended.readyState = "ended";
  assert.equal(mixer.attach(stream(ended)), false);
  context.state = "closed";
  assert.equal(mixer.attach(stream(new Track())), false);
});

test("dispose disconnects without stopping the shared speech-input stream", () => {
  const { mixer, context, statuses } = fixture();
  const track = new Track();
  mixer.attach(stream(track));
  mixer.dispose();
  assert.equal(context.sources[0].disconnects, 1);
  assert.equal(track.readyState, "live");
  assert.equal(mixer.attach(stream(track)), false);
  const count = statuses.length;
  track.dispatchEvent(new Event("mute"));
  context.dispatchEvent(new Event("statechange"));
  assert.equal(statuses.length, count);
});

test("permission waits time out without cancelling a later usable stream", async () => {
  let resolve!: (value: MediaStream) => void;
  const request = new Promise<MediaStream>((done) => {
    resolve = done;
  });
  assert.equal(await waitForInterviewMedia(request, 5), null);
  const media = stream(new Track());
  resolve(media);
  assert.equal(await request, media);
  assert.equal(await waitForInterviewMedia(Promise.reject(new Error("denied")), 5), null);
});

test("room keeps acquisition consent-gated and awaits readiness before recording", () => {
  const source = readFileSync(
    new URL("../pages/recruiter/interviews/room.tsx", import.meta.url),
    "utf8",
  );
  const acquisition = source.slice(
    source.indexOf("let ownedStream"),
    source.indexOf("/* Guard against losing"),
  );
  assert.match(source, /if \(consentRequired !== false\) return;/);
  assert.match(acquisition, /if \(!active \|\| mediaStoppedRef\.current\)[\s\S]*track\.stop\(\)/);
  assert.match(acquisition, /recordingMicrophoneRef\.current\.attach\(stream\)/);
  const begin = source.slice(
    source.indexOf("const handleBegin"),
    source.indexOf("/* ── End interview"),
  );
  assert.ok(begin.indexOf("/begin") < begin.indexOf("await waitForInterviewMedia"));
  assert.match(
    begin,
    /await waitForInterviewMedia[\s\S]*if \(mediaStoppedRef\.current \|\| !mediaConsentRef\.current\)/,
  );
  assert.ok(
    begin.indexOf("await waitForInterviewMedia") < begin.indexOf("startRecording(screenStream)"),
  );
  assert.match(source, /You can continue by typing your answers/);
  assert.match(source, /recordingMicrophoneRef\.current\?\.refreshStatus\(\)/);
  const retry = source.slice(
    source.indexOf("const retryMicrophone"),
    source.indexOf("/* Guard against losing"),
  );
  assert.match(retry, /generation !== mediaGenerationRef\.current/);
  assert.match(retry, /new MediaStream\(\[\.\.\.videoTracks, \.\.\.audio\.getAudioTracks\(\)\]\)/);
  assert.doesNotMatch(retry, /streamRef\.current\?\.getVideoTracks\(\)\.forEach/);
  assert.match(source, /onClick=\{onUnmute\}>\s*Unmute microphone/);
  assert.equal((source.match(/onUnmute=\{toggleMic\}/g) ?? []).length, 2);
});
