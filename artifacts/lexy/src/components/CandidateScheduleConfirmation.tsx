import { useRef, useState } from "react";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@workspace/react-hooks/use-toast";
import type { CandidateTimeConfirmationInput } from "@workspace/api-client-react";
import { readCandidateConfirmationReceipt } from "@/lib/candidate-time-confirmation";

interface ProposedTime {
  id: string;
  scheduledAt: string;
  duration?: number | null;
  confirmationVersion: string;
}

export function CandidateScheduleConfirmation({
  schedule,
  onConfirmed,
}: {
  schedule: ProposedTime;
  onConfirmed: () => void;
}) {
  const [review, setReview] = useState<ProposedTime | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const { toast } = useToast();

  async function confirm() {
    if (!review || lock.current || error) return;
    lock.current = true;
    setPending(true);
    try {
      const body: CandidateTimeConfirmationInput = {
        confirm: true,
        expectedVersion: review.confirmationVersion,
      };
      const response = await apiFetch(
        `${apiBase}/portal/interview-schedules/${encodeURIComponent(review.id)}/confirmation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const value: unknown = await response.json();
      if (!response.ok) {
        const message =
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : "Your confirmation could not be verified.";
        throw new Error(message);
      }
      readCandidateConfirmationReceipt(value, review);
      toast({
        title: "Proposed time confirmed in Lexy",
        description:
          "Your recruiter can see your confirmation. No calendar reservation or invitation was created.",
      });
      setReview(null);
      onConfirmed();
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : "Your confirmation could not be verified."} Reload your interviews before trying again.`,
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
          setReview({ ...schedule });
          setError(null);
        }}
      >
        Confirm proposed time
      </Button>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !lock.current) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm this proposed interview time?</DialogTitle>
            <DialogDescription>
              This confirms the recruiter’s proposed time in Lexy only. It does not reserve an
              Outlook event or send an invitation. Your recruiter will arrange the calendar details.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <p>
              {new Date(review.scheduledAt).toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "short",
              })}{" "}
              · {review.duration} minutes
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || Boolean(error)} onClick={confirm}>
              {pending ? "Confirming…" : "Confirm this time"}
            </Button>
            {error && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setReview(null);
                  onConfirmed();
                }}
              >
                Reload interviews
              </Button>
            )}
            <Button variant="ghost" disabled={pending} onClick={() => setReview(null)}>
              Close
            </Button>
          </div>
          {pending && <p role="status">Waiting for Lexy confirmation…</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
