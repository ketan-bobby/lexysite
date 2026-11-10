import { apiBase, apiFetch } from "@/lib/api";

/** Non-English/browser-independent dictation. Records one complete answer,
 * ends after actual speech followed by silence, and cancels stale uploads. */
export function startCareerSpeechRecorder(options: {
  language: string;
  onTranscript: (text: string) => void;
  onStatus: (text: string) => void;
  onError: (message: string) => void;
}) {
  let cancelled = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let recorder: MediaRecorder | undefined;
  let frame = 0;
  const controller = new AbortController();
  const stop = () => {
    cancelled = true;
    controller.abort();
    cancelAnimationFrame(frame);
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  };
  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context = new AudioContext();
      await context.resume();
      if (cancelled) {
        await context.close();
        return;
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          bytes += event.data.size;
        }
        if (bytes > 9 * 1024 * 1024 && !cancelled) {
          stop();
          options.onError("This answer is too long to upload. Please type your answer instead.");
        }
      };
      recorder.onerror = () => {
        if (!cancelled) {
          stop();
          options.onError("Microphone recording failed. You can type your answer instead.");
        }
      };
      recorder.onstop = async () => {
        cancelAnimationFrame(frame);
        stream?.getTracks().forEach((track) => track.stop());
        void context?.close().catch(() => {});
        if (cancelled) return;
        try {
          options.onStatus("Transcribing your answer…");
          const body = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" });
          const response = await apiFetch(`${apiBase}/portal/career-interview/transcribe`, {
            method: "POST",
            headers: { "Content-Type": body.type, "X-Language": options.language },
            body,
            signal: controller.signal,
          });
          if (cancelled) return;
          if (!response.ok)
            throw new Error(
              response.status === 412
                ? "AI interview consent is required. Please review your interview consent before continuing."
                : "Speech recognition is unavailable. Please type your answer or try again.",
            );
          const data = await response.json();
          if (cancelled) return;
          if (!data.transcript?.trim())
            throw new Error("No speech was recognised. Please try again or type your answer.");
          options.onTranscript(data.transcript.trim());
        } catch (error) {
          if (!cancelled)
            options.onError(error instanceof Error ? error.message : "Speech recognition failed.");
        }
      };
      const samples = new Float32Array(analyser.fftSize);
      const started = performance.now();
      let lastSpeech = started;
      let heardSpeech = false;
      const watch = () => {
        if (cancelled || recorder?.state !== "recording") return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
        );
        const now = performance.now();
        if (rms > 0.015) {
          heardSpeech = true;
          lastSpeech = now;
        }
        if (heardSpeech && now - lastSpeech > 6500) {
          recorder.stop();
          return;
        }
        if (!heardSpeech && now - started > 25000) {
          stop();
          options.onError("I couldn't hear you. Please check your microphone or type your answer.");
          return;
        }
        frame = requestAnimationFrame(watch);
      };
      recorder.start(1000);
      options.onStatus("Listening…");
      watch();
    } catch {
      if (!cancelled) {
        stop();
        options.onError(
          "Microphone access failed. Please allow microphone access or type your answer.",
        );
      }
    }
  })();
  return { stop, abort: stop };
}
