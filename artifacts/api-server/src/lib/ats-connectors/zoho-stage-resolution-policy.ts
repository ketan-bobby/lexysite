import { z } from "zod/v4";
import { ruleReference } from "./zoho-stage-rule-policy";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
export const stageResolutionInput = z.strictObject({
  expectedRevision: hash,
  expectedSourceRevision: hash,
  expectedSequence: z.number().int().positive(),
  commandId: z.uuid(),
  action: z.enum(["propose", "approve", "reject"]),
  reason: text(20, 1000),
  evidenceReference: ruleReference.refine((s) => s.length >= 10),
  confirm: z.literal(true),
  acknowledgeUnknown: z.literal(true),
  acknowledgeNoRetry: z.literal(true),
});
const command = {
  commandId: z.uuid(),
  commandHash: hash,
};
export const stageResolutionSchema = z.strictObject({
  ...command,
  proposedBy: z.string().min(1),
  proposedAt: z.number().int().nonnegative(),
  reason: text(20, 1000),
  evidenceReference: ruleReference.refine((s) => s.length >= 10),
  sourceHash: hash,
  observedStatus: text(1, 100),
  review: z
    .strictObject({
      ...command,
      action: z.enum(["approve", "reject"]),
      by: z.string().min(1),
      at: z.number().int().nonnegative(),
      reason: text(20, 1000),
      evidenceReference: ruleReference.refine((s) => s.length >= 10),
    })
    .nullable(),
});
type ResolutionRow = { state: string; resolution?: z.infer<typeof stageResolutionSchema> | null };
export const stageRequestClosed = (row: ResolutionRow) =>
  row.resolution?.review?.action === "approve";
export const stageRequestHeld = (row: ResolutionRow) =>
  ["claimed", "provider_accepted", "review_required", "observed_target", "observed_other"].includes(
    row.state,
  ) && !stageRequestClosed(row);
export const stageResolutionPublic = (r: z.infer<typeof stageResolutionSchema> | null) =>
  r
    ? {
        proposedBy: r.proposedBy,
        proposedAt: r.proposedAt,
        reason: r.reason,
        evidenceReference: r.evidenceReference,
        observedStatus: r.observedStatus,
        review: r.review
          ? {
              action: r.review.action,
              by: r.review.by,
              at: r.review.at,
              reason: r.review.reason,
              evidenceReference: r.review.evidenceReference,
            }
          : null,
      }
    : null;
