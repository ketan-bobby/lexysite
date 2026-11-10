import { useEffect, useRef, useState } from "react";
import { apiBase, apiFetch } from "@/lib/api";
import type {
  CandidateOfferedTimes as Offered,
  OfferedTimeChoiceInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@workspace/react-hooks/use-toast";
import { readCandidateConfirmationReceipt } from "@/lib/candidate-time-confirmation";
import { offeredTimesError, parseCandidateOfferedTimes } from "@/lib/offered-times";
import { formatInterviewInstant as fmt } from "@/lib/interview-time-display";

export function CandidateOfferedTimes({
  schedule,
  onConfirmed,
}: {
  schedule: { id: string };
  onConfirmed: () => void;
}) {
  const path = `${apiBase}/portal/interview-schedules/${encodeURIComponent(schedule.id)}/offered-times`;
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState<Offered | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const lock = useRef(false);
  const readSequence = useRef(0);
  const { toast } = useToast();

  async function load() {
    if (lock.current) return;
    const sequence = ++readSequence.current;
    setLoading(true);
    setError(null);
    setOffer(null);
    setChoice(null);
    setStale(false);
    try {
      const res = await apiFetch(path);
      const body: unknown = await res.json().catch(() => null);
      if (sequence !== readSequence.current) return;
      if (!res.ok)
        throw new Error(offeredTimesError(body, "Your offered times could not be loaded."));
      setOffer(parseCandidateOfferedTimes(body, schedule.id));
    } catch (e) {
      if (sequence !== readSequence.current) return;
      setError(e instanceof Error ? e.message : "Your offered times could not be loaded.");
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !offer) return;
    let active = true;
    async function check() {
      if (lock.current) return;
      try {
        const res = await apiFetch(path);
        if (!active || lock.current) return;
        if (!res.ok)
          throw new Error("Your proposal could not be refreshed. Reload before confirming.");
        const next = parseCandidateOfferedTimes(await res.json(), schedule.id);
        if (!active || lock.current) return;
        if (next.version !== offer!.version || next.offerVersion !== offer!.offerVersion) {
          setStale(true);
          setError("Your offered times changed. Reload the times before confirming.");
        }
      } catch (failure) {
        if (!active || lock.current) return;
        setStale(true);
        setError(
          failure instanceof Error ? failure.message : "Your proposal could not be refreshed.",
        );
      }
    }
    const interval = window.setInterval(() => void check(), 30_000);
    const focus = () => void check();
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [open, offer, path, schedule.id]);

  useEffect(() => {
    if (!open) ++readSequence.current;
  }, [open]);

  async function confirm() {
    if (!offer || !choice || lock.current || stale) return;
    lock.current = true;
    setPending(true);
    try {
      const body: OfferedTimeChoiceInput = {
        confirm: true,
        expectedVersion: offer.version,
        expectedOfferVersion: offer.offerVersion,
        scheduledAt: choice,
      };
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409) setStale(true);
        throw new Error(
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : "Your confirmation could not be verified.",
        );
      }
      readCandidateConfirmationReceipt(value, {
        id: offer.scheduleId,
        scheduledAt: choice,
        duration: offer.durationMinutes,
      });
      toast({
        title: "Time confirmed in Lexy",
        description:
          "Your recruiter can see your choice. No calendar reservation or invitation was created.",
      });
      setOpen(false);
      onConfirmed();
    } catch (e) {
      setStale(true);
      setError(
        `${e instanceof Error ? e.message : "Your confirmation could not be verified."} Reload your times before trying again.`,
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Choose an interview time
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !lock.current) setOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose your interview time</DialogTitle>
            <DialogDescription>
              Confirming records your choice in Lexy only. It does not reserve a calendar event or
              send an invitation; your recruiter arranges the details.
            </DialogDescription>
          </DialogHeader>
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading your times…
            </p>
          )}
          {offer && (
            <fieldset disabled={pending} className="space-y-2">
              <legend className="text-sm font-medium mb-1">
                Offered times · {offer.durationMinutes} minutes
              </legend>
              <p className="text-xs text-muted-foreground">
                Shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}.
              </p>
              {offer.startsAt.map((t, i) => (
                <label
                  key={t}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${choice === t ? "border-primary bg-accent-soft/30" : ""}`}
                >
                  <input
                    type="radio"
                    name="offered-time"
                    checked={choice === t}
                    onChange={() => setChoice(t)}
                  />
                  <span>
                    {fmt(t)}
                    {i === 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">Original time</span>
                    )}
                  </span>
                </label>
              ))}
              {offer.expiresAt && (
                <p className="text-xs text-muted-foreground">
                  These options expire {fmt(offer.expiresAt)}.
                </p>
              )}
            </fieldset>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {offer && (
              <Button disabled={!choice || pending || stale} onClick={() => void confirm()}>
                {pending ? "Confirming…" : "Confirm this time"}
              </Button>
            )}
            {(error || stale) && (
              <Button variant="outline" disabled={pending} onClick={() => void load()}>
                Reload times
              </Button>
            )}
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
          {pending && (
            <p role="status" className="text-sm">
              Waiting for Lexy confirmation…
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
