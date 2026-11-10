export type RecordingMicrophoneStatus = "ready" | "muted" | "unavailable";

/** Keep permission waits bounded without cancelling a late, consented stream. */
export async function waitForInterviewMedia(
  request: Promise<MediaStream | null> | null,
  timeoutMs = 8000,
): Promise<MediaStream | null> {
  if (!request) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A microphone may arrive after recording starts; attach it exactly once. */
export class InterviewRecordingMicrophone {
  private source: MediaStreamAudioSourceNode | null = null;
  private tracks: MediaStreamTrack[] = [];
  private disposed = false;
  private readonly onStateChange = () => this.refreshStatus();

  constructor(
    private readonly context: AudioContext,
    private readonly destination: MediaStreamAudioDestinationNode,
    private readonly onStatus: (status: RecordingMicrophoneStatus) => void,
    private readonly makeStream = (tracks: MediaStreamTrack[]) => new MediaStream(tracks),
  ) {
    context.addEventListener("statechange", this.onStateChange);
  }

  attach(stream: MediaStream | null): boolean {
    if (this.disposed) return false;
    const tracks = stream?.getAudioTracks().filter((track) => track.readyState === "live") ?? [];
    if (
      this.source &&
      tracks.length === this.tracks.length &&
      tracks.every((t, i) => t === this.tracks[i])
    ) {
      this.refreshStatus();
      return true;
    }
    this.disconnect();
    if (!tracks.length || this.context.state === "closed") {
      this.onStatus("unavailable");
      return false;
    }
    try {
      this.source = this.context.createMediaStreamSource(this.makeStream(tracks));
      this.source.connect(this.destination);
      this.tracks = tracks;
      for (const track of tracks) {
        for (const event of ["ended", "mute", "unmute"]) {
          track.addEventListener(event, this.onStateChange);
        }
      }
      this.refreshStatus();
      return true;
    } catch {
      this.disconnect();
      this.onStatus("unavailable");
      return false;
    }
  }

  refreshStatus(): void {
    if (this.disposed) return;
    const live = this.tracks.filter((track) => track.readyState === "live");
    this.onStatus(
      !this.source || !live.length || this.context.state !== "running"
        ? "unavailable"
        : live.some((track) => track.enabled && !track.muted)
          ? "ready"
          : "muted",
    );
  }

  private disconnect(): void {
    for (const track of this.tracks) {
      for (const event of ["ended", "mute", "unmute"]) {
        track.removeEventListener(event, this.onStateChange);
      }
    }
    this.tracks = [];
    try {
      this.source?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    this.source = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.context.removeEventListener("statechange", this.onStateChange);
  }
}
