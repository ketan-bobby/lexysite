import type { AtsHandoffState } from "@workspace/api-client-react";

const remoteId = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const recorded = (actor?: string, at?: string) =>
  !!actor?.trim() && !!at && Number.isFinite(Date.parse(at));

/** Manual HR reference only. Never an offer payload, provider receipt or write authorization. */
export function greenhouseHrHandoff(state: AtsHandoffState): string | null {
  const { packet, mapping } = state;
  if (
    !state.canManage ||
    !state.ready ||
    state.stale ||
    !packet ||
    !mapping ||
    mapping.system.trim().toLowerCase() !== "greenhouse" ||
    packet.content.offerOwner !== "external_employer" ||
    !recorded(packet.approvedBy, packet.approvedAt) ||
    !recorded(packet.exportedBy, packet.exportedAt) ||
    !/^[a-f0-9]{64}$/.test(packet.snapshotHash)
  )
    return null;
  for (const key of [
    "system",
    "accountRef",
    "externalJobId",
    "externalCandidateId",
    "externalApplicationId",
    "mappedBy",
    "mappedAt",
  ] as const) {
    if (mapping[key] !== packet.content.mapping[key]) return null;
  }
  if (
    ![mapping.externalJobId, mapping.externalCandidateId, mapping.externalApplicationId].every(
      remoteId,
    )
  )
    return null;
  const decision = packet.content.decision;
  if (!["hire", "hold", "decline"].includes(decision.outcome)) return null;
  return [
    "Lexy → Greenhouse: manual employer HR review reference",
    `Greenhouse job ID: ${mapping.externalJobId}`,
    `Greenhouse candidate ID: ${mapping.externalCandidateId}`,
    `Greenhouse application ID: ${mapping.externalApplicationId}`,
    `Reviewed packet fingerprint: ${packet.snapshotHash}`,
    `Recorded human hiring intent: ${decision.outcome}`,
    ...(decision.testOnly ? ["TEST ONLY — not a genuine candidate assessment."] : []),
    "",
    "Match all three IDs in the employer's own Greenhouse account before proceeding.",
    "Review the separately exported packet with the designated employer offer owner.",
    "A hiring intent is not approval of financial terms, an offer or confirmed employment.",
    "Inspect the existing offer chain before preparing anything; do not create a duplicate.",
    "Employer HR owns compensation, required fields, negotiations and Greenhouse approval flows.",
    "Only an authorized human may request approvals or separately send the approved offer.",
    "This text was generated locally. It has not been published to Greenhouse.",
    "It is not verified ATS receipt, offer creation, offer approval, delivery or employment.",
  ].join("\n");
}
