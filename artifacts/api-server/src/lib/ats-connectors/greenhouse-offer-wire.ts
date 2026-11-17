import { z } from "zod/v4";
import { offerDigest, offerSnapshotSchema, type OfferSnapshot } from "./greenhouse-offer-policy";

const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const greenhouseWireOfferSchema = z.object({
  id: identifier,
  version: identifier,
  application_id: identifier,
  candidate_id: identifier,
  job_id: identifier,
  opening_id: identifier.nullable(),
  starts_on: z.iso.date().nullable(),
  sent_on: z.iso.date().nullable(),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
  updated_at: z.iso.datetime({ offset: true }),
  status: z.enum(["Created", "Accepted", "Rejected", "Deprecated"]),
  custom_fields: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
      z.object({
        name: z.string().max(500),
        type: z.string().max(100),
        value: z.unknown().refine((value) => value !== undefined),
      }),
    )
    .nullable(),
});
export type GreenhouseWireOffer = z.infer<typeof greenhouseWireOfferSchema>;
export const greenhouseCurrencyDigitsSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/),
  z.number().int().min(0).max(4),
);

/** Pure wire encoding, not authority or proof of employer configuration. */
export function greenhouseOfferDraftBody(raw: OfferSnapshot, rawDigits: Record<string, number>) {
  const s = offerSnapshotSchema.parse(raw);
  const digits = greenhouseCurrencyDigitsSchema.parse(rawDigits);
  const custom_fields = Object.entries(s.values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name_key, value]) => {
      if (typeof value !== "object") return { name_key, value };
      const places = digits[value.currency];
      if (places === undefined) throw new Error("Verified currency precision required.");
      const scale = 10 ** places;
      const amount = Number((value.amountMinor / scale).toFixed(places));
      // Validate the exact decimal JSON will send, not another floating-point
      // multiplication that can conceal a lost minor unit near MAX_SAFE_INTEGER.
      const decimal = /^(\d+)(?:\.(\d+))?$/.exec(String(amount));
      const fraction = decimal?.[2] ?? "";
      if (
        !Number.isFinite(amount) ||
        !decimal ||
        fraction.length > places ||
        BigInt(decimal[1]) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0") !==
          BigInt(value.amountMinor)
      )
        throw new Error("Currency amount cannot be represented safely.");
      return { name_key, value: { amount, currency_code: value.currency } };
    });
  return {
    application_id: Number(s.binding.applicationId),
    ...(s.startDate === null ? {} : { starts_on: s.startDate }),
    ...(s.openingId === null ? {} : { opening_id: Number(s.openingId) }),
    custom_fields,
  };
}

export function boundGreenhouseOffer(raw: unknown, s: OfferSnapshot): GreenhouseWireOffer {
  const row = greenhouseWireOfferSchema.parse(raw);
  if (
    String(row.application_id) !== s.binding.applicationId ||
    String(row.candidate_id) !== s.binding.candidateId ||
    String(row.job_id) !== s.binding.jobId
  )
    throw new Error("Offer binding mismatch.");
  return row;
}

/** Includes financial values and update metadata, not merely id/version. Never log this input. */
export function greenhouseOfferChain(row: GreenhouseWireOffer) {
  return { id: String(row.id), version: row.version, revision: offerDigest(row) };
}

/** Unexpected non-null defaults can change compensation too; never silently accept them. */
export function matchesGreenhouseOfferDraft(
  row: GreenhouseWireOffer,
  body: ReturnType<typeof greenhouseOfferDraftBody>,
) {
  if (row.opening_id !== (body.opening_id ?? null) || row.starts_on !== (body.starts_on ?? null))
    return false;
  const expected = new Map(body.custom_fields.map((field) => [field.name_key, field.value]));
  const actual = row.custom_fields ?? {};
  for (const [key, value] of expected) {
    if (!Object.hasOwn(actual, key) || offerDigest(actual[key].value) !== offerDigest(value))
      return false;
  }
  return Object.entries(actual).every(([key, field]) => field.value === null || expected.has(key));
}
