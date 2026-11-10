import type { ControlledOfferRecord, WorkflowStep } from "@workspace/db";

export const redactOfferCapabilities = (value: string) =>
  value.replace(/(\/(?:offer|controlled-offers\/public)\/)[a-f0-9]{64}/g, "$1[redacted]");

export function offerView(record: ControlledOfferRecord) {
  const { tokenHash: _tokenHash, ...view } = record;
  return {
    ...view,
    status:
      record.status === "sending" &&
      Date.parse(record.deliveryStartedAt ?? record.createdAt) < Date.now() - 300000
        ? ("send_uncertain" as const)
        : ["sent", "approved"].includes(record.status) &&
            Date.parse(record.terms.expiresAt) <= Date.now()
          ? ("expired" as const)
          : record.status,
  };
}

export function safeOfferSteps(steps: WorkflowStep[], canViewOffers = true) {
  return steps.map((step) => {
    // ATS identifiers/reviewed snapshots are served only by the dedicated owner-gated API.
    const { atsHandoff: _ats, atsHandoffHistory: _atsHistory, ...publicStep } = step;
    if (!canViewOffers) {
      const { controlledOffer: _offer, controlledOfferHistory: _history, ...rest } = publicStep;
      return rest;
    }
    return {
      ...publicStep,
      ...(step.controlledOffer ? { controlledOffer: offerView(step.controlledOffer) } : {}),
      ...(step.controlledOfferHistory
        ? { controlledOfferHistory: step.controlledOfferHistory.map(offerView) }
        : {}),
    };
  });
}
