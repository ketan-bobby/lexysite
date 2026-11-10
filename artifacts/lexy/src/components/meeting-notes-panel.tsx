/**
 * MeetingNotesPanel — staff-only meeting recording import, processing status
 * and source-grounded transcript/summary review for a candidate + job.
 *
 * Privacy: recordings, transcripts and summaries are staff-only source
 * material. They are kept separate from scores and are never shown on the
 * candidate portal. Nothing here is fed into any evaluation or scoring.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase, apiFetch } from "@/lib/api";
import {
  MAX_MEETING_BYTES as MAX_BYTES,
  MAX_MEETING_SECONDS as MAX_SECONDS,
  MEETING_RECORDING_LIMIT_LABEL,
} from "@/lib/meeting-recording-limits";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AudioLines,
  Upload,
  Play,
  RotateCcw,
  Trash2,
  Download,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  FileAudio,
  Clock,
  Lock,
  ListChecks,
  FileText,
  Briefcase,
  X,
  RefreshCw,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import {
  MeetingNotesQuestionReview,
  type QuestionReview,
} from "@/components/meeting-notes-question-review";
import { MeetingLiveCapture } from "@/components/meeting-live-capture";
import type { NativeMeetingRecordingSource } from "@workspace/api-client-react";
import { NativeZoomRecordingImport } from "@/components/native-zoom-recording-import";
import { NativeMeetRecordingImport } from "@/components/native-meet-recording-import";
import { MeetingAttendancePanel } from "@/components/meeting-attendance-panel";
import {
  MeetingSpeakerEvidence,
  SpeakerSeparationOptIn,
  type SpeakerEvidence,
} from "@/components/meeting-speaker-evidence";

export type MeetingNoteStatus = "uploaded" | "processing" | "completed" | "failed";
export interface MeetingNote {
  id: string;
  title: string;
  language: string;
  status: MeetingNoteStatus;
  createdAt: string;
  updatedAt: string;
  consentAt: string;
  consentStatement: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  error: string | null;
  transcript: string | null;
  summary: string | null;
  plannedQuestions: string;
  processingStartedAt: string | null;
  canRetry: boolean;
  transcriptHash: string | null;
  questionReview: QuestionReview | null;
  speakerEvidence?: SpeakerEvidence | null;
  nativeSource?: NativeMeetingRecordingSource | null;
}

const ACCEPT_EXT = ["wav", "mp3", "webm", "mp4", "ogg", "flac"];
const ACCEPT =
  ".wav,.mp3,.webm,.mp4,.ogg,.flac,audio/wav,audio/x-wav,audio/mpeg,audio/webm,video/webm,audio/mp4,video/mp4,audio/ogg,audio/flac,audio/x-flac";
const MIN_STATEMENT = 40;
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

function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "Unknown size";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error || j?.message || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video") ? "video" : "audio");
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const t = window.setTimeout(() => done(null), 8000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      window.clearTimeout(t);
      done(Number.isFinite(el.duration) ? el.duration : null);
    };
    el.onerror = () => {
      window.clearTimeout(t);
      done(null);
    };
    el.src = url;
  });
}

const STATUS_META: Record<MeetingNoteStatus, { label: string; cls: string }> = {
  uploaded: {
    label: "Uploaded - not processed",
    cls: "bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-300",
  },
  processing: { label: "Processing", cls: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  completed: {
    label: "Draft ready",
    cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  },
  failed: { label: "Failed", cls: "bg-red-500/10 text-red-600 border-red-500/20" },
};

function StatusBadge({ status }: { status: MeetingNoteStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.uploaded;
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] font-semibold gap-1", m.cls)}
      data-testid="status-meeting-note"
    >
      {status === "processing" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {m.label}
    </Badge>
  );
}

/** Keyed wrapper: any candidate/job change remounts and clears all local state. */
export function MeetingNotesPanel({
  candidateId,
  jobId,
}: {
  candidateId: string;
  jobId: string | null;
}) {
  if (!jobId) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-14 text-center">
          <Briefcase className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <h3 className="font-semibold">No job context for meeting notes</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Meeting notes are stored against a specific role. Link this candidate to a job (match or
            score them for a role) to import recordings.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <MeetingNotesInner key={`${candidateId}::${jobId}`} candidateId={candidateId} jobId={jobId} />
  );
}

export default MeetingNotesPanel;

function MeetingNotesInner({ candidateId, jobId }: { candidateId: string; jobId: string }) {
  const qc = useQueryClient();
  const base = `${apiBase}/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/meeting-notes`;
  const listKey = ["meeting-notes", jobId, candidateId] as const;
  const detailKey = (id: string) => ["meeting-note", jobId, candidateId, id] as const;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Set when a mutation reports lost access; blocks ALL cached private detail until a
  // fresh successful detail read (newer than the block) or an explicit retry succeeds.
  const [accessBlockedAt, setAccessBlockedAt] = useState<number | null>(null);

  const list = useQuery<MeetingNote[]>({
    queryKey: listKey,
    queryFn: async () => {
      const res = await apiFetch(base);
      if (!res.ok) throw new Error(await readError(res));
      return res.json();
    },
    retry: false,
    refetchInterval: (q) =>
      (q.state.data as MeetingNote[] | undefined)?.some((n) => n.status === "processing")
        ? 3000
        : false,
  });

  const detail = useQuery<MeetingNote>({
    queryKey: detailKey(selectedId ?? ""),
    enabled: !!selectedId,
    queryFn: async () => {
      const res = await apiFetch(`${base}/${encodeURIComponent(selectedId!)}`);
      if (!res.ok) throw new Error(await readError(res));
      return res.json();
    },
    retry: false,
    refetchInterval: (q) =>
      (q.state.data as MeetingNote | undefined)?.status === "processing"
        ? 3000
        : (q.state.data as MeetingNote | undefined)?.status === "completed" ||
            ((q.state.data as MeetingNote | undefined)?.status === "failed" &&
              !!(q.state.data as MeetingNote | undefined)?.transcript)
          ? 30000
          : false,
    staleTime: 30000,
  });

  useEffect(() => {
    if (
      accessBlockedAt != null &&
      detail.isSuccess &&
      !detail.isFetching &&
      detail.dataUpdatedAt > accessBlockedAt
    ) {
      setAccessBlockedAt(null);
    }
  }, [accessBlockedAt, detail.isSuccess, detail.isFetching, detail.dataUpdatedAt]);
  useEffect(() => {
    setAccessBlockedAt(null);
  }, [selectedId]);

  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: listKey });
    if (id) qc.invalidateQueries({ queryKey: detailKey(id) });
  };

  const processM = useMutation({
    mutationFn: async ({ id, separateSpeakers }: { id: string; separateSpeakers: boolean }) => {
      const res = await apiFetch(`${base}/${encodeURIComponent(id)}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Unchecked keeps the legacy "{}" body exactly; opt-in only when explicitly chosen.
        body: separateSpeakers ? JSON.stringify({ separateSpeakers: true }) : "{}",
      });
      if (res.status !== 202 && !res.ok) throw new Error(await readError(res));
      return res.json() as Promise<MeetingNote>;
    },
    onMutate: () => setActionError(null),
    onError: (e: Error) => setActionError(e.message),
    onSettled: (_d, _e, v) => invalidate(v.id),
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status !== 204 && !res.ok) throw new Error(await readError(res));
    },
    onMutate: () => setActionError(null),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: detailKey(id) });
      if (selectedId === id) setSelectedId(null);
    },
    onError: (e: Error) => setActionError(e.message),
    onSettled: (_d, _e, id) => invalidate(id),
  });

  // Fail closed: never render cached private data when the latest fetch errored.
  const notes = list.isError ? [] : (list.data ?? []);

  return (
    <div className="space-y-5" data-testid="panel-meeting-notes">
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Staff-only source material.</span>{" "}
          Recordings, transcripts and summaries are never shown to the candidate and are not used in
          any score or evaluation.
        </p>
      </div>

      <UploadCard
        base={base}
        onUploaded={(n) => {
          invalidate(n.id);
          setSelectedId(n.id);
        }}
      />

      <NativeZoomRecordingImport
        key={`native-zoom-${candidateId}::${jobId}`}
        base={base}
        onImported={(n: MeetingNote) => {
          qc.setQueryData(detailKey(n.id), n);
          invalidate(n.id);
          setSelectedId(n.id);
        }}
        onAccessLost={() => {
          setSelectedId(null);
          qc.removeQueries({ queryKey: ["meeting-note", jobId, candidateId] });
          qc.removeQueries({ queryKey: listKey });
          qc.invalidateQueries({ queryKey: listKey });
        }}
      />

      <NativeMeetRecordingImport
        key={`native-meet-${candidateId}::${jobId}`}
        jobId={jobId}
        candidateId={candidateId}
        onImported={(n) => {
          const note = n as unknown as MeetingNote;
          qc.setQueryData(detailKey(note.id), note);
          invalidate(note.id);
          setSelectedId(note.id);
        }}
        onAccessLost={() => {
          setSelectedId(null);
          qc.removeQueries({ queryKey: ["meeting-note", jobId, candidateId] });
          qc.removeQueries({ queryKey: listKey });
          qc.invalidateQueries({ queryKey: listKey });
        }}
      />

      <MeetingAttendancePanel
        key={`attendance-${candidateId}::${jobId}`}
        jobId={jobId}
        candidateId={candidateId}
      />

      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600"
          data-testid="text-meeting-action-error"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setActionError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <section aria-label="Meeting recordings" className="space-y-2">
          <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recordings
          </h3>
          {list.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : list.isError ? (
            <Card className="border-red-500/30">
              <CardContent className="p-5 text-center">
                <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-red-500" />
                <p className="text-sm font-medium">Could not load meeting notes</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(list.error as Error)?.message}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 gap-1.5"
                  onClick={() => list.refetch()}
                  data-testid="button-retry-meeting-list"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : notes.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-10 text-center">
                <AudioLines className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">No meeting recordings yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Import a consented recording above to create a draft transcript.
                </p>
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(n.id)}
                    aria-pressed={selectedId === n.id}
                    data-testid={`button-select-meeting-note-${n.id}`}
                    className={cn(
                      "w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selectedId === n.id ? "border-primary/50 bg-primary/5" : "border-border/50",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-1 text-sm font-semibold">
                        {n.title || n.originalName}
                      </span>
                      <StatusBadge status={n.status} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                      <span>{formatDate(n.createdAt)}</span>
                      <span>{formatBytes(n.byteSize)}</span>
                      <span className="uppercase">{n.language}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Meeting note detail" aria-live="polite">
          {!selectedId ? (
            <Card className="border-dashed h-full">
              <CardContent className="flex h-full min-h-[220px] flex-col items-center justify-center py-10 text-center">
                <FileText className="mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  Select a recording to review its status and draft notes.
                </p>
              </CardContent>
            </Card>
          ) : detail.isLoading ? (
            <Card>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-32 w-full" />
              </CardContent>
            </Card>
          ) : accessBlockedAt != null ? (
            <Card className="border-red-500/30">
              <CardContent className="p-6 text-center">
                <Lock className="mx-auto mb-2 h-6 w-6 text-red-500" />
                <p
                  className="text-sm font-medium"
                  role="alert"
                  data-testid="text-meeting-access-lost"
                >
                  You no longer have access to this meeting note
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Its transcript and notes are hidden. Retry to check access again.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 gap-1.5"
                  disabled={detail.isFetching}
                  onClick={() => {
                    detail.refetch().then((r) => {
                      if (r.isSuccess && !r.isError) setAccessBlockedAt(null);
                    });
                    list.refetch();
                  }}
                  data-testid="button-retry-meeting-access"
                >
                  {detail.isFetching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : list.isError || detail.isError || !detail.data ? (
            <Card className="border-red-500/30">
              <CardContent className="p-6 text-center">
                <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-red-500" />
                <p className="text-sm font-medium">Could not load this meeting note</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(detail.error as Error)?.message ?? "Not found"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 gap-1.5"
                  onClick={() => detail.refetch()}
                  data-testid="button-retry-meeting-detail"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : (
            <NoteDetail
              note={detail.data}
              base={base}
              processing={processM.isPending && processM.variables?.id === detail.data.id}
              deleting={deleteM.isPending && deleteM.variables === detail.data.id}
              onProcess={(separateSpeakers) =>
                processM.mutate({ id: detail.data!.id, separateSpeakers })
              }
              onDelete={() => deleteM.mutate(detail.data!.id)}
              onReviewSaved={(n) => {
                qc.setQueryData(detailKey(n.id), n);
                invalidate(n.id);
              }}
              onReviewRefetch={(accessDenied) => {
                const id = detail.data!.id;
                if (accessDenied) {
                  setAccessBlockedAt(Date.now());
                  qc.removeQueries({ queryKey: detailKey(id) });
                }
                invalidate(id);
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function UploadCard({ base, onUploaded }: { base: string; onUploaded: (n: MeetingNote) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("en");
  const [consent, setConsent] = useState(false);
  const [statement, setStatement] = useState("");
  const [planned, setPlanned] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureKey, setCaptureKey] = useState(0);

  const reset = () => {
    setFile(null);
    setTitle("");
    setConsent(false);
    setStatement("");
    setPlanned("");
    setFileError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const upload = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("title", title.trim());
      fd.append("language", language);
      fd.append("consent", "true");
      fd.append("consentStatement", statement.trim());
      if (planned.trim()) fd.append("plannedQuestions", planned.trim());
      const res = await apiFetch(base, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<MeetingNote>;
    },
    onMutate: () => setError(null),
    onSuccess: (n) => {
      reset();
      setCaptureKey((k) => k + 1);
      onUploaded(n);
    },
    onError: (e: Error) => setError(e.message),
  });

  useEffect(() => {
    if (!file) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [file]);

  async function pick(f: File | null) {
    setFileError(null);
    setFile(null);
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPT_EXT.includes(ext)) {
      setFileError("Unsupported format. Use WAV, MP3, WEBM, MP4, OGG or FLAC.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setFileError(
        `File is ${formatBytes(f.size)}; the limit is 100 MB. Export compressed audio to keep the full meeting.`,
      );
      return;
    }
    setChecking(true);
    const d = await probeDuration(f);
    setChecking(false);
    if (d != null && d > MAX_SECONDS) {
      setFileError(`Recording is ${Math.ceil(d / 60)} minutes; the limit is 60 minutes.`);
      return;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  const statementOk = statement.trim().length >= MIN_STATEMENT;
  const canSubmit =
    !!file &&
    title.trim().length > 0 &&
    consent &&
    statementOk &&
    !upload.isPending &&
    !checking &&
    !captureBusy;

  return (
    <Card className="border-border/50">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Upload className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Import meeting recording</h3>
          <span className="ml-auto text-[11px] text-muted-foreground">
            WAV, MP3, WEBM, MP4, OGG, FLAC · max {MEETING_RECORDING_LIMIT_LABEL}
          </span>
        </div>
        <div className="mb-4">
          <MeetingLiveCapture
            key={captureKey}
            disabled={upload.isPending || checking}
            onBusyChange={setCaptureBusy}
            onUseRecording={(f) => {
              if (inputRef.current) inputRef.current.value = "";
              void pick(f);
            }}
          />
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) upload.mutate();
          }}
        >
          <fieldset disabled={captureBusy} className="space-y-4 disabled:opacity-60">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="mn-file">Recording file</Label>
                <Input
                  id="mn-file"
                  ref={inputRef}
                  type="file"
                  accept={ACCEPT}
                  onChange={(e) => pick(e.target.files?.[0] ?? null)}
                  data-testid="input-meeting-file"
                />
                {checking && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Checking recording length...
                  </p>
                )}
                {file && (
                  <p
                    className="text-xs text-muted-foreground flex items-center gap-1"
                    data-testid="text-meeting-file"
                  >
                    <FileAudio className="h-3 w-3" />
                    {file.name} · {formatBytes(file.size)}
                  </p>
                )}
                {fileError && (
                  <p role="alert" className="text-xs text-red-600">
                    {fileError}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mn-title">Title</Label>
                <Input
                  id="mn-title"
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Hiring manager call, round 2"
                  data-testid="input-meeting-title"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mn-lang">Spoken language</Label>
                <select
                  id="mn-lang"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  data-testid="select-meeting-language"
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
                <Label htmlFor="mn-planned" className="flex items-center gap-1.5">
                  <ListChecks className="h-3.5 w-3.5" />
                  Planned questions{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional, stored for reference only)
                  </span>
                </Label>
                <Textarea
                  id="mn-planned"
                  rows={3}
                  value={planned}
                  onChange={(e) => setPlanned(e.target.value)}
                  placeholder="One per line. Not evaluated by AI in this phase."
                  data-testid="input-meeting-planned"
                />
              </div>
            </div>

            <fieldset className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <legend className="flex items-center gap-1.5 px-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-3.5 w-3.5" />
                Recording consent
              </legend>
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id="mn-consent"
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                  className="mt-0.5"
                  data-testid="checkbox-meeting-consent"
                />
                <Label htmlFor="mn-consent" className="text-sm font-normal leading-snug">
                  I confirm every participant was told the meeting would be recorded and processed
                  by AI for transcription and summary, and each agreed.
                </Label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mn-statement">How and when was consent obtained?</Label>
                <Textarea
                  id="mn-statement"
                  rows={2}
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                  placeholder="e.g. At the start of the call on 12 May, I asked all three participants and each verbally agreed to recording and AI transcription."
                  aria-describedby="mn-statement-help"
                  data-testid="input-meeting-consent-statement"
                />
                <p
                  id="mn-statement-help"
                  className={cn(
                    "text-[11px]",
                    statement && !statementOk ? "text-red-600" : "text-muted-foreground",
                  )}
                >
                  A factual attestation of at least {MIN_STATEMENT} characters (
                  {statement.trim().length}/{MIN_STATEMENT}). Lexy records this statement but does
                  not validate it legally; you are responsible for meeting local recording laws.
                </p>
              </div>
            </fieldset>
          </fieldset>

          {error && (
            <p
              role="alert"
              className="text-sm text-red-600"
              data-testid="text-meeting-upload-error"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={!canSubmit}
              className="gap-2"
              data-testid="button-upload-meeting"
            >
              {upload.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Upload recording
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function NoteDetail({
  note,
  base,
  processing,
  deleting,
  onProcess,
  onDelete,
  onReviewSaved,
  onReviewRefetch,
}: {
  note: MeetingNote;
  base: string;
  processing: boolean;
  deleting: boolean;
  onProcess: (separateSpeakers: boolean) => void;
  onDelete: () => void;
  onReviewSaved: (n: MeetingNote) => void;
  onReviewRefetch: (accessDenied?: boolean) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [notesBusy, setNotesBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const [separateSpeakers, setSeparateSpeakers] = useState(false);
  useEffect(() => {
    setSeparateSpeakers(false);
    setDlError(null);
    setDlBusy(false);
    setNotesBusy(false);
    return () => downloadController.current?.abort();
  }, [note.id, base]);

  const isProcessing = note.status === "processing";
  const processLocked = (isProcessing && !note.canRetry) || processing;
  const processLabel = note.status === "uploaded" ? "Process recording" : "Retry processing";

  async function download(savedNotes = false) {
    const controller = new AbortController();
    downloadController.current?.abort();
    downloadController.current = controller;
    if (savedNotes) setNotesBusy(true);
    else setDlBusy(true);
    setDlError(null);
    try {
      const res = await apiFetch(
        `${base}/${encodeURIComponent(note.id)}/${savedNotes ? "notes-export" : "recording"}`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        if ([401, 403, 404].includes(res.status)) onReviewRefetch(true);
        throw new Error(await readError(res));
      }
      const blob = await res.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = savedNotes ? `meeting-notes-${note.id}.txt` : note.originalName || "recording";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!controller.signal.aborted) setDlError((e as Error).message || "Download failed");
    } finally {
      if (!controller.signal.aborted) {
        setDlBusy(false);
        setNotesBusy(false);
      }
    }
  }

  return (
    <Card className="border-border/50" data-testid={`card-meeting-note-${note.id}`}>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold" data-testid="text-meeting-title">
              {note.title}
            </h3>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{note.originalName}</span>
              <span>{note.mimeType}</span>
              <span data-testid="text-meeting-size">{formatBytes(note.byteSize)}</span>
              <span className="uppercase">{note.language}</span>
              {note.nativeSource && (
                <span data-testid="text-meeting-native-source">
                  {note.nativeSource.provider === "google_meet"
                    ? "Google Meet recording"
                    : note.nativeSource.provider === "recall"
                      ? "Lexy meeting capture"
                      : "Zoom cloud recording"}{" "}
                  · recorded {new Date(note.nativeSource.recordingStart).toLocaleString()}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDate(note.createdAt)}
              </span>
            </div>
          </div>
          <StatusBadge status={note.status} />
        </div>

        {(note.status !== "completed" || note.canRetry) && (
          <SpeakerSeparationOptIn
            checked={separateSpeakers}
            disabled={processLocked}
            onChange={setSeparateSpeakers}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {note.status !== "completed" || note.canRetry ? (
            <Button
              size="sm"
              onClick={() => onProcess(separateSpeakers)}
              disabled={processLocked}
              className="gap-1.5"
              data-testid="button-process-meeting"
            >
              {processing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : note.status === "uploaded" ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {processLabel}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => download()}
            disabled={dlBusy || notesBusy}
            className="gap-1.5"
            data-testid="button-download-meeting"
          >
            {dlBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Download recording
          </Button>
          {(note.status === "completed" || note.status === "failed") &&
            note.transcript?.trim() &&
            !note.error?.startsWith("Deletion pending.") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => download(true)}
                disabled={dlBusy || notesBusy}
                className="gap-1.5"
                data-testid="button-download-meeting-notes"
                title="Downloads saved source notes only. Unsaved edits are not included."
              >
                {notesBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                Download saved notes
              </Button>
            )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={deleting}
            className="gap-1.5 text-red-600 hover:text-red-700"
            data-testid="button-delete-meeting"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete
          </Button>
        </div>
        {(note.status === "completed" || note.status === "failed") && note.transcript?.trim() && (
          <p className="text-[11px] text-muted-foreground">
            Notes downloads include saved changes only. Keep downloaded copies private; deleting
            notes in Lexy cannot remove those copies.
          </p>
        )}
        {(note.status === "uploaded" || note.canRetry) && (
          <p className="text-[11px] text-muted-foreground">
            Processing runs transcription and summarisation, which incurs AI usage cost. It only
            runs when you click.
          </p>
        )}
        {dlError && (
          <p role="alert" className="text-xs text-red-600">
            {dlError}
          </p>
        )}

        {isProcessing && (
          <div className="flex items-start gap-2 rounded-lg border border-blue-500/25 bg-blue-500/5 p-3 text-sm">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" />
            <div>
              <p className="font-medium">
                Transcribing and summarising
                {note.processingStartedAt
                  ? ` since ${new Date(note.processingStartedAt).toLocaleTimeString()}`
                  : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Status refreshes every 3 seconds. If processing stalls for 50 minutes it becomes
                retryable.
              </p>
            </div>
          </div>
        )}
        {note.status === "failed" && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{note.error || "Processing failed."}</span>
          </div>
        )}

        {(note.summary || note.transcript) && (
          <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            AI-generated draft grounded only in the recording. Verify against the source before
            relying on it. Speakers are not identified; the capture is unlabelled.
          </div>
        )}
        {note.summary && (
          <div>
            <h4 className="mb-2 text-sm font-semibold">Summary (draft)</h4>
            <p
              className="whitespace-pre-wrap text-sm leading-relaxed"
              data-testid="text-meeting-summary"
            >
              {note.summary}
            </p>
          </div>
        )}
        {note.transcript && (
          <div>
            <h4 className="mb-2 text-sm font-semibold">Transcript (draft, unlabelled)</h4>
            <div
              className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/20 p-3 text-sm leading-relaxed"
              tabIndex={0}
              data-testid="text-meeting-transcript"
            >
              {note.transcript}
            </div>
          </div>
        )}

        {note.speakerEvidence && (
          <MeetingSpeakerEvidence
            key={`speaker-evidence-${note.id}`}
            evidence={note.speakerEvidence}
            noteId={note.id}
            base={base}
            locked={deleting || isProcessing}
            onSaved={(n) => onReviewSaved(n as MeetingNote)}
            onRefetch={onReviewRefetch}
          />
        )}

        {note.plannedQuestions?.trim() && (
          <div>
            <h4 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
              <ListChecks className="h-3.5 w-3.5" />
              Planned questions
            </h4>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Stored reference only. Coverage is not evaluated by AI in this phase.
            </p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {note.plannedQuestions}
            </p>
          </div>
        )}

        <MeetingNotesQuestionReview
          key={note.id}
          note={note}
          base={base}
          deletionPending={deleting}
          onSaved={(n) => onReviewSaved(n as MeetingNote)}
          onRefetch={onReviewRefetch}
        />

        <div className="border-t pt-3 text-[11px] text-muted-foreground">
          <span className="font-semibold">Consent recorded {formatDate(note.consentAt)}:</span>{" "}
          {note.consentStatement}
        </div>
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this meeting note?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the recording file "{note.originalName}" and its transcript,
              summary and planned questions. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-meeting">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
              data-testid="button-confirm-delete-meeting"
            >
              Delete recording and notes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
