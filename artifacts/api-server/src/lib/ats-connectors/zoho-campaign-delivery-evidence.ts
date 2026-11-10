/** Read-only interpretation of persisted campaign state, not a provider lookup. */
export function campaignDeliveryEvidence(row: {
  state: string;
  reason: string | null;
  messageId: string | null;
  updatedAt: Date;
}) {
  const acceptance =
    row.state === "simulated"
      ? "simulated"
      : row.state === "sent" && row.messageId
        ? "recorded"
        : "unknown";
  return {
    acceptance,
    providerMessageId: row.messageId,
    lastStateChangeAt: row.updatedAt,
    needsReview: row.state === "sending" || row.state === "review_required",
    delivery: "unverified" as const,
  };
}
