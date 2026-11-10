/**
 * Use the recorder's container MIME, without codec parameters, for multipart.
 * Native vp9,opus labels contain an unquoted comma: Busboy treats those part
 * headers as invalid and falls back to text/plain. Relabeling preserves bytes.
 */
export interface RecordingCheckpointSource {
  readonly state: "inactive" | "paused" | "recording";
  requestData(): void;
  addEventListener(type: "dataavailable", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "dataavailable", listener: () => void): void;
}

export function recordingSegmentForm(
  blob: Blob,
  attemptId: string,
  index: number,
  recorderMimeType: string,
): FormData {
  const type = recorderMimeType.split(";")[0].trim().toLowerCase();
  if (!["video/webm", "audio/webm", "video/mp4", "audio/mp4"].includes(type)) {
    throw new Error("Unsupported recording container");
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([blob], { type }),
    `checkpoint.${type.endsWith("mp4") ? "mp4" : "webm"}`,
  );
  form.append("attemptId", attemptId);
  form.append("index", String(index));
  return form;
}

/** Serialized live checkpoints; each new recorder receives a fresh attempt id. */
export class InterviewRecordingSegments {
  readonly attemptId = crypto.randomUUID();
  private index = 0;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(
    private upload: (blob: Blob, attemptId: string, index: number) => Promise<void>,
    private onFailure: () => void,
  ) {}

  enqueue(blob: Blob): void {
    if (this.closed || !blob.size) return;
    // Background tabs can produce an oversized timeslice. Byte chunks remain
    // ordered within this one container and fit the server's upload limit.
    const limit = 5 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += limit) {
      const part = blob.slice(offset, Math.min(blob.size, offset + limit), blob.type);
      const index = this.index++;
      this.pending = this.pending.then(async () => {
        for (let retry = 0; retry < 3; retry++) {
          try {
            await this.upload(part, this.attemptId, index);
            return;
          } catch {
            if (retry < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** retry));
          }
        }
        this.onFailure();
      });
    }
  }

  async flush(recorder: RecordingCheckpointSource): Promise<void> {
    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          recorder.removeEventListener("dataavailable", received);
          reject(new Error("Recording checkpoint timed out"));
        }, 5000);
        const received = () => {
          clearTimeout(timeout);
          // ondataavailable has enqueued this final checkpoint before the microtask.
          queueMicrotask(resolve);
        };
        recorder.addEventListener("dataavailable", received, { once: true });
        try {
          recorder.requestData();
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    }
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Recording uploads timed out")), 30000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
