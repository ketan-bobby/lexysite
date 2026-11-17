import { z } from "zod/v4";
import { stageWriteSnapshotSchema } from "./zoho-stage-write-core";
import { fingerprint } from "../recruiting-workflows";
import { CalendarError } from "../outlook-calendar-core";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RULE_TTL = 15 * 60_000;
export const ruleReference = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .refine((value) => {
    if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
    if (/(password|passwd|secret|token|api[_-]?key|bearer|signature|credential)/i.test(value))
      return false;
    if (!value.includes("://")) return /^[A-Za-z0-9][A-Za-z0-9_./:# -]+$/.test(value);
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      );
    } catch {
      return false;
    }
  }, "Use a non-sensitive document reference or unsigned HTTPS URL without query parameters.");
const evidenceShape = z.strictObject({
  contractReference: ruleReference,
  isolationReference: ruleReference,
  requirementsReference: ruleReference,
  sideEffectsReference: ruleReference,
  requirements: z.literal("no_additional_fields_or_blueprint_actions"),
  notifications: z.literal("no_automatic_messages_or_cross_application_changes"),
});
export const ruleEvidenceSchema = evidenceShape.refine(
  (e) => new Set(evidenceReferences(e).map((r) => r.toLowerCase())).size === 4,
  "Provide four distinct evidence references, not a repeated generic acknowledgement.",
);
export function evidenceReferences(e: z.infer<typeof evidenceShape>): string[] {
  return [
    e.contractReference,
    e.isolationReference,
    e.requirementsReference,
    e.sideEffectsReference,
  ];
}
export const ruleInput = z.strictObject({
  expectedRevision: hash,
  expectedRuleRevision: hash.nullable(),
  requestId: z.uuid(),
  evidence: ruleEvidenceSchema,
  confirm: z.literal(true),
});
export const ruleAction = z
  .strictObject({
    expectedRevision: hash,
    requestId: z.uuid(),
    action: z.enum(["verify", "revoke"]),
    reviewReference: ruleReference.optional(),
    confirm: z.literal(true),
  })
  .refine(
    (value) => value.action !== "verify" || !!value.reviewReference,
    "Independent verification requires its own review reference.",
  );
export const ruleBaseSchema = z.strictObject({
  tenantId: id,
  campaignId: id,
  recipientId: id,
  bindingHash: hash,
  accountRef: hash,
  sourceRevision: hash,
  sourceEvidenceHash: hash,
  latestReviewId: id.nullable(),
  sourceConnectionRevision: id,
  connectionRevision: id,
  custodyRevision: hash,
  configFingerprint: hash,
  mappingRevision: id,
  currentStatus: stageWriteSnapshotSchema.shape.currentStatus,
  targetStatus: stageWriteSnapshotSchema.shape.targetStatus,
  decision: stageWriteSnapshotSchema.shape.decision,
  catalogRevision: hash,
});
export const ruleRecordSchema = z
  .strictObject({
    id: z.uuid(),
    state: z.enum(["proposed", "verified", "revoked"]),
    base: ruleBaseSchema,
    evidence: ruleEvidenceSchema,
    submittedBy: id,
    submittedAt: z.number().int().nonnegative(),
    verifiedBy: id.nullable(),
    verifiedAt: z.number().int().nonnegative().nullable(),
    expiresAt: z.number().int().nonnegative().nullable(),
    reviewReference: ruleReference.nullable(),
    revokedBy: id.nullable(),
    revokedAt: z.number().int().nonnegative().nullable(),
  })
  .superRefine((r, ctx) => {
    const bad = () =>
      ctx.addIssue({ code: "custom", message: "Invalid rule verification provenance." });
    const hasVerification = r.verifiedBy !== null;
    if (hasVerification) {
      if (
        r.verifiedBy === r.submittedBy ||
        r.verifiedAt === null ||
        r.expiresAt === null ||
        r.verifiedAt < r.submittedAt ||
        r.expiresAt <= r.verifiedAt ||
        r.expiresAt - r.verifiedAt > RULE_TTL ||
        !r.reviewReference ||
        evidenceReferences(r.evidence).some(
          (ref) => ref.toLowerCase() === r.reviewReference?.toLowerCase(),
        )
      )
        bad();
    } else if (r.verifiedAt !== null || r.expiresAt !== null || r.reviewReference !== null) bad();
    if ((r.state === "verified" && !hasVerification) || (r.state === "proposed" && hasVerification))
      bad();
    if (
      r.state === "revoked"
        ? r.revokedBy === null || r.revokedAt === null
        : r.revokedBy !== null || r.revokedAt !== null
    )
      bad();
  });
export type StageRuleBase = z.infer<typeof ruleBaseSchema>;
export type StageRuleRecord = z.infer<typeof ruleRecordSchema>;
export type StageRuleEntry = {
  record: StageRuleRecord;
  revision: string;
  requestId: string;
  commandHash: string;
};
export const ruleConflict = () =>
  new CalendarError(
    409,
    "zoho_stage_rule_changed",
    "The evidence, application, decision or employer connection changed. Reload and review again.",
  );
export const ruleRevision = (value: unknown) => fingerprint(value);
export function sameRuleBase(a: StageRuleBase, b: StageRuleBase) {
  return ruleRevision(ruleBaseSchema.parse(a)) === ruleRevision(ruleBaseSchema.parse(b));
}
