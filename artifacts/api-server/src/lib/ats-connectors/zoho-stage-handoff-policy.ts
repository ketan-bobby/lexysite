import { z } from "zod/v4";
import { fingerprint } from "../recruiting-workflows";

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const status = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !/[\u0000-\u001f\u007f]/u.test(v));
export const stageMappingInput = z.strictObject({
  expectedRevision: revision,
  advance: status.nullable(),
  hold: status.nullable(),
  decline: status.nullable(),
  confirm: z.literal(true),
});
export const stageHandoffInput = z.strictObject({
  expectedRevision: revision,
  requestId: z.uuid(),
  confirm: z.literal(true),
  // Deliberately no public live mode until employer authorization and record validation.
  mode: z.literal("simulation"),
});
export const emptyMapping = (campaignId: string) => ({
  revision: fingerprint({ campaignId, empty: true }),
  advance: null as string | null,
  hold: null as string | null,
  decline: null as string | null,
  updatedAt: null as string | null,
  updatedBy: null as string | null,
});
export function handoffReadiness(
  review: { reviewable: boolean; decisionStale: boolean; history: { decision: string }[] },
  mapping: { advance: string | null; hold: string | null; decline: string | null },
) {
  // The canonical review service returns its correction chain newest-first.
  const latest = review.history[0];
  const decision =
    latest && ["advance", "hold", "decline"].includes(latest.decision)
      ? (latest.decision as "advance" | "hold" | "decline")
      : null;
  const targetStatus = decision ? mapping[decision] : null;
  const reason = !review.reviewable
    ? "A completed interview with usable evidence is required."
    : review.decisionStale
      ? "Record a current human decision before preparing a stage update."
      : !decision
        ? "Record a human decision first."
        : !targetStatus
          ? "Save a proposed status for this decision first."
          : "Ready for simulation only. No Zoho status will change. Live updates require employer write authorization and verified job-specific statuses.";
  return {
    decision,
    targetStatus,
    ready: !!review.reviewable && !review.decisionStale && !!decision && !!targetStatus,
    reason,
  };
}
