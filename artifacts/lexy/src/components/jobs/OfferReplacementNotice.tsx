import { Button } from "@/components/ui/button";

export function OfferReplacementNotice({
  workflowId,
  preparing,
  pending,
  onPrepare,
}: {
  workflowId: string;
  preparing: boolean;
  pending: boolean;
  onPrepare: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      <p>
        The previous offer stays closed. A fresh draft creates a new version and requires separate
        human review, approval and sending. Nothing is reopened or sent automatically.
      </p>
      {preparing ? (
        <p role="status">
          Previous terms are pre-filled as a reference. Set a new future expiry and recheck the
          manual letter before saving.
        </p>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onPrepare}
          data-testid={`offer-prepare-replacement-${workflowId}`}
        >
          Prepare fresh draft
        </Button>
      )}
    </div>
  );
}
