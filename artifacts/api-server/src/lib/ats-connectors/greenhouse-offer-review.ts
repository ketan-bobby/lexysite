import { z } from "zod/v4";
import { offerDigest, offerHash, type OfferSnapshot } from "./greenhouse-offer-policy";
import { greenhouseCurrencyDigitsSchema, greenhouseOfferDraftBody } from "./greenhouse-offer-wire";
import { readGreenhouseOfferConfiguration } from "./greenhouse-offer-configuration";

/** Server-held employer verification, never a public request body or an AI attestation. */
export const greenhouseEmployerOfferReviewSchema = z.strictObject({
  tenantId: z.string().min(1).max(200),
  workflowId: z.string().min(1).max(200),
  contractHash: offerHash,
  configurationHash: offerHash,
  evidenceReference: offerHash,
  reviewedBy: z.string().min(1).max(200),
  reviewedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
  currencyDigits: greenhouseCurrencyDigitsSchema,
  choiceLabelEncodingVerified: z.boolean(),
  jobApprovalNotRequiredVerified: z.boolean(),
  operation: z.literal(
    "create_or_version_then_request_internal_approval_without_candidate_delivery",
  ),
});
export type GreenhouseEmployerOfferReview = z.infer<typeof greenhouseEmployerOfferReviewSchema>;

export function checkedGreenhouseEmployerReview(
  s: OfferSnapshot,
  raw: unknown,
  now: number,
  readOnly = false,
) {
  const r = greenhouseEmployerOfferReviewSchema.parse(raw);
  if (
    !Number.isSafeInteger(now) ||
    r.tenantId !== s.actor.tenantId ||
    r.workflowId !== s.scope.workflowId ||
    r.contractHash !== offerDigest(s.contract) ||
    r.evidenceReference !== s.contract.evidenceReference ||
    r.reviewedAt > now ||
    r.expiresAt <= r.reviewedAt ||
    r.expiresAt - r.reviewedAt > 900000 ||
    (!readOnly && r.expiresAt <= now)
  )
    throw new Error("Employer offer review unavailable.");
  // Validate the exact serialized amount now, before a durable execution claim.
  greenhouseOfferDraftBody(s, r.currencyDigits);
  return r;
}

export function checkedGreenhouseOfferConfiguration(
  s: OfferSnapshot,
  r: GreenhouseEmployerOfferReview,
  c: Awaited<ReturnType<typeof readGreenhouseOfferConfiguration>>,
) {
  if (
    r.configurationHash !== c.metadataRevision ||
    c.context.tenantId !== s.actor.tenantId ||
    c.context.accountRef !== s.accountRef ||
    c.context.connectionRevision !== s.connectionRevision ||
    c.context.workflowId !== s.scope.workflowId ||
    offerDigest(c.context.binding) !== offerDigest(s.binding) ||
    c.job.status !== "open" ||
    c.job.isTemplate !== false
  )
    throw new Error("Employer settings changed.");
  const fields = c.fields.filter((f) => f.applies && f.internalType === null);
  if (
    fields.length !== s.contract.fields.length ||
    fields.some((f) => !f.supported) ||
    c.fields.some(
      (f) =>
        f.applies &&
        f.internalType !== null &&
        !["start_date", "offer_opening"].includes(f.internalType),
    )
  )
    throw new Error("Unsupported employer fields.");
  const types: Record<string, string> = {
    short_text: "text",
    long_text: "text",
    number: "number",
    date: "date",
    single_select: "choice",
    currency: "currency",
  };
  for (const f of fields) {
    const local = s.contract.fields.find((v) => v.key === f.key);
    if (
      !local ||
      types[f.valueType] !== local.type ||
      f.required !== local.required ||
      (local.type === "choice" &&
        (!r.choiceLabelEncodingVerified ||
          offerDigest([...local.choices].sort()) !==
            offerDigest(f.choices.map((v) => v.name).sort()))) ||
      (local.type === "currency" &&
        (!local.currencies.length ||
          new Set(local.currencies).size !== local.currencies.length ||
          local.currencies.some((v) => r.currencyDigits[v] === undefined)))
    )
      throw new Error("Reviewed field definition changed.");
  }
  for (const name of ["startDateRequired", "openingRequired"] as const) {
    if (c.systemRequirements[name] !== null && c.systemRequirements[name] !== s.contract[name])
      throw new Error("Managed requirement changed.");
  }
  if (
    s.contract.allowedOpeningIds.some(
      (id) =>
        !c.openings.some(
          (o) => o.id === id && (o.availability === "candidate" || o.reservedByCurrentChain),
        ),
    )
  )
    throw new Error("Opening is no longer available.");
  if (
    c.jobApproval.state !== "approved" &&
    !(r.jobApprovalNotRequiredVerified && c.jobApproval.revision === offerDigest(null))
  )
    throw new Error("Job approval is not verified.");
}
