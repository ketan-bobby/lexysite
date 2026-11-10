export type MeetingCaptureState = "requesting" | "recording" | "stopping";

export interface MeetingCaptureOptions {
  onState: (state: MeetingCaptureState) => void;
  onComplete: (file: File) => void;
  onError: (message: string) => void;
}

import {
  MAX_MEETING_BYTES as MAX_BYTES,
  MAX_MEETING_SECONDS as MAX_SECONDS,
} from "./meeting-recording-limits";

/**
 * Staff-initiated local audio capture only. Never uploads, transcribes or joins
 * a meeting. Mixed audio does not establish speaker identity.
 */
export function createMeetingCaptureSession(options: MeetingCaptureOptions) {
  let disposed = false;
  let started = false;
  let finishing = false;
  let failed = false;
  let display: MediaStream | undefined;
  let microphone: MediaStream | undefined;
  let mixed: MediaStream | undefined;
  let context: AudioContext | undefined;
  let audioNodes: AudioNode[] = [];
  let recorder: MediaRecorder | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let chunks: Blob[] = [];
  let bytes = 0;

  function release() {
    clearTimeout(deadline);
    for (const stream of [display, microphone, mixed]) {
      stream?.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    }
    audioNodes.forEach((node) => node.disconnect());
    audioNodes = [];
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  function fail(message: string) {
    if (disposed || failed) return;
    failed = true;
    chunks = [];
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release();
    options.onError(message);
  }

  function stop() {
    if (disposed || failed || finishing) return;
    if (!recorder || recorder.state === "inactive") {
      discard();
      return;
    }
    finishing = true;
    options.onState("stopping");
    recorder.stop();
  }

  function discard() {
    disposed = true;
    chunks = [];
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release();
  }

  async function start() {
    if (started || disposed) return;
    started = true;
    options.onState("requesting");
    try {
      if (
        !navigator.mediaDevices?.getDisplayMedia ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined" ||
        typeof AudioContext === "undefined"
      ) {
        throw new Error("unsupported");
      }
      // Invoke from the staff click: display sharing requires user activation.
      const displayRequest = navigator.mediaDevices
        .getDisplayMedia({ video: true, audio: true })
        .then(
          (stream) => {
            if (disposed || failed) {
              stream.getTracks().forEach((track) => track.stop());
              return undefined;
            }
            display = stream;
            return stream;
          },
          () => undefined,
        );
      // Unlock Web Audio in the same click, not after permission awaits:
      // Chromium can otherwise report "running" while producing no samples.
      // Capture does not need a speaker device. Chromium's initial graph can
      // stall against an unavailable/default output even while reporting
      // "running". A non-rendering sink clocks recording without playback.
      // Browsers without this dictionary member ignore it.
      const audioOptions: AudioContextOptions & { sinkId: { type: "none" } } = {
        sinkId: { type: "none" },
      };
      context = new AudioContext(audioOptions);
      const audioReady = context.resume().then(
        () => true,
        () => false,
      );
      display = await displayRequest;
      if (disposed) {
        release();
        return;
      }
      if (!display) {
        fail("Meeting sharing was not started. Choose the meeting tab and allow audio sharing.");
        return;
      }
      if (!display.getAudioTracks().some((track) => track.readyState === "live")) {
        fail("No meeting audio was shared. Choose the meeting tab and enable Share tab audio.");
        return;
      }
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (disposed) {
        release();
        return;
      }
      if (
        !microphone.getAudioTracks().some((track) => track.readyState === "live") ||
        !display.getAudioTracks().some((track) => track.readyState === "live")
      ) {
        fail("Meeting audio or microphone became unavailable. Start again and check both sources.");
        return;
      }
      const resumed = await audioReady;
      if (disposed) {
        release();
        return;
      }
      if (!resumed || context.state !== "running") {
        fail(
          "The browser could not activate audio recording. Start again from the recording button.",
        );
        return;
      }
      if (
        !display.getAudioTracks().some((track) => track.readyState === "live") ||
        !microphone.getAudioTracks().some((track) => track.readyState === "live")
      ) {
        fail("An audio source ended before recording started. Please share the meeting again.");
        return;
      }
      const destination = context.createMediaStreamDestination();
      mixed = destination.stream;
      const meetingSource = context.createMediaStreamSource(
        new MediaStream(display.getAudioTracks()),
      );
      const microphoneSource = context.createMediaStreamSource(microphone);
      // Record through the MediaStream destination only. Do not add a speaker
      // output branch: it is unnecessary and can stall Chromium's audio graph.
      audioNodes = [meetingSource, microphoneSource, destination];
      meetingSource.connect(destination);
      microphoneSource.connect(destination);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType) {
        fail(
          "This browser cannot record a supported audio format. Import a meeting recording instead.",
        );
        return;
      }
      recorder = new MediaRecorder(mixed, { mimeType, audioBitsPerSecond: 96000 });
      recorder.ondataavailable = (event) => {
        if (disposed || failed || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) {
          fail("Recording exceeded 100 MB and was discarded. Use a compressed audio recording.");
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () =>
        fail("Recording failed. No recording was uploaded. Please try again.");
      recorder.onstop = () => {
        release();
        if (disposed || failed) return;
        disposed = true;
        if (!bytes || !chunks.length) {
          chunks = [];
          options.onError("No audio data was captured. Check shared-tab audio and the microphone.");
          return;
        }
        const type = recorder?.mimeType || mimeType;
        const extension = type.includes("mp4") ? "mp4" : "webm";
        const file = new File(
          chunks,
          `meeting-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
          {
            type,
          },
        );
        chunks = [];
        options.onComplete(file);
      };
      display.getTracks().forEach((track) => {
        track.onended = stop;
      });
      microphone.getAudioTracks().forEach((track) => {
        track.onended = () =>
          fail(
            "Microphone access ended. The incomplete recording was discarded; please start again.",
          );
      });
      recorder.start(1000);
      options.onState("recording");
      deadline = setTimeout(stop, MAX_SECONDS * 1000);
    } catch {
      fail(
        "Could not start recording. Use a supported desktop browser, allow microphone access, and share the meeting tab with audio. Nothing was uploaded.",
      );
    }
  }

  return { start, stop, discard };
}
