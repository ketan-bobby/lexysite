import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase, apiFetch } from "@/lib/api";
import type { OfferedTimesInput, StaffOfferedTimes } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@workspace/react-hooks/use-toast";
import { BookingLinkControls } from "@/components/scheduling/BookingLinkControls";
import { Clock, Plus, X } from "lucide-react";
import {
  MAX_ALTERNATIVES,
  normalizeAlternatives,
  parseStaffOfferedTimes,
  toLocalInput,
  verifyPublished,
} from "@/lib/offered-times";

import { formatInterviewInstant as fmt } from "@/lib/interview-time-display";

export function OfferedTimesDialog({
  scheduleId,
  onClose,
  onPublished,
}: {
  scheduleId: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const { toast } = useToast();
  const path = `${apiBase}/coordinator/schedules/${encodeURIComponent(scheduleId)}/offered-times`;
  const [current, setCurrent] = useState<StaffOfferedTimes | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [newer, setNewer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mustReload, setMustReload] = useState(false);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const readSequence = useRef(0);
  const dirtyRef = useRef(false);
  const currentRef = useRef<StaffOfferedTimes | null>(null);
  dirtyRef.current = dirty;
  currentRef.current = current;

  const load = useCallback(
    async (manual: boolean) => {
      if (lock.current) return;
      const sequence = ++readSequence.current;
      try {
        const res = await apiFetch(path);
        const body: unknown = await res.json().catch(() => null);
        if (lock.current || sequence !== readSequence.current) return;
        if (!res.ok) {
          const msg =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : "Offered times could not be loaded.";
          throw new Error(msg);
        }
        const next = parseStaffOfferedTimes(body, scheduleId);
        const prev = currentRef.current;
        const changed =
          !prev ||
          prev.version !== next.version ||
          prev.proposal.offerVersion !== next.proposal.offerVersion;
        if (!dirtyRef.current || manual) {
          setCurrent(next);
          setDraft(next.proposal.startsAt.slice(1).map(toLocalInput));
          setDirty(false);
          setNewer(false);
          setSaveError(null);
          setMustReload(false);
        } else if (changed) setNewer(true);
        setLoadError(null);
      } catch (e) {
        if (sequence !== readSequence.current) return;
        setLoadError(e instanceof Error ? e.message : "Offered times could not be loaded.");
      } finally {
        if (sequence === readSequence.current) setLoading(false);
      }
    },
    [path, scheduleId],
  );

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => void load(false), 30_000);
    const onFocus = () => void load(false);
    window.addEventListener("focus", onFocus);
    return () => {
      ++readSequence.current;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const normalized = current
    ? normalizeAlternatives(
        draft,
        current.proposal.scheduledAt,
        Date.now(),
        current.proposal.startsAt.slice(1),
      )
    : null;
  const blocked =
    !current ||
    newer ||
    mustReload ||
    saving ||
    Boolean(loadError) ||
    (normalized ? !normalized.ok : true);

  async function publish() {
    if (lock.current || blocked || !current || !normalized?.ok) return;
    ++readSequence.current;
    lock.current = true;
    setSaving(true);
    setSaveError(null);
    const sent = normalized.value;
    try {
      const body: OfferedTimesInput = {
        expectedVersion: current.version,
        expectedOfferVersion: current.proposal.offerVersion,
        alternatives: sent,
      };
      const res = await apiFetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let value: unknown;
      try {
        value = await res.json();
      } catch {
        value = null;
      }
      if (!res.ok) {
        const msg =
          value &&
          typeof value === "object" &&
          "error" in value &&
          typeof (value as { error: unknown }).error === "string"
            ? (value as { error: string }).error
            : "The server did not confirm this request.";
        throw new Error(msg);
      }
      const saved = verifyPublished(value, scheduleId, sent, current);
      setCurrent(saved);
      setDraft(saved.proposal.startsAt.slice(1).map(toLocalInput));
      setDirty(false);
      toast({
        title: sent.length ? "Times offered in Lexy" : "Alternatives withdrawn",
        description:
          "Native schedule unchanged. No calendar reservation, invitation or email was sent.",
      });
      onPublished();
    } catch (e) {
      setMustReload(true);
      setSaveError(
        `${e instanceof Error ? e.message : "The request failed."} The result is uncertain: load the latest times before trying again.`,
      );
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  const edit = (next: string[]) => {
    setDraft(next);
    setDirty(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" /> Offer alternative times
          </DialogTitle>
          <DialogDescription>
            The original time stays offered. Alternatives are shown only to this candidate and
            expire no later than the earliest proposed time or 7 days. Availability is NOT checked.
            Confirmation is native to Lexy only: no calendar reservation, invitation or email is
            created.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-2" role="status" aria-label="Loading">
            <div className="h-10 rounded-lg skeleton-shimmer" />
            <div className="h-10 rounded-lg skeleton-shimmer" />
          </div>
        )}
        {loadError && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
          >
            <p>{loadError}</p>
            {!current && (
              <p className="text-muted-foreground">
                Times can only be edited while the schedule is pending.
              </p>
            )}
            <Button size="sm" variant="outline" onClick={() => void load(true)}>
              Reload
            </Button>
          </div>
        )}

        {current && (
          <div className="space-y-4">
            <div className="rounded-lg border p-3 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Original time
              </p>
              <p>
                {fmt(current.proposal.scheduledAt)} · {current.proposal.durationMinutes} minutes
              </p>
              {current.proposal.expiresAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  Current offer expires {fmt(current.proposal.expiresAt)}
                </p>
              )}
            </div>
            {newer && (
              <div role="alert" className="rounded-lg border p-3 text-sm space-y-2">
                <p>
                  A newer version exists. Your draft is kept, but you must load the latest before
                  publishing.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void load(true)}
                >
                  Load latest (discard draft)
                </Button>
              </div>
            )}
            <fieldset className="space-y-2" disabled={saving}>
              <legend className="text-sm font-medium mb-1">
                Alternatives ({draft.length} of {MAX_ALTERNATIVES})
              </legend>
              {current.proposal.startsAt.length > 1 && (
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Currently published alternatives (not unsaved changes):</p>
                  <ul className="list-disc pl-4">
                    {current.proposal.startsAt.slice(1).map((time) => (
                      <li key={time}>{fmt(time)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Times use your browser’s time zone:{" "}
                {Intl.DateTimeFormat().resolvedOptions().timeZone}.
              </p>
              {draft.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No alternatives. Publishing now withdraws any offered alternatives.
                </p>
              )}
              {draft.map((value, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="datetime-local"
                    aria-label={`Alternative ${i + 1}`}
                    value={value}
                    onChange={(e) => edit(draft.map((d, j) => (j === i ? e.target.value : d)))}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove alternative ${i + 1}`}
                    onClick={() => edit(draft.filter((_, j) => j !== i))}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={draft.length >= MAX_ALTERNATIVES}
                onClick={() => edit([...draft, ""])}
              >
                <Plus className="w-3.5 h-3.5" /> Add alternative
              </Button>
            </fieldset>
            {normalized && !normalized.ok && draft.length > 0 && (
              <p role="alert" className="text-sm text-destructive">
                {normalized.error}
              </p>
            )}
            {saveError && (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
              >
                <p>{saveError}</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void load(true)}
                >
                  Load latest
                </Button>
              </div>
            )}
            {saving && (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for Lexy to confirm…
              </p>
            )}
            <BookingLinkControls
              scheduleId={scheduleId}
              offer={current}
              blocked={blocked || dirty}
              onChanged={onPublished}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={saving} onClick={onClose}>
                Close
              </Button>
              <Button
                disabled={
                  blocked ||
                  (!dirty &&
                    draft.length === current.proposal.startsAt.length - 1 &&
                    !mustReload &&
                    draft.length === 0)
                }
                onClick={() => void publish()}
              >
                {saving
                  ? "Publishing…"
                  : draft.length === 0
                    ? "Withdraw alternatives"
                    : "Publish times"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
