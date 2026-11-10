/**
 * NativeMeetRecordingImport — explicit, staff-driven import of a Google Meet
 * recording for a confirmed, user-hosted Lexy-managed appointment.
 *
 * Nothing reads Google automatically: appointments, conference instances,
 * previews and the import each happen only on an explicit click. Importing only
 * stores the file; nothing is transcribed, scored or emailed. Review tokens are
 * opaque, server-owned and never displayed.
 */
import { useEffect, useRef, useState } from "react";
import { MEETING_RECORDING_LIMIT_LABEL } from "@/lib/meeting-recording-limits";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListNativeMeetRecordingAppointmentsQueryKey,
  useImportNativeMeetRecording,
  useListNativeMeetRecordingAppointments,
  useListNativeMeetRecordingConferences,
  usePreviewNativeMeetRecording,
  type MeetingNote,
  type NativeMeetConference,
  type NativeMeetRecordingPreview,
  type NativeZoomAppointment,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
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
const DENIED = new Set([401, 403, 404]);

export function meetErrStatus(e: unknown): number {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : 0;
}
function errMessage(e: unknown): string {
  const data = (e as { data?: { error?: unknown; message?: unknown } | null } | null)?.data;
  const m = data?.error ?? data?.message;
  if (typeof m === "string" && m) return m;
  return e instanceof Error && e.message ? e.message : "Request failed";
}
function providerHint(status: number): string {
  if (status === 409)
    return " The recording source changed, the review expired, or Meet recording access is missing or needs reconnecting in Calendar settings. Nothing was imported.";
  if (status === 412 || status === 428)
    return " Google Meet recording access is not connected. Connect it in Calendar settings.";
  if (status === 503) return " Google Meet recording import is not set up for this workspace.";
  if (status === 502 || status === 504) return " Google did not respond reliably; try again.";
  return "";
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

export interface NativeMeetRecordingImportProps {
  jobId: string;
  candidateId: string;
  onImported: (note: MeetingNote) => void;
  /** Parent must hide and drop all private meeting-note data for this context. */
  onAccessLost: () => void;
}

/** Keyed by actor + employer + job + candidate so any authority change drops all state. */
export function NativeMeetRecordingImport(props: NativeMeetRecordingImportProps) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Inner
      key={`${user.id}:${user.tenantId ?? ""}:${props.jobId}:${props.candidateId}`}
      actorKey={`${user.id}:${user.tenantId ?? ""}`}
      {...props}
    />
  );
}

export default NativeMeetRecordingImport;

function Inner({
  jobId,
  candidateId,
  onImported,
  onAccessLost,
  actorKey,
}: NativeMeetRecordingImportProps & { actorKey: string }) {
  const qc = useQueryClient();
  const queryKey = [
    ...getListNativeMeetRecordingAppointmentsQueryKey(jobId, candidateId),
    actorKey,
  ];
  const apptQ = useListNativeMeetRecordingAppointments(jobId, candidateId, {
    query: {
      queryKey,
      enabled: false,
      retry: false,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  });
  const confM = useListNativeMeetRecordingConferences();
  const previewM = usePreviewNativeMeetRecording();
  const importM = useImportNativeMeetRecording();

  const gen = useRef(0);
  const alive = useRef(true);
  const onAccessLostRef = useRef(onAccessLost);
  onAccessLostRef.current = onAccessLost;
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  const [appointments, setAppointments] = useState<NativeZoomAppointment[] | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [conferences, setConferences] = useState<NativeMeetConference[] | null>(null);
  const [conferenceName, setConferenceName] = useState<string | null>(null);
  const [preview, setPreview] = useState<NativeMeetRecordingPreview | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"appointments" | "conferences" | "preview" | "import" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("en");
  const [consent, setConsent] = useState(false);
  const [statement, setStatement] = useState("");
  const [planned, setPlanned] = useState("");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      gen.current++;
      qc.removeQueries({ queryKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Any authority-bearing change invalidates in-flight work and stale review. */
  const bump = () => ++gen.current;
  const current = (g: number) => alive.current && g === gen.current;

  const clearReview = () => {
    setPreview(null);
    setFileId(null);
    setConsent(false);
  };
  const clearConferences = () => {
    setConferences(null);
    setConferenceName(null);
    clearReview();
  };
  const clearAll = () => {
    bump();
    clearConferences();
    setAppointments(null);
    setScheduleId(null);
    setTitle("");
    setLanguage("en");
    setStatement("");
    setPlanned("");
    setDone(null);
    setError(null);
    setBusy(null);
    qc.removeQueries({ queryKey });
    confM.reset();
    previewM.reset();
    importM.reset();
  };

  function fail(
    e: unknown,
    g: number,
    where: "appointments" | "conferences" | "preview" | "import",
  ) {
    if (!current(g)) return;
    const status = meetErrStatus(e);
    if (DENIED.has(status)) {
      clearAll();
      setAccessLost(true);
      onAccessLostRef.current();
      return;
    }
    // Every failure drops reviewable data; nothing stale stays selectable.
    if (where === "appointments" || status === 409) clearAll();
    else if (where === "conferences") clearConferences();
    else clearReview();
    setBusy(null);
    setError(`${errMessage(e)}.${providerHint(status)}`.replace(/\.\./g, "."));
  }

  async function loadAppointments() {
    const g = bump();
    clearConferences();
    setBusy("appointments");
    setError(null);
    setDone(null);
    setAccessLost(false);
    const r = await apptQ.refetch();
    if (!current(g)) return;
    if (r.isError || !r.data) {
      fail(r.error, g, "appointments");
      return;
    }
    setAppointments(r.data);
    if (scheduleId && !r.data.some((a) => a.scheduleId === scheduleId)) setScheduleId(null);
    qc.removeQueries({ queryKey });
    setBusy(null);
  }

  function findConferences() {
    if (!scheduleId) return;
    const g = bump();
    clearConferences();
    setBusy("conferences");
    setError(null);
    setDone(null);
    confM.mutate(
      { jobId, candidateId, data: { scheduleId } },
      {
        onSuccess: (list) => {
          if (!current(g)) return;
          setConferences(list);
          setBusy(null);
        },
        onError: (e) => fail(e, g, "conferences"),
      },
    );
  }

  function runPreview() {
    if (!scheduleId || !conferenceName) return;
    const g = bump();
    clearReview();
    setBusy("preview");
    setError(null);
    setDone(null);
    previewM.mutate(
      { jobId, candidateId, data: { scheduleId, conferenceName } },
      {
        onSuccess: (p) => {
          if (!current(g)) return;
          if (p.scheduleId !== scheduleId) {
            setError("Google returned a preview for a different appointment. Nothing was kept.");
            setBusy(null);
            return;
          }
          setPreview(p);
          if (!title)
            setTitle(`Google Meet interview ${new Date(p.recordedAt).toLocaleDateString()}`);
          setBusy(null);
        },
        onError: (e) => fail(e, g, "preview"),
      },
    );
  }

  const selected = preview?.files.find((f) => f.id === fileId && f.eligible && f.reviewToken);
  const qLines = planned.split(/\r?\n/).filter((l) => l.trim()).length;
  const titleOk = title.trim().length >= 1 && title.trim().length <= MAX_TITLE;
  const stmtLen = statement.trim().length;
  const stmtOk = stmtLen >= MIN_STATEMENT && stmtLen <= MAX_STATEMENT;
  const plannedOk = planned.trim().length <= MAX_QUESTIONS && qLines <= MAX_QUESTION_LINES;
  const canImport = !!selected && titleOk && stmtOk && plannedOk && consent && !busy;

  function runImport() {
    if (!canImport || !selected?.reviewToken) return;
    const g = bump();
    setBusy("import");
    setError(null);
    const p = planned.trim();
    importM.mutate(
      {
        jobId,
        candidateId,
        data: {
          reviewToken: selected.reviewToken,
          title: title.trim(),
          language,
          consent: true,
          consentStatement: statement.trim(),
          ...(p ? { plannedQuestions: p } : {}),
        },
      },
      {
        onSuccess: (n) => {
          if (!current(g)) return;
          bump();
          clearConferences();
          setScheduleId(null);
          setTitle("");
          setStatement("");
          setPlanned("");
          setBusy(null);
          setDone(
            "Recording imported. It has not been transcribed, scored or shared; process it from the note when ready.",
          );
          onImportedRef.current(n);
        },
        onError: (e) => fail(e, g, "import"),
      },
    );
  }

  /** Input edits that change what is attested invalidate the explicit consent. */
  const touch = () => {
    setConsent(false);
    setDone(null);
  };

  const appt = appointments?.find((a) => a.scheduleId === scheduleId) ?? null;
  const conf = conferences?.find((c) => c.name === conferenceName) ?? null;

  return (
    <Card className="border-border/50" data-testid="native-meet-panel">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Video className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Import a Google Meet recording</h3>
          <Badge variant="outline" className="text-[10px]">
            Optional · separate authorization
          </Badge>
        </div>
        <div
          className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground"
          data-testid="native-meet-explainer"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Requires the separate, optional Google Meet recording access in Calendar settings; your
            Calendar connection alone is not enough. Lexy only looks at confirmed Lexy-managed Meet
            appointments you hosted for this candidate and role, and only at meeting instances in
            the window Lexy derives for that appointment. It never browses your Google account.
            Importing does not transcribe, assess, score or email anything. Supported recordings:{" "}
            {MEETING_RECORDING_LIMIT_LABEL}.
          </span>
        </div>

        {accessLost && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600"
            data-testid="native-meet-access-lost"
          >
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            Access to Google Meet recordings is no longer available for this candidate and role.
            Recording details were cleared.
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
            data-testid="native-meet-error"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            {error}
          </p>
        )}
        {done && (
          <p className="text-xs text-emerald-700" data-testid="native-meet-imported">
            {done}
          </p>
        )}

        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!!busy}
          onClick={() => void loadAppointments()}
          data-testid="native-meet-load-appointments"
        >
          {busy === "appointments" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {appointments ? "Refresh my Meet appointments" : "Show my Meet appointments"}
        </Button>

        {appointments && appointments.length === 0 && (
          <p
            className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
            data-testid="native-meet-no-appointments"
          >
            No confirmed Google Meet appointments hosted by you for this candidate and role.
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
                  name="native-meet-appointment"
                  checked={scheduleId === a.scheduleId}
                  onChange={() => {
                    bump();
                    setBusy(null);
                    setScheduleId(a.scheduleId);
                    clearConferences();
                    setError(null);
                  }}
                  data-testid={`native-meet-appointment-${a.scheduleId}`}
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
              onClick={findConferences}
              data-testid="native-meet-find-conferences"
            >
              {busy === "conferences" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Video className="h-3.5 w-3.5" />
              )}
              Find completed Meet instances
            </Button>
          </fieldset>
        )}

        {conferences && conferences.length === 0 && (
          <p
            className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
            data-testid="native-meet-no-conferences"
          >
            Google reported no completed meeting instance in this appointment's window. If the
            meeting just ended, recordings can take a while to appear.
          </p>
        )}
        {conferences && conferences.length > 0 && (
          <fieldset disabled={!!busy} className="space-y-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Completed meeting instances
            </legend>
            {conferences.map((c) => (
              <label
                key={c.name}
                className={cn(
                  "flex cursor-pointer flex-wrap items-center gap-2.5 rounded-lg border p-2.5 text-sm",
                  conferenceName === c.name ? "border-primary/50 bg-primary/5" : "border-border/50",
                )}
              >
                <input
                  type="radio"
                  name="native-meet-conference"
                  checked={conferenceName === c.name}
                  onChange={() => {
                    bump();
                    setBusy(null);
                    setConferenceName(c.name);
                    clearReview();
                    setError(null);
                  }}
                  data-testid={`native-meet-conference-${c.name.replace(/[^A-Za-z0-9_-]/g, "_")}`}
                />
                <span>{fmtDateTime(c.start)}</span>
                <span className="text-xs text-muted-foreground">to {fmtDateTime(c.end)}</span>
              </label>
            ))}
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!conferenceName || !!busy}
              onClick={runPreview}
              data-testid="native-meet-preview"
            >
              {busy === "preview" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudDownload className="h-3.5 w-3.5" />
              )}
              Check this instance for recordings
            </Button>
          </fieldset>
        )}

        {preview && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              runImport();
            }}
            data-testid="native-meet-form"
          >
            <fieldset disabled={!!busy} className="space-y-4">
              <div
                className="rounded-lg border border-border/60 p-3 text-xs"
                data-testid="native-meet-recorded"
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
                {conf && (
                  <p className="text-muted-foreground">
                    <span className="font-semibold">Instance:</span> {fmtDateTime(conf.start)} to{" "}
                    {fmtDateTime(conf.end)}
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  Check these match. Lexy does not confirm who appears in the recording.
                </p>
              </div>
              {preview.files.length === 0 ? (
                <p
                  className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
                  data-testid="native-meet-no-files"
                >
                  Google returned no recording files for this meeting instance.
                </p>
              ) : (
                <ul className="space-y-2">
                  {preview.files.map((f) => (
                    <li key={f.id} data-testid={`native-meet-file-row-${f.id}`}>
                      <label
                        className={cn(
                          "flex flex-wrap items-center gap-2.5 rounded-lg border p-2.5 text-sm",
                          f.eligible ? "cursor-pointer" : "opacity-70",
                          fileId === f.id ? "border-primary/50 bg-primary/5" : "border-border/50",
                        )}
                      >
                        <input
                          type="radio"
                          name="native-meet-file"
                          disabled={!f.eligible || !f.reviewToken}
                          checked={fileId === f.id}
                          onChange={() => {
                            setFileId(f.id);
                            touch();
                          }}
                          data-testid={`native-meet-file-${f.id}`}
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
                            data-testid={`native-meet-file-unavailable-${f.id}`}
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
                  <Label htmlFor="nm-title">Title</Label>
                  <Input
                    id="nm-title"
                    value={title}
                    maxLength={MAX_TITLE}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      touch();
                    }}
                    data-testid="native-meet-title"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nm-lang">Spoken language</Label>
                  <select
                    id="nm-lang"
                    value={language}
                    onChange={(e) => {
                      setLanguage(e.target.value);
                      touch();
                    }}
                    data-testid="native-meet-language"
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
                  <Label htmlFor="nm-planned">
                    Planned questions{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="nm-planned"
                    rows={2}
                    value={planned}
                    onChange={(e) => {
                      setPlanned(e.target.value);
                      touch();
                    }}
                    data-testid="native-meet-planned"
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
                <div className="space-y-1.5">
                  <Label htmlFor="nm-statement">How and when was consent obtained?</Label>
                  <Textarea
                    id="nm-statement"
                    rows={2}
                    value={statement}
                    onChange={(e) => {
                      setStatement(e.target.value);
                      touch();
                    }}
                    data-testid="native-meet-consent-statement"
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
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="nm-consent"
                    checked={consent}
                    disabled={!selected}
                    onCheckedChange={(v) => setConsent(v === true)}
                    className="mt-0.5"
                    data-testid="native-meet-consent"
                  />
                  <Label htmlFor="nm-consent" className="text-sm font-normal leading-snug">
                    Every participant was told this meeting was recorded and would be processed by
                    AI, and each agreed. I checked that this exact meeting instance and file belong
                    to this candidate and role.
                  </Label>
                </div>
              </fieldset>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={!canImport}
                  className="gap-2"
                  data-testid="native-meet-import"
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
