/**
 * lib/partner-payouts.ts — Partner Rev-Share Calculation
 *
 * Implements the regional rev-share caps + 35% net-margin floor from §10.7 of
 * docs/L3xy_Unit_Economics_and_Pricing.md. Pure functions — no DB access — so
 * they're easy to unit-test.
 *
 *   • Regional cap is a hard ceiling on the rev-share percentage we'll pay,
 *     no matter what was negotiated with the partner.
 *   • Margin floor caps the actual payout so the deal still nets >= 35% to L3xy
 *     after CoGS. We assume CoGS is 30% of attributed revenue (configurable via
 *     COGS_RATIO env at boot time if needed). That leaves up to 35% to share.
 */
export type Region = "us" | "eu" | "india" | "africa" | "pakistan" | "other";

/** Maximum rev-share % we will ever pay a partner from a tenant in this region. */
const REGIONAL_REV_SHARE_CAP_PCT: Record<Region, number> = {
  us:       30,
  eu:       25,
  india:    20,
  africa:   15,
  pakistan: 0,    // Pakistan uses flat-fee referrals, not rev-share.
  other:    20,
};

const COGS_RATIO = Number(process.env.PARTNER_COGS_RATIO ?? "0.30"); // 30% of revenue
const NET_MARGIN_FLOOR = Number(process.env.PARTNER_MARGIN_FLOOR ?? "0.35"); // keep 35% to L3xy

export interface PayoutCalc {
  attributedRevenueCents: number;
  effectiveRevSharePct: number;
  rawPayoutCents: number;
  payoutCents: number;
  marginFloorApplied: boolean;
  regionalCapApplied: boolean;
}

export function calculatePartnerPayout(args: {
  attributedRevenueCents: number;
  negotiatedRevSharePct: number;
  region: Region;
}): PayoutCalc {
  const cap = REGIONAL_REV_SHARE_CAP_PCT[args.region];
  const effective = Math.max(0, Math.min(args.negotiatedRevSharePct, cap));
  const regionalCapApplied = args.negotiatedRevSharePct > cap;

  const raw = Math.round(args.attributedRevenueCents * (effective / 100));

  // Margin-floor clip: ensure (revenue - cogs - payout) / revenue >= NET_MARGIN_FLOOR
  // ⇒ payout <= revenue * (1 - cogs - floor)
  const maxPayout = Math.max(0, Math.floor(args.attributedRevenueCents * (1 - COGS_RATIO - NET_MARGIN_FLOOR)));
  const final = Math.min(raw, maxPayout);
  const marginFloorApplied = final < raw;

  return {
    attributedRevenueCents: args.attributedRevenueCents,
    effectiveRevSharePct: effective,
    rawPayoutCents: raw,
    payoutCents: final,
    marginFloorApplied,
    regionalCapApplied,
  };
}

export const PARTNER_PAYOUT_CONFIG = {
  REGIONAL_REV_SHARE_CAP_PCT,
  COGS_RATIO,
  NET_MARGIN_FLOOR,
};
