import { createHash } from "node:crypto";
import { z } from "zod/v4";

const id = z.string().min(1).max(200);
export const offerHash = z.string().regex(/^[a-f0-9]{64}$/);
const externalId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((s) => Number.isSafeInteger(Number(s)));
const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,79}$/)
  .refine((s) => !["constructor", "prototype", "__proto__"].includes(s));
const currency = z.string().regex(/^[A-Z]{3}$/);
export const offerActorSchema = z.strictObject({ id, tenantId: id });
export const offerScopeSchema = z.strictObject({ workflowId: id });
export const offerBindingSchema = z.strictObject({
  applicationId: externalId,
  candidateId: externalId,
  jobId: externalId,
});
const chain = z.strictObject({
  id: externalId,
  version: z.number().int().positive(),
  revision: offerHash,
});
const field = z.strictObject({
  key,
  type: z.enum(["text", "number", "date", "choice", "currency"]),
  required: z.boolean(),
  choices: z.array(z.string().min(1).max(500)).max(200),
  currencies: z.array(currency).max(100),
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
});
const value = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.strictObject({ amountMinor: z.number().int().nonnegative().safe(), currency }),
]);
export const offerSnapshotSchema = z.strictObject({
  actor: offerActorSchema,
  scope: offerScopeSchema,
  accountRef: offerHash,
  connectionRevision: id,
  binding: offerBindingSchema,
  sourceRevision: offerHash,
  termsOwnerId: id,
  approverId: id,
  submitterId: id,
  currentHumanDecision: z.boolean(),
  writePermissionConfirmed: z.boolean(),
  canReadRemote: z.boolean(),
  existingChain: chain.nullable(),
  existingApprovalState: z.enum(["none", "not_requested", "pending", "approved", "rejected"]),
  openingId: externalId.nullable(),
  startDate: z.iso.date().nullable(),
  values: z.record(key, value),
  contract: z.strictObject({
    accountRef: offerHash,
    connectionRevision: id,
    bindingHash: offerHash,
    chainHash: offerHash,
    revision: offerHash,
    evidenceReference: id,
    verifiedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    applicationBound: z.boolean(),
    sideEffectsReviewed: z.boolean(),
    approvalFlowConfirmed: z.boolean(),
    candidateDeliveryDisabled: z.boolean(),
    startDateRequired: z.boolean(),
    openingRequired: z.boolean(),
    allowedOpeningIds: z.array(externalId).max(1000),
    fields: z.array(field).max(100),
  }),
});
export const offerCommandSchema = z.strictObject({
  expectedRevision: offerHash,
  requestId: z.uuid(),
  confirm: z.literal(true),
});
export type OfferSnapshot = z.infer<typeof offerSnapshotSchema>;
export type OfferActor = z.infer<typeof offerActorSchema>;
export type OfferScope = z.infer<typeof offerScopeSchema>;
export function offerDigest(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, sorted(x)]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
export function offerTermsHash(s: OfferSnapshot) {
  return offerDigest({ openingId: s.openingId, startDate: s.startDate, values: s.values });
}
export function offerRevision(s: OfferSnapshot) {
  const { actor, ...intent } = offerSnapshotSchema.parse(s);
  // Different designated humans may author, approve and submit the SAME intent.
  return offerDigest({ ...intent, tenantId: actor.tenantId });
}
export function offerBlocker(s: OfferSnapshot, now: number): string | null {
  if (!s.currentHumanDecision) return "current_human_decision_required";
  if (!s.writePermissionConfirmed || !s.canReadRemote) return "employer_permission_required";
  const c = s.contract;
  if ((s.existingChain === null) !== (s.existingApprovalState === "none"))
    return "existing_offer_state_invalid";
  if (
    c.accountRef !== s.accountRef ||
    c.connectionRevision !== s.connectionRevision ||
    c.bindingHash !== offerDigest(s.binding) ||
    c.chainHash !== offerDigest(s.existingChain) ||
    !c.applicationBound ||
    !c.sideEffectsReviewed ||
    !c.approvalFlowConfirmed ||
    !c.candidateDeliveryDisabled
  )
    return "verified_employer_contract_required";
  if (
    !Number.isFinite(now) ||
    c.verifiedAt > now ||
    c.expiresAt <= now ||
    c.expiresAt <= c.verifiedAt ||
    c.expiresAt - c.verifiedAt > 900_000
  )
    return "employer_contract_expired";
  if (c.startDateRequired && !s.startDate) return "start_date_required";
  if (
    (c.openingRequired && !s.openingId) ||
    (s.openingId && !c.allowedOpeningIds.includes(s.openingId))
  )
    return "opening_invalid";
  const keys = c.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) return "employer_fields_invalid";
  if (Object.keys(s.values).some((k) => !keys.includes(k))) return "unknown_offer_field";
  for (const f of c.fields) {
    if (
      (f.min !== null && f.max !== null && f.min > f.max) ||
      (f.type === "choice" &&
        (!f.choices.length || new Set(f.choices).size !== f.choices.length)) ||
      (f.type === "currency" && !f.currencies.length)
    )
      return "employer_fields_invalid";
    const v = s.values[f.key];
    if (v === undefined || (typeof v === "string" && !v.trim())) {
      if (f.required) return "required_offer_field_missing";
      continue;
    }
    let amount: number | undefined;
    if (f.type === "text" && typeof v !== "string") return "offer_field_invalid";
    if (f.type === "date" && !z.iso.date().safeParse(v).success) return "offer_field_invalid";
    if (f.type === "choice" && (typeof v !== "string" || !f.choices.includes(v)))
      return "offer_field_invalid";
    if (f.type === "number") {
      if (typeof v !== "number") return "offer_field_invalid";
      amount = v;
    }
    if (f.type === "currency") {
      if (typeof v !== "object" || !f.currencies.includes(v.currency)) return "offer_field_invalid";
      amount = v.amountMinor;
    }
    if (
      amount !== undefined &&
      ((f.min !== null && amount < f.min) || (f.max !== null && amount > f.max))
    )
      return "offer_field_out_of_range";
  }
  return null;
}
