/**
 * NativeZoomRecordingImport — explicit, staff-driven import of an existing
 * Zoom cloud recording for a confirmed, user-hosted Lexy-managed appointment.
 *
 * Nothing here runs automatically: appointments load on click, previews are a
 * provider metadata read on click, and import only stores the file. No bot
 * attends meetings, nothing is transcribed or scored on import, and no identity
 * is inferred. Review tokens are opaque, server-owned and never displayed.
 */
import { useState } from "react";
import { MEETING_RECORDING_LIMIT_LABEL } from "@/lib/meeting-recording-limits";
import { apiFetch } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertTriangle,
  CalendarClock,
  CloudDownload,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  NativeZoomAppointment,
  NativeZoomRecordingFile,
  NativeZoomRecordingPreview,
} from "@workspace/api-client-react";

export type ZoomAppointment = NativeZoomAppointment;
export type ZoomPreviewFile = NativeZoomRecordingFile;
export type ZoomPreview = NativeZoomRecordingPreview;

const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
] as const;
const MIN_STATEMENT = 20;
const MAX_STATEMENT = 1500;
const MAX_TITLE = 160;
const MAX_QUESTIONS = 6000;
const MAX_QUESTION_LINES = 100;

class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      msg = j?.error || j?.message || msg;
    } catch {
      /* keep default */
    }
    throw new HttpError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "Unknown size";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtSpan(start: string, end: string): string {
  const s = (Date.parse(end) - Date.parse(start)) / 1000;
  if (!Number.isFinite(s) || s < 0) return "Unknown length";
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function NativeZoomRecordingImport<N extends { id: string }>({
  base,
  onImported,
  onAccessLost,
}: {
  base: string;
  onImported: (note: N) => void;
  /** Parent must hide and drop all private meeting-note data for this context. */
  onAccessLost: () => void;
}) {
  const root = `${base}/native-zoom`;
  const [appointments, setAppointments] = useState<ZoomAppointment[] | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ZoomPreview | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"appointments" | "preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("en");
  const [consent, setConsent] = useState(false);
  const [rightInstance, setRightInstance] = useState(false);
  const [statement, setStatement] = useState("");
  const [planned, setPlanned] = useState("");

  const clearSource = () => {
    setPreview(null);
    setFileId(null);
  };
  const clearAll = () => {
    clearSource();
    setAppointments(null);
    setScheduleId(null);
    setTitle("");
    setLanguage("en");
    setConsent(false);
    setRightInstance(false);
    setStatement("");
    setPlanned("");
    setDone(null);
    setStale(null);
    setError(null);
  };

  /** Shared failure policy: auth -> wipe everything; 409 -> drop source; else keep form. */
  function fail(e: unknown, where: "appointments" | "preview" | "import") {
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 401 || status === 403 || status === 404) {
      clearAll();
      setAccessLost(true);
      onAccessLost();
      return;
    }
    if (status === 409 && where !== "appointments") {
      clearSource();
      setStale(
        `${(e as Error).message}. The recording source changed, the review expired, or Zoom permission is missing. Nothing was imported. Check cloud recording and host permission, then preview again.`,
      );
      return;
    }
    setError((e as Error).message || "Request failed");
  }

  async function loadAppointments() {
    setBusy("appointments");
    setError(null);
    setAccessLost(false);
    try {
      const list = await call<ZoomAppointment[]>(`${root}/appointments`);
      setAppointments(list);
      if (scheduleId && !list.some((a) => a.scheduleId === scheduleId)) {
        setScheduleId(null);
        clearSource();
      }
    } catch (e) {
      fail(e, "appointments");
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    if (!scheduleId) return;
    setBusy("preview");
    setError(null);
    setStale(null);
    setDone(null);
    clearSource();
    try {
      const p = await call<ZoomPreview>(`${root}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId }),
      });
      setPreview(p);
      if (!title) setTitle(`Zoom interview ${new Date(p.recordedAt).toLocaleDateString()}`);
    } catch (e) {
      fail(e, "preview");
    } finally {
      setBusy(null);
    }
  }

  const selected = preview?.files.find((f) => f.id === fileId && f.eligible && f.reviewToken);
  const qLines = planned.split(/\r?\n/).filter((l) => l.trim()).length;
  const titleOk = title.trim().length >= 1 && title.trim().length <= MAX_TITLE;
  const stmtLen = statement.trim().length;
  const stmtOk = stmtLen >= MIN_STATEMENT && stmtLen <= MAX_STATEMENT;
  const plannedOk = planned.trim().length <= MAX_QUESTIONS && qLines <= MAX_QUESTION_LINES;
  const canImport =
    !!selected && titleOk && stmtOk && plannedOk && consent && rightInstance && !busy;

  async function runImport() {
    if (!canImport || !selected?.reviewToken) return;
    setBusy("import");
    setError(null);
    try {
      const n = await call<N>(`${root}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewToken: selected.reviewToken,
          title: title.trim(),
          language,
          consent: true,
          consentStatement: statement.trim(),
          plannedQuestions: planned.trim(),
        }),
      });
      clearSource();
      setScheduleId(null);
      setTitle("");
      setConsent(false);
      setRightInstance(false);
      setStatement("");
      setPlanned("");
      setDone(
        "Recording imported. It has not been transcribed; process it from the note when ready.",
      );
      onImported(n);
    } catch (e) {
      fail(e, "import");
    } finally {
      setBusy(null);
    }
  }

  const appt = appointments?.find((a) => a.scheduleId === scheduleId) ?? null;

  return (
    <Card className="border-border/50" data-testid="panel-native-zoom-import">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <CloudDownload className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Import a Zoom cloud recording</h3>
          <Badge variant="outline" className="text-[10px]">
            Zoom only
          </Badge>
          <span
            className="ml-auto text-[11px] text-muted-foreground"
            data-testid="text-meet-not-connected"
          >
            Google Meet imports use the separate panel below
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Lists only confirmed Lexy-managed Zoom appointments you hosted for this candidate and
            role. Requires Zoom cloud recording to be enabled and the original host's Zoom
            permission. Lexy does not join meetings, and importing does not transcribe, assess or
            score anything. Supported recordings: {MEETING_RECORDING_LIMIT_LABEL}.
          </span>
        </div>

        {accessLost && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600"
            data-testid="text-zoom-access-lost"
          >
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            Access to these Zoom recordings is no longer available for this candidate and role.
            Recording details were cleared.
          </p>
        )}
        {stale && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
            data-testid="text-zoom-stale"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            {stale}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600" data-testid="text-zoom-error">
            {error}
          </p>
        )}
        {done && (
          <p className="text-xs text-emerald-700" data-testid="text-zoom-imported">
            {done}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={!!busy}
            onClick={loadAppointments}
            data-testid="button-zoom-load-appointments"
          >
            {busy === "appointments" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {appointments ? "Refresh my Zoom appointments" : "Show my Zoom appointments"}
          </Button>
        </div>

        {appointments && appointments.length === 0 && (
          <p
            className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
            data-testid="text-zoom-no-appointments"
          >
            No confirmed Zoom appointments hosted by you for this candidate and role.
          </p>
        )}
        {appointments && appointments.length > 0 && (
          <fieldset disabled={!!busy} className="space-y-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Your appointments
            </legend>
            {appointments.map((a) => (
              <label
                key={a.scheduleId}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-sm",
                  scheduleId === a.scheduleId
                    ? "border-primary/50 bg-primary/5"
                    : "border-border/50",
                )}
              >
                <input
                  type="radio"
                  name="zoom-appointment"
                  checked={scheduleId === a.scheduleId}
                  onChange={() => {
                    setScheduleId(a.scheduleId);
                    clearSource();
                    setStale(null);
                  }}
                  data-testid={`radio-zoom-appointment-${a.scheduleId}`}
                />
                <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{fmtDateTime(a.scheduledAt)}</span>
                <span className="text-xs text-muted-foreground">{a.durationMinutes} min</span>
              </label>
            ))}
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!scheduleId || !!busy}
              onClick={runPreview}
              data-testid="button-zoom-preview"
            >
              {busy === "preview" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Video className="h-3.5 w-3.5" />
              )}
              Check Zoom for recordings
            </Button>
          </fieldset>
        )}

        {preview && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void runImport();
            }}
            data-testid="form-zoom-import"
          >
            <fieldset disabled={!!busy} className="space-y-4">
              <div
                className="rounded-lg border border-border/60 p-3 text-xs"
                data-testid="text-zoom-recorded-vs-appointment"
              >
                <p>
                  <span className="font-semibold">Recorded:</span> {fmtDateTime(preview.recordedAt)}
                </p>
                {appt && (
                  <p className="text-muted-foreground">
                    <span className="font-semibold">Appointment:</span>{" "}
                    {fmtDateTime(appt.scheduledAt)} ({appt.durationMinutes} min)
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  Check these match. Lexy does not confirm who appears in the recording.
                </p>
              </div>
              {preview.files.length === 0 ? (
                <p
                  className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
                  data-testid="text-zoom-no-files"
                >
                  Zoom returned no recording files for this appointment.
                </p>
              ) : (
                <ul className="space-y-2">
                  {preview.files.map((f) => (
                    <li key={f.id} data-testid={`row-zoom-file-${f.id}`}>
                      <label
                        className={cn(
                          "flex flex-wrap items-center gap-2.5 rounded-lg border p-2.5 text-sm",
                          f.eligible ? "cursor-pointer" : "opacity-70",
                          fileId === f.id ? "border-primary/50 bg-primary/5" : "border-border/50",
                        )}
                      >
                        <input
                          type="radio"
                          name="zoom-file"
                          disabled={!f.eligible || !f.reviewToken}
                          checked={fileId === f.id}
                          onChange={() => setFileId(f.id)}
                          data-testid={`radio-zoom-file-${f.id}`}
                        />
                        <Badge variant="outline" className="text-[10px]">
                          {f.format}
                        </Badge>
                        <span className="text-xs">{f.kind}</span>
                        <span className="text-xs text-muted-foreground">
                          {fmtBytes(f.bytes)} · {fmtSpan(f.start, f.end)}
                        </span>
                        {!f.eligible && (
                          <span
                            className="basis-full text-[11px] text-amber-700"
                            data-testid={`text-zoom-file-unavailable-${f.id}`}
                          >
                            Not importable: {f.unavailableReason || "outside import limits"}. Lexy
                            accepts files within {MEETING_RECORDING_LIMIT_LABEL}.
                          </span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="zm-title">Title</Label>
                  <Input
                    id="zm-title"
                    value={title}
                    maxLength={MAX_TITLE}
                    onChange={(e) => setTitle(e.target.value)}
                    data-testid="input-zoom-title"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="zm-lang">Spoken language</Label>
                  <select
                    id="zm-lang"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    data-testid="select-zoom-language"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {LANGUAGES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="zm-planned">
                    Planned questions{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="zm-planned"
                    rows={2}
                    value={planned}
                    onChange={(e) => setPlanned(e.target.value)}
                    data-testid="input-zoom-planned"
                  />
                  {!plannedOk && (
                    <p role="alert" className="text-[11px] text-red-600">
                      Up to {MAX_QUESTION_LINES} lines and {MAX_QUESTIONS} characters.
                    </p>
                  )}
                </div>
              </div>

              <fieldset className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <legend className="flex items-center gap-1.5 px-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Staff attestation
                </legend>
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="zm-consent"
                    checked={consent}
                    onCheckedChange={(v) => setConsent(v === true)}
                    className="mt-0.5"
                    data-testid="checkbox-zoom-consent"
                  />
                  <Label htmlFor="zm-consent" className="text-sm font-normal leading-snug">
                    Every participant was told this meeting was recorded and would be processed by
                    AI, and each agreed.
                  </Label>
                </div>
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="zm-instance"
                    checked={rightInstance}
                    onCheckedChange={(v) => setRightInstance(v === true)}
                    className="mt-0.5"
                    data-testid="checkbox-zoom-right-instance"
                  />
                  <Label htmlFor="zm-instance" className="text-sm font-normal leading-snug">
                    I checked this is the right meeting instance for this candidate and role.
                  </Label>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="zm-statement">How and when was consent obtained?</Label>
                  <Textarea
                    id="zm-statement"
                    rows={2}
                    value={statement}
                    onChange={(e) => setStatement(e.target.value)}
                    data-testid="input-zoom-consent-statement"
                  />
                  <p
                    className={cn(
                      "text-[11px]",
                      statement && !stmtOk ? "text-red-600" : "text-muted-foreground",
                    )}
                  >
                    {MIN_STATEMENT} to {MAX_STATEMENT} characters ({stmtLen}).
                  </p>
                </div>
              </fieldset>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={!canImport}
                  className="gap-2"
                  data-testid="button-zoom-import"
                >
                  {busy === "import" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CloudDownload className="h-4 w-4" />
                  )}
                  Import recording
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default NativeZoomRecordingImport;
