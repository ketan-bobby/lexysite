import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function OfferDraftConflict({
  workflowId,
  pending,
  onKeep,
  onDiscard,
  children,
}: {
  workflowId: string;
  pending: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      data-testid={`offer-draft-conflict-${workflowId}`}
    >
      <p className="font-medium">The saved offer changed while you were editing.</p>
      <p className="text-xs">
        Your unsaved edits are preserved. Compare them with the current saved terms below before
        choosing. Saving, approving and sending are blocked until you resolve this conflict. Keeping
        edits does not save, approve or send anything.
      </p>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onKeep}
          data-testid={`offer-draft-keep-${workflowId}`}
        >
          Keep my edits for a new draft
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onDiscard}
          data-testid={`offer-draft-load-latest-${workflowId}`}
        >
          Discard my edits and load latest
        </Button>
      </div>
    </div>
  );
}
