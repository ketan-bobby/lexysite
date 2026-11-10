/**
 * MeetingNotesQuestionReview — staff-entered coverage notes for planned
 * questions on a meeting note. Purely manual: nothing here is detected,
 * attributed to speakers, approved or scored automatically.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { AlertTriangle, ClipboardCheck, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import type {
  MeetingQuestionReview,
  MeetingQuestionReviewEntry,
  MeetingQuestionReviewEntryStatus,
} from "@workspace/api-client-react";

export type QuestionReviewStatus = MeetingQuestionReviewEntryStatus;
export type QuestionReviewEntry = MeetingQuestionReviewEntry;
export type QuestionReview = MeetingQuestionReview;

/** Minimal note shape this component needs (structurally compatible with MeetingNote). */
export interface QuestionReviewNote {
  id: string;
  status: "uploaded" | "processing" | "completed" | "failed";
  transcript: string | null;
  plannedQuestions: string;
  transcriptHash: string | null;
  questionReview: QuestionReview | null;
}

type DraftStatus = "" | QuestionReviewStatus;
interface DraftRow {
  status: DraftStatus;
  excerpt: string;
  note: string;
}

const MAX_EXCERPT = 2000;
const MAX_NOTE = 1000;

const STATUS_OPTIONS: { value: DraftStatus; label: string }[] = [
  { value: "", label: "Unreviewed" },
  { value: "covered", label: "Covered" },
  { value: "partial", label: "Partly covered" },
  { value: "not_covered", label: "Not covered" },
];

export function parsePlannedQuestions(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    if (n > 1) return n;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

function draftFrom(note: QuestionReviewNote, count: number): DraftRow[] {
  const rows: DraftRow[] = Array.from({ length: count }, () => ({
    status: "",
    excerpt: "",
    note: "",
  }));
  for (const e of note.questionReview?.entries ?? []) {
    if (e.questionIndex >= 0 && e.questionIndex < count) {
      rows[e.questionIndex] = { status: e.status, excerpt: e.excerpt ?? "", note: e.note ?? "" };
    }
  }
  return rows;
}

function sameRows(a: DraftRow[], b: DraftRow[]) {
  return (
    a.length === b.length &&
    a.every(
      (r, i) => r.status === b[i].status && r.excerpt === b[i].excerpt && r.note === b[i].note,
    )
  );
}

function rowError(r: DraftRow, transcript: string): string | null {
  if (r.note.length > MAX_NOTE) return `Comment must be ${MAX_NOTE} characters or fewer.`;
  if (r.status === "not_covered") {
    return r.excerpt.trim() ? "Clear the excerpt for “Not covered”." : null;
  }
  if (r.status === "covered" || r.status === "partial") {
    const ex = r.excerpt.trim();
    if (!ex) return "Paste a verbatim excerpt from the transcript.";
    if (ex.length > MAX_EXCERPT) return `Excerpt must be ${MAX_EXCERPT} characters or fewer.`;
    const c = countOccurrences(transcript, ex);
    if (c === 0) return "Excerpt not found verbatim in the transcript.";
    if (c > 1) return "Excerpt appears more than once; include more surrounding words.";
  }
  return null;
}

async function readBody(res: Response): Promise<string> {
  try {
    const j = await res.json();
    const base = j?.error || j?.message || `Request failed (${res.status})`;
    const details = Array.isArray(j?.details)
      ? j.details
          .map((d: unknown) => (typeof d === "string" ? d : (d as { message?: string })?.message))
          .filter(Boolean)
      : [];
    return details.length ? `${base}: ${details.join("; ")}` : base;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function MeetingNotesQuestionReview({
  note,
  base,
  deletionPending = false,
  onSaved,
  onRefetch,
}: {
  note: QuestionReviewNote;
  base: string;
  deletionPending?: boolean;
  onSaved: (updated: QuestionReviewNote) => void;
  /** accessDenied=true: parent must immediately hide all private note material. */
  onRefetch: (accessDenied?: boolean) => void;
}) {
  const questions = useMemo(
    () => parsePlannedQuestions(note.plannedQuestions),
    [note.plannedQuestions],
  );
  const transcript = note.transcript ?? "";
  const savedRevision = note.questionReview?.revision ?? null;

  const [rows, setRows] = useState<DraftRow[]>(() => draftFrom(note, questions.length));
  const baseline = useRef({
    hash: note.transcriptHash,
    revision: savedRevision,
    rows: draftFrom(note, questions.length),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const clearIntent = useRef<{ hash: string | null; revision: string | null } | null>(null);

  const dirty = !sameRows(rows, baseline.current.rows);
  const serverMoved =
    note.transcriptHash !== baseline.current.hash || savedRevision !== baseline.current.revision;

  const adopt = () => {
    const fresh = draftFrom(note, questions.length);
    baseline.current = { hash: note.transcriptHash, revision: savedRevision, rows: fresh };
    setRows(fresh);
    setConflict(null);
    setError(null);
  };
  const adoptRef = useRef(adopt);
  adoptRef.current = adopt;

  // Server data changed: adopt silently when clean; otherwise leave the edits and block save.
  useEffect(() => {
    if (!dirty && serverMoved) adoptRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.transcriptHash, savedRevision]);

  const statusNum = note.status;
  const locked = deletionPending || statusNum === "processing" || statusNum === "uploaded";
  const errors = rows.map((r) => rowError(r, transcript));
  const reviewedCount = rows.filter((r) => r.status).length;
  const hasErrors = errors.some(Boolean);
  const blocked = dirty && serverMoved;

  async function put(
    entries: {
      questionIndex: number;
      status: QuestionReviewStatus;
      excerpt: string;
      note: string;
    }[],
  ) {
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(note.id)}/question-review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceHash: note.transcriptHash,
          previousRevision: note.questionReview?.revision ?? null,
          entries,
        }),
      });
      if (res.status === 409) {
        setConflict(
          (await readBody(res)) +
            " — the transcript or saved review changed since you opened it. Your edits are kept; reload the latest version to continue.",
        );
        onRefetch();
        return;
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        onRefetch(true);
        return;
      }
      if (!res.ok) {
        setError(await readBody(res));
        return;
      }
      const updated = (await res.json()) as QuestionReviewNote;
      const fresh = draftFrom(updated, questions.length);
      baseline.current = {
        hash: updated.transcriptHash,
        revision: updated.questionReview?.revision ?? null,
        rows: fresh,
      };
      setRows(fresh);
      onSaved(updated);
    } catch (e) {
      setError((e as Error).message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (hasErrors || blocked || locked) return;
    put(
      rows.flatMap((r, i) =>
        r.status
          ? [
              {
                questionIndex: i,
                status: r.status,
                excerpt: r.status === "not_covered" ? "" : r.excerpt.trim(),
                note: r.note,
              },
            ]
          : [],
      ),
    );
  }

  const update = (i: number, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const header = (
    <div className="mb-2">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        <ClipboardCheck className="h-3.5 w-3.5" />
        Planned question review
      </h4>
      <p className="text-[11px] text-muted-foreground">
        Staff coverage notes—not a hiring assessment. Entered manually by staff; nothing is
        detected, attributed to speakers, approved or scored automatically.
      </p>
    </div>
  );

  if (questions.length === 0) {
    return (
      <section data-testid="section-question-review">
        {header}
        <p
          className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
          data-testid="text-review-no-questions"
        >
          No planned questions were stored with this recording, so there is nothing to review.
        </p>
      </section>
    );
  }
  if (locked || !note.transcript || !note.transcriptHash) {
    return (
      <section data-testid="section-question-review">
        {header}
        <p
          className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
          data-testid="text-review-unavailable"
        >
          {deletionPending
            ? "Review is unavailable while this note is being deleted."
            : statusNum === "processing"
              ? "Review becomes available once processing finishes."
              : statusNum === "uploaded"
                ? "Process the recording first; review needs a transcript."
                : "No transcript is available, so excerpts cannot be checked."}
        </p>
      </section>
    );
  }

  const qr = note.questionReview;
  return (
    <section data-testid="section-question-review">
      {header}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" className="text-[10px]" data-testid="text-review-count">
          {reviewedCount}/{questions.length} reviewed
        </Badge>
        {qr ? (
          <span data-testid="text-review-saved">
            Last saved by {qr.reviewedBy} · {formatDate(qr.reviewedAt)} · {qr.entries.length} saved
          </span>
        ) : (
          <span>Not saved yet</span>
        )}
        {dirty && <span className="font-medium text-foreground">Unsaved changes</span>}
      </div>

      {blocked && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
          data-testid="alert-review-stale"
        >
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            The transcript or saved review changed while you were editing. Saving is blocked.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 gap-1.5"
            onClick={adopt}
            data-testid="button-review-reload"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Discard my edits and load latest
          </Button>
        </div>
      )}
      {conflict && !blocked && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
          data-testid="alert-review-conflict"
        >
          <p>{conflict}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 gap-1.5"
            onClick={() => onRefetch()}
            data-testid="button-review-refetch"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Check for latest
          </Button>
        </div>
      )}

      <ol className="space-y-3">
        {questions.map((q, i) => {
          const r = rows[i];
          const err = errors[i];
          const id = `qr-${note.id}-${i}`;
          const needsExcerpt = r.status === "covered" || r.status === "partial";
          return (
            <li
              key={i}
              className="rounded-lg border border-border/60 p-3"
              data-testid={`row-review-question-${i}`}
            >
              <p className="mb-2 text-sm font-medium" id={`${id}-q`}>
                {i + 1}. {q}
              </p>
              <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-status`} className="text-xs">
                    Staff status
                  </Label>
                  <select
                    id={`${id}-status`}
                    aria-describedby={`${id}-q`}
                    value={r.status}
                    disabled={saving}
                    onChange={(e) => {
                      const status = e.target.value as DraftStatus;
                      update(i, {
                        status,
                        ...(!status || status === "not_covered" ? { excerpt: "" } : {}),
                      });
                    }}
                    data-testid={`select-review-status-${i}`}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-3">
                  {(r.status !== "" && r.status !== "not_covered") || r.excerpt ? (
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-excerpt`} className="text-xs">
                        Verbatim excerpt
                      </Label>
                      <Textarea
                        id={`${id}-excerpt`}
                        rows={2}
                        value={r.excerpt}
                        disabled={saving}
                        maxLength={MAX_EXCERPT + 200}
                        onChange={(e) => update(i, { excerpt: e.target.value })}
                        aria-invalid={!!err && needsExcerpt}
                        aria-describedby={`${id}-help`}
                        data-testid={`input-review-excerpt-${i}`}
                      />
                      <p id={`${id}-help`} className="text-[11px] text-muted-foreground">
                        Copy exact text from the transcript (once-only match, max {MAX_EXCERPT}).{" "}
                        {r.excerpt.length}/{MAX_EXCERPT}
                      </p>
                    </div>
                  ) : null}
                  {r.status && (
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-note`} className="text-xs">
                        Staff comment (optional)
                      </Label>
                      <Textarea
                        id={`${id}-note`}
                        rows={2}
                        value={r.note}
                        disabled={saving}
                        onChange={(e) => update(i, { note: e.target.value })}
                        data-testid={`input-review-note-${i}`}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {r.note.length}/{MAX_NOTE}
                      </p>
                    </div>
                  )}
                  {err && (
                    <p
                      role="alert"
                      className="text-xs text-red-600"
                      data-testid={`text-review-error-${i}`}
                    >
                      {err}
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600" data-testid="text-review-save-error">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {qr && (
          <Button
            size="sm"
            variant="outline"
            disabled={saving || blocked}
            onClick={() => {
              clearIntent.current = { hash: note.transcriptHash, revision: savedRevision };
              setClearOpen(true);
            }}
            className="gap-1.5 text-red-600 hover:text-red-700"
            data-testid="button-review-clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear saved review
          </Button>
        )}
        {dirty && !blocked && (
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={adopt}
            data-testid="button-review-discard"
          >
            Discard changes
          </Button>
        )}
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || saving || hasErrors || blocked}
          className={cn("gap-1.5")}
          data-testid="button-review-save"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save coverage notes
        </Button>
      </div>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the saved coverage notes?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes every saved status, excerpt and comment for this recording's planned
              questions. The transcript itself is not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-review-clear-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                setClearOpen(false);
                if (
                  clearIntent.current?.hash !== note.transcriptHash ||
                  clearIntent.current?.revision !== savedRevision
                ) {
                  setConflict(
                    "The transcript or review changed while confirmation was open. Check the latest version before clearing.",
                  );
                  onRefetch();
                  return;
                }
                put([]);
              }}
              data-testid="button-review-clear-confirm"
            >
              Clear review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export default MeetingNotesQuestionReview;
