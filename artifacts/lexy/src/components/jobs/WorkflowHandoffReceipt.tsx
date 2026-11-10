import { useEffect, useState } from "react";
import type { AtsHandoffPacket } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function WorkflowHandoffReceipt({
  packet,
  workflowId,
  enabled,
  onRecord,
}: {
  packet: Pick<
    AtsHandoffPacket,
    "id" | "snapshotHash" | "approvedAt" | "exportedAt" | "handoffReceipt"
  >;
  workflowId: string;
  enabled: boolean;
  onRecord: (reference: string) => void;
}) {
  const [reference, setReference] = useState("");
  const [ack, setAck] = useState(false);
  useEffect(() => {
    setReference("");
    setAck(false);
  }, [packet.id, packet.snapshotHash, enabled]);
  if (packet.handoffReceipt)
    return (
      <p role="status" className="text-xs" data-testid={`ats-handoff-receipt-${workflowId}`}>
        Human-reported manual handoff: {packet.handoffReceipt.evidenceReference}, recorded by{" "}
        {packet.handoffReceipt.recordedBy} on{" "}
        {new Date(packet.handoffReceipt.recordedAt).toLocaleString()}. Not verified ATS receipt or
        offer delivery.
      </p>
    );
  if (!packet.exportedAt || !packet.approvedAt) return null;
  return (
    <div className="space-y-2 border-t pt-2">
      <label className="block">
        Non-sensitive handoff case reference
        <input
          className="mt-1 block w-full rounded border bg-background px-2 py-1"
          value={reference}
          maxLength={120}
          onChange={(e) => setReference(e.target.value)}
          disabled={!enabled}
          data-testid={`ats-handoff-receipt-reference-${workflowId}`}
        />
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          disabled={!enabled}
          data-testid={`ats-handoff-receipt-ack-${workflowId}`}
        />
        I manually handed this exact reviewed packet to the employer's designated offer owner. This
        does not verify ATS receipt, approve terms or send an offer.
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled || !ack || !/^[A-Za-z0-9_.:-]{3,120}$/.test(reference)}
        onClick={() => {
          setAck(false);
          onRecord(reference);
        }}
        data-testid={`ats-handoff-record-receipt-${workflowId}`}
      >
        Record manual handoff
      </Button>
    </div>
  );
}
