/**
 * MeetingLiveCapture — records a human meeting locally in the browser (shared
 * tab/display audio + microphone). Nothing is uploaded or processed here: the
 * user must explicitly hand the file to the existing upload form.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Check, Loader2, Mic, Square, Trash2 } from "lucide-react";
import { createMeetingCaptureSession } from "@/lib/meeting-live-capture";
import { MEETING_RECORDING_LIMIT_LABEL } from "@/lib/meeting-recording-limits";

type Phase = "idle" | "requesting" | "recording" | "stopping" | "ready";
const MIN_CAPTURE_STATEMENT = 12;

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function MeetingLiveCapture({
  onUseRecording,
  disabled,
  onBusyChange,
}: {
  onUseRecording: (file: File) => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [consent, setConsent] = useState(false);
  const [statement, setStatement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ file: File; url: string } | null>(null);

  const sessionRef = useRef<ReturnType<typeof createMeetingCaptureSession> | null>(null);
  const tokenRef = useRef(0); // invalidates callbacks of stale sessions
  const urlRef = useRef<string | null>(null);
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;

  const busy = phase === "requesting" || phase === "recording" || phase === "stopping";
  useEffect(() => {
    busyRef.current?.(busy);
  }, [busy]);

  const revoke = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  // Unmount: invalidate callbacks, discard session, revoke URL, release busy.
  useEffect(
    () => () => {
      tokenRef.current++;
      sessionRef.current?.discard();
      sessionRef.current = null;
      revoke();
      busyRef.current?.(false);
    },
    [],
  );

  // Elapsed counter while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    setElapsed(0);
    const t = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => window.clearInterval(t);
  }, [phase]);

  // Warn about losing unsaved local audio.
  useEffect(() => {
    if (phase === "idle") return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase]);

  const start = async () => {
    if (
      sessionRef.current ||
      disabled ||
      !consent ||
      statement.trim().length < MIN_CAPTURE_STATEMENT
    )
      return;
    setError(null);
    revoke();
    setResult(null);
    const token = ++tokenRef.current;
    const live = () => tokenRef.current === token;
    const s = createMeetingCaptureSession({
      onState: (st) => live() && setPhase(st),
      onComplete: (file) => {
        if (!live()) return;
        sessionRef.current = null;
        revoke();
        const url = URL.createObjectURL(file);
        urlRef.current = url;
        setResult({ file, url });
        setPhase("ready");
      },
      onError: (msg) => {
        if (!live()) return;
        sessionRef.current?.discard();
        sessionRef.current = null;
        setError(msg || "Recording failed.");
        setPhase("idle");
      },
    });
    sessionRef.current = s;
    setPhase("requesting");
    try {
      await s.start();
    } catch (e) {
      if (!live()) return;
      s.discard();
      sessionRef.current = null;
      setError((e as Error)?.message || "Could not start recording.");
      setPhase("idle");
    }
  };

  const discard = () => {
    tokenRef.current++;
    sessionRef.current?.discard();
    sessionRef.current = null;
    revoke();
    setResult(null);
    setElapsed(0);
    setPhase("idle");
  };

  const use = () => {
    if (!result) return;
    const f = result.file;
    discard();
    onUseRecording(f);
  };

  const canStart =
    !disabled && consent && statement.trim().length >= MIN_CAPTURE_STATEMENT && phase === "idle";

  return (
    <div
      className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4"
      data-testid="panel-meeting-live-capture"
    >
      <div className="flex items-center gap-2">
        <Mic className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold">Record in browser</h4>
        <span className="ml-auto text-[11px] text-muted-foreground">
          max {MEETING_RECORDING_LIMIT_LABEL}
        </span>
      </div>
      <p role="note" className="text-xs text-amber-700 dark:text-amber-400">
        Local browser capture: audio-sharing support varies by browser and device. If sharing audio
        is unavailable, import an existing recording instead.
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Start, then pick the meeting tab or screen and turn on <strong>“Share tab audio”</strong>{" "}
        (or system audio). Your microphone is mixed in. Only audio is kept. Lexy does not join the
        call and does not identify speakers. Stopping the share ends the recording.
      </p>

      {phase === "idle" && (
        <div className="space-y-2">
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="mlc-consent"
              checked={consent}
              disabled={disabled}
              onCheckedChange={(v) => setConsent(v === true)}
              className="mt-0.5"
              data-testid="checkbox-capture-consent"
            />
            <Label htmlFor="mlc-consent" className="text-sm font-normal leading-snug">
              Everyone in this meeting has been told it will be recorded and has agreed.
            </Label>
          </div>
          <Textarea
            id="mlc-statement"
            aria-label="How consent to record was obtained"
            rows={2}
            value={statement}
            disabled={disabled}
            onChange={(e) => setStatement(e.target.value)}
            placeholder="e.g. Asked both participants at 10:02, both agreed verbally."
            data-testid="input-capture-consent-statement"
          />
          <p className="text-[11px] text-muted-foreground">
            At least {MIN_CAPTURE_STATEMENT} characters ({statement.trim().length}/
            {MIN_CAPTURE_STATEMENT}). Upload consent below is still required.
          </p>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!canStart}
            onClick={start}
            data-testid="button-capture-start"
          >
            <Mic className="h-3.5 w-3.5" />
            {error ? "Try again" : "Start recording"}
          </Button>
        </div>
      )}

      {(phase === "requesting" || phase === "recording" || phase === "stopping") && (
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <span
            className="flex items-center gap-2 text-sm font-medium"
            data-testid="status-capture"
          >
            {phase === "recording" ? (
              <span className="h-2.5 w-2.5 rounded-full bg-red-500 motion-safe:animate-pulse" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {phase === "requesting"
              ? "Waiting for permissions…"
              : phase === "stopping"
                ? "Finalizing…"
                : "Recording"}
          </span>
          {phase === "recording" && (
            <span className="font-mono text-sm tabular-nums" data-testid="text-capture-elapsed">
              {fmt(elapsed)} / 15:00
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={phase !== "recording"}
              onClick={() => sessionRef.current?.stop()}
              data-testid="button-capture-stop"
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={discard}
              data-testid="button-capture-discard"
            >
              <Trash2 className="h-3.5 w-3.5" /> Discard
            </Button>
          </div>
        </div>
      )}

      {phase === "ready" && result && (
        <div className="space-y-2">
          <audio
            controls
            preload="metadata"
            src={result.url}
            className="w-full"
            data-testid="audio-capture-preview"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={disabled}
              onClick={use}
              data-testid="button-capture-use"
            >
              <Check className="h-3.5 w-3.5" /> Use recording
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={discard}
              data-testid="button-capture-discard-ready"
            >
              <Trash2 className="h-3.5 w-3.5" /> Discard
            </Button>
          </div>
        </div>
      )}

      {phase !== "idle" && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          Stored only in this browser until you upload it. Closing or leaving this page loses it.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600" data-testid="text-capture-error">
          {error}
        </p>
      )}
    </div>
  );
}

export default MeetingLiveCapture;
