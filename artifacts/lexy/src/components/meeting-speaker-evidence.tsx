/**
 * MeetingSpeakerEvidence — opt-in anonymous speaker grouping controls,
 * read-only segment rendering, and explicit HUMAN label review.
 * Groups are machine-estimated and anonymous. Labels are entered by staff
 * only; nothing is prefilled from AI, verified as identity, or scored.
 */
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Loader2, Pencil, Save, Trash2, UserCheck, Users } from "lucide-react";
import { formatDate } from "@/lib/utils";

export interface SpeakerSegment {
  speaker: number;
  start: number;
  end: number;
  text: string;
}
export type SpeakerRole = "candidate" | "interviewer" | "other" | "unknown";
export interface SpeakerLabel {
  speaker: number;
  label: string;
  role: SpeakerRole;
}
export interface SpeakerReview {
  revision: string;
  reviewedBy: string;
  reviewedAt: string;
  labels: SpeakerLabel[];
}
export interface SpeakerEvidence {
  revision: string;
  generatedAt: string;
  provider: "deepgram";
  model: string;
  segments: SpeakerSegment[];
  review?: SpeakerReview | null;
}

const MAX_LABEL = 80;
const ROLES: { value: SpeakerRole; label: string }[] = [
  { value: "unknown", label: "Unknown" },
  { value: "candidate", label: "Candidate" },
  { value: "interviewer", label: "Interviewer" },
  { value: "other", label: "Other" },
];
const ROLE_NAME: Record<SpeakerRole, string> = {
  unknown: "unknown role",
  candidate: "candidate",
  interviewer: "interviewer",
  other: "other",
};

function ts(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const anon = (speaker: number) => `Speaker ${speaker + 1}`;

const TONES = [
  "border-l-sky-500",
  "border-l-amber-500",
  "border-l-emerald-500",
  "border-l-rose-500",
  "border-l-violet-500",
  "border-l-teal-500",
];

async function readBody(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error || j?.message || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function SpeakerSeparationOptIn({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3"
      data-testid="section-speaker-optin"
    >
      <Checkbox
        id="mn-separate-speakers"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
        data-testid="checkbox-separate-speakers"
      />
      <div className="min-w-0">
        <Label htmlFor="mn-separate-speakers" className="text-sm font-medium leading-snug">
          Also separate anonymous speakers (optional)
        </Label>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Sends this recording to the configured Deepgram transcription model to group speech into
          anonymous "Speaker 1, Speaker 2" segments. Grouping can be wrong (merged or split voices).
          It does not identify who anyone is and is never used for scoring. Unsupported languages
          return an error rather than falling back.
        </p>
      </div>
    </div>
  );
}

export function MeetingSpeakerEvidence({
  evidence,
  noteId,
  base,
  locked = false,
  onSaved,
  onRefetch,
}: {
  evidence: SpeakerEvidence;
  noteId: string;
  base: string;
  locked?: boolean;
  /** Receives the full updated MeetingNote DTO. */
  onSaved: (updated: unknown) => void;
  /** accessDenied=true: parent must immediately hide all private note material. */
  onRefetch: (accessDenied?: boolean) => void;
}) {
  const speakers = Array.from(new Set(evidence.segments.map((s) => s.speaker))).sort(
    (a, b) => a - b,
  );
  const review = evidence.review ?? null;
  const saved = new Map((review?.labels ?? []).map((l) => [l.speaker, l]));
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section data-testid="section-speaker-evidence">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <Users className="h-3.5 w-3.5" />
          Speaker segments (draft)
        </h4>
        <Badge variant="outline" className="text-[10px]" data-testid="text-speaker-count">
          {speakers.length} speaker group{speakers.length === 1 ? "" : "s"}
        </Badge>
        {review && review.labels.length > 0 && (
          <Badge
            variant="outline"
            className="gap-1 border-emerald-500/30 bg-emerald-500/5 text-[10px] text-emerald-700"
            data-testid="badge-speaker-reviewed"
          >
            <UserCheck className="h-2.5 w-2.5" />
            Staff-reviewed labels
          </Badge>
        )}
      </div>
      <p
        className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] leading-relaxed text-muted-foreground"
        data-testid="text-speaker-limitation"
      >
        Source material only. Groups are machine-estimated by {evidence.provider} {evidence.model}{" "}
        on {formatDate(evidence.generatedAt)} and may be wrong. "Speaker N" is an anonymous label,
        not a verified participant identity, and nothing here is scored.
        {review && review.labels.length > 0 && (
          <span data-testid="text-speaker-review-source">
            {" "}
            Names and roles shown were entered by staff ({review.reviewedBy},{" "}
            {formatDate(review.reviewedAt)}) after checking the recording; they are a manual
            annotation, not AI output.
          </span>
        )}
      </p>

      {notice && (
        <p
          role="alert"
          className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs"
          data-testid="text-speaker-review-conflict"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          {notice}
        </p>
      )}

      {editing && !locked ? (
        <SpeakerReviewEditor
          key={`${evidence.revision}:${review?.revision ?? "none"}`}
          evidence={evidence}
          speakers={speakers}
          noteId={noteId}
          base={base}
          onCancel={() => setEditing(false)}
          onSaved={(n) => {
            setEditing(false);
            setNotice(null);
            onSaved(n);
          }}
          onConflict={(msg) => {
            setEditing(false);
            setNotice(msg);
            onRefetch();
          }}
          onDenied={() => {
            setEditing(false);
            onRefetch(true);
          }}
        />
      ) : (
        speakers.length > 0 && (
          <div className="mb-2 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={locked}
              onClick={() => {
                setNotice(null);
                setEditing(true);
              }}
              data-testid="button-speaker-review-edit"
            >
              <Pencil className="h-3.5 w-3.5" />
              {review && review.labels.length > 0 ? "Edit speaker labels" : "Label speakers"}
            </Button>
          </div>
        )
      )}

      {evidence.segments.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
          data-testid="text-speaker-empty"
        >
          No speech segments were returned for this recording.
        </p>
      ) : (
        <ol
          className="max-h-96 space-y-1.5 overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-2"
          tabIndex={0}
        >
          {evidence.segments.map((s, i) => {
            const l = saved.get(s.speaker);
            return (
              <li
                key={i}
                className={`rounded-md border-l-2 bg-background/60 px-2.5 py-1.5 ${TONES[Math.abs(s.speaker) % TONES.length]}`}
                data-testid={`row-speaker-segment-${i}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
                  <span
                    className="font-semibold text-foreground"
                    data-testid={`text-speaker-label-${i}`}
                  >
                    {l ? l.label : anon(s.speaker)}
                  </span>
                  {l && (
                    <span data-testid={`text-speaker-role-${i}`}>
                      {ROLE_NAME[l.role]} · staff label for {anon(s.speaker)}
                    </span>
                  )}
                  <span className="font-mono tabular-nums">
                    {ts(s.start)}–{ts(s.end)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{s.text}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function SpeakerReviewEditor({
  evidence,
  speakers,
  noteId,
  base,
  onCancel,
  onSaved,
  onConflict,
  onDenied,
}: {
  evidence: SpeakerEvidence;
  speakers: number[];
  noteId: string;
  base: string;
  onCancel: () => void;
  onSaved: (n: unknown) => void;
  onConflict: (msg: string) => void;
  onDenied: () => void;
}) {
  const review = evidence.review ?? null;
  const [rows, setRows] = useState<SpeakerLabel[]>(() =>
    speakers.map((sp) => {
      const l = review?.labels.find((x) => x.speaker === sp);
      // Anonymous/unknown defaults only; never prefilled from AI.
      return l ? { ...l } : { speaker: sp, label: anon(sp), role: "unknown" };
    }),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = rows.some((r) => {
    const t = r.label.trim();
    return t.length < 1 || t.length > MAX_LABEL;
  });

  async function put(labels: SpeakerLabel[]) {
    if (!confirmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(noteId)}/speaker-review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRevision: evidence.revision,
          previousRevision: review?.revision ?? null,
          confirm: true,
          labels,
        }),
      });
      if (res.status === 409) {
        onConflict(
          `${await readBody(res)}. The speaker segments or saved labels changed since you opened them. Your unsaved labels were discarded; showing the latest confirmed labels.`,
        );
        return;
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        onDenied();
        return;
      }
      if (!res.ok) {
        setError(await readBody(res));
        return;
      }
      onSaved(await res.json());
    } catch (e) {
      setError((e as Error).message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const update = (i: number, patch: Partial<SpeakerLabel>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div
      className="mb-3 space-y-3 rounded-lg border border-border/60 p-3"
      data-testid="form-speaker-review"
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Optionally replace anonymous groups with names or roles you have verified by listening to
        the recording. Defaults stay anonymous and unknown. Labels are staff annotations, not
        identity verification, and are not scored.
      </p>
      <fieldset disabled={saving} className="space-y-2">
        {rows.map((r, i) => {
          const id = `spk-${noteId}-${r.speaker}`;
          const len = r.label.trim().length;
          return (
            <div
              key={r.speaker}
              className="grid gap-2 sm:grid-cols-[90px_minmax(0,1fr)_150px] sm:items-end"
              data-testid={`row-speaker-review-${r.speaker}`}
            >
              <span className="text-xs font-semibold sm:pb-2">{anon(r.speaker)}</span>
              <div className="space-y-1">
                <Label htmlFor={`${id}-label`} className="text-xs">
                  Label
                </Label>
                <Input
                  id={`${id}-label`}
                  value={r.label}
                  maxLength={MAX_LABEL + 20}
                  aria-invalid={len < 1 || len > MAX_LABEL}
                  onChange={(e) => update(i, { label: e.target.value })}
                  data-testid={`input-speaker-label-${r.speaker}`}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-role`} className="text-xs">
                  Role
                </Label>
                <select
                  id={`${id}-role`}
                  value={r.role}
                  onChange={(e) => update(i, { role: e.target.value as SpeakerRole })}
                  data-testid={`select-speaker-role-${r.speaker}`}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {ROLES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
        {invalid && (
          <p role="alert" className="text-xs text-red-600" data-testid="text-speaker-label-invalid">
            Each label needs 1 to {MAX_LABEL} characters.
          </p>
        )}
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <Checkbox
            id={`spk-confirm-${noteId}`}
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
            className="mt-0.5"
            data-testid="checkbox-speaker-review-confirm"
          />
          <Label htmlFor={`spk-confirm-${noteId}`} className="text-xs font-normal leading-snug">
            I checked these labels against the recording myself. They are my annotation, not an
            identity verification or assessment.
          </Label>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-red-600" data-testid="text-speaker-review-error">
          {error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {review && review.labels.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={!confirmed || saving}
            onClick={() => put([])}
            className="gap-1.5 text-red-600 hover:text-red-700"
            data-testid="button-speaker-review-clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear labels
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
          data-testid="button-speaker-review-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!confirmed || saving || invalid}
          onClick={() => put(rows.map((r) => ({ ...r, label: r.label.trim() })))}
          className="gap-1.5"
          data-testid="button-speaker-review-save"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save speaker labels
        </Button>
      </div>
    </div>
  );
}

export default MeetingSpeakerEvidence;
