import { z } from "zod/v4";
import {
  offerDigest,
  offerHash,
  offerSnapshotSchema,
  type OfferSnapshot,
} from "./greenhouse-offer-policy";

const externalId = z.number().int().positive().safe();
const externalIdString = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((v) => Number.isSafeInteger(Number(v)));
const identity = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("site_admin"),
    credentialSubjectId: externalIdString,
    verifiedSubjectId: externalIdString,
    active: z.boolean(),
    privateOffersPermission: z.enum(["verified", "missing", "unknown"]),
  }),
  z.strictObject({
    kind: z.literal("integration_user"),
    credentialSubjectId: z.null(),
    verifiedSubjectId: externalIdString,
    active: z.boolean(),
    integrationAccessReviewed: z.boolean(),
  }),
]);

/** Internal evidence only: never populate from client JSON or decoded, unverified JWT claims. */
export const greenhouseOfferAuthoritySchema = z.strictObject({
  tenantId: z.string().min(1).max(200),
  actorId: z.string().min(1).max(200),
  workflowId: z.string().min(1).max(200),
  accountRef: offerHash,
  credentialHash: offerHash,
  connectionRevision: z.string().min(1).max(200),
  bindingHash: offerHash,
  employerConfirmed: z.boolean(),
  evidenceReference: offerHash,
  observedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
  grantedScopes: z.array(z.string().min(1).max(200)).max(200),
  identity,
});
export type GreenhouseOfferAuthority = z.infer<typeof greenhouseOfferAuthoritySchema>;

/**
 * Evaluate independently obtained, server-held custody/permission evidence.
 * This does NOT discover permissions, validate a credential or grant financial approval.
 */
export function greenhouseOfferCapabilities(rawSnapshot: OfferSnapshot, raw: unknown, now: number) {
  const denied = {
    privateOfferReadVerified: false,
    offerCreateVerified: false,
    approvalReadVerified: false,
  };
  const snapshot = offerSnapshotSchema.safeParse(rawSnapshot);
  const proof = greenhouseOfferAuthoritySchema.safeParse(raw);
  if (!snapshot.success || !proof.success || !Number.isSafeInteger(now)) return denied;
  const s = snapshot.data,
    p = proof.data;
  if (
    p.tenantId !== s.actor.tenantId ||
    p.actorId !== s.actor.id ||
    p.workflowId !== s.scope.workflowId ||
    p.accountRef !== s.accountRef ||
    p.connectionRevision !== s.connectionRevision ||
    p.bindingHash !== offerDigest(s.binding) ||
    !p.employerConfirmed ||
    !p.identity.active ||
    p.observedAt > now ||
    p.expiresAt <= now ||
    p.expiresAt <= p.observedAt ||
    p.expiresAt - p.observedAt > 60000 ||
    new Set(p.grantedScopes).size !== p.grantedScopes.length
  )
    return denied;
  const privateAccess =
    p.identity.kind === "site_admin"
      ? p.identity.credentialSubjectId === p.identity.verifiedSubjectId &&
        p.identity.privateOffersPermission === "verified"
      : p.identity.integrationAccessReviewed;
  const read = privateAccess && p.grantedScopes.includes("harvest:offers:list");
  const approvalRead = read && p.grantedScopes.includes("harvest:approval_flows:list");
  return {
    privateOfferReadVerified: read,
    offerCreateVerified: approvalRead && p.grantedScopes.includes("harvest:offers:create"),
    approvalReadVerified: approvalRead,
  };
}

/** Harvest v3's aggregate flow state, not an offer's Created/Accepted lifecycle. */
export const greenhouseApprovalFlowSchema = z.object({
  id: externalId,
  job_id: externalId,
  offer_id: externalId.nullable(),
  approval_type: z.enum(["open_job", "offer_job", "offer_candidate"]),
  version: z.number().int().positive().safe(),
  requested_by_id: externalId.nullable(),
  approval_status: z.enum(["pending", "rejected", "approved"]).nullable(),
  sequential: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type GreenhouseApprovalFlow = z.infer<typeof greenhouseApprovalFlowSchema>;
export type GreenhouseFlowTarget = "job" | "offer";

export function boundGreenhouseApprovalFlow(
  raw: unknown,
  s: OfferSnapshot,
  target: GreenhouseFlowTarget,
) {
  const rows = z.array(greenhouseApprovalFlowSchema).max(1).parse(raw);
  const row = rows[0] ?? null;
  if (target === "offer" && !s.existingChain)
    throw new Error("Offer approval binding unavailable.");
  if (
    row &&
    (String(row.job_id) !== s.binding.jobId ||
      (target === "job"
        ? row.approval_type !== "offer_job" || row.offer_id !== null
        : row.approval_type !== "offer_candidate" ||
          row.version !== 1 ||
          String(row.offer_id) !== s.existingChain!.id))
  )
    throw new Error("Offer approval binding unavailable.");
  return row;
}

export type GreenhouseApprovalState =
  | "unverified"
  | "not_requested"
  | "pending"
  | "approved"
  | "rejected";
/** A pure interpretation, never permission to request approvals, send or change a hiring decision. */
export function greenhouseApprovalState(
  flow: GreenhouseApprovalFlow | null,
): GreenhouseApprovalState {
  if (!flow) return "unverified"; // An absent/prototype/hidden flow is not a waiver.
  const parsed = greenhouseApprovalFlowSchema.safeParse(flow);
  if (!parsed.success) return "unverified";
  const f = parsed.data;
  if (f.approval_type === "open_job") return "unverified";
  if (f.requested_by_id === null)
    return f.approval_status === null || f.approval_status === "pending"
      ? "not_requested"
      : "unverified";
  return f.approval_status ?? "unverified";
}

export function greenhouseCombinedApprovalState(
  rawSnapshot: OfferSnapshot,
  job: GreenhouseApprovalFlow | null,
  offer: GreenhouseApprovalFlow | null,
): GreenhouseApprovalState {
  try {
    const s = offerSnapshotSchema.parse(rawSnapshot);
    if (!s.existingChain) return "unverified";
    const boundJob = boundGreenhouseApprovalFlow(job ? [job] : [], s, "job");
    const boundOffer = boundGreenhouseApprovalFlow(offer ? [offer] : [], s, "offer");
    const states = [greenhouseApprovalState(boundJob), greenhouseApprovalState(boundOffer)];
    for (const state of ["unverified", "rejected", "not_requested", "pending"] as const)
      if (states.includes(state)) return state;
    return "approved";
  } catch {
    return "unverified";
  }
}
