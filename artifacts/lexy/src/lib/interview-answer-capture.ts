/** A continuous, microphone-only answer. Segment previews are not grading evidence. */
export class InterviewAnswerCapture {
  private recorder: MediaRecorder;
  private chunks: Blob[] = [];
  private failed = false;
  private result: Promise<Blob> | null = null;

  constructor(stream: MediaStream, mime: string) {
    const audio = new MediaStream(stream.getAudioTracks());
    this.recorder = mime ? new MediaRecorder(audio, { mimeType: mime }) : new MediaRecorder(audio);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.onerror = () => {
      this.failed = true;
    };
    this.recorder.start(1000);
  }

  finish(): Promise<Blob> {
    if (this.result) return this.result;
    this.result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Answer audio did not finalize")), 8000);
      this.recorder.onstop = () => {
        clearTimeout(timeout);
        if (this.failed) reject(new Error("Answer audio capture failed"));
        else resolve(new Blob(this.chunks, { type: this.recorder.mimeType || "audio/webm" }));
        this.chunks = [];
      };
      if (this.recorder.state === "inactive") {
        clearTimeout(timeout);
        reject(new Error("Answer audio is unavailable"));
      } else this.recorder.stop();
    });
    return this.result;
  }

  dispose(): void {
    this.failed = true;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    this.chunks = [];
  }
}
