/**
 * lib/plans.ts — Subscription Package Definitions
 *
 * Single source of truth for what every plan includes: limits, features, pricing.
 * Used by:
 *   - lib/plan-enforcement.ts          (gates resource creation against limits)
 *   - routes/tenants.ts                (demo tenant provisioning, plan changes)
 *   - routes/billing.ts (DORMANT)      (Stripe scaffold — see warning below)
 *
 * Pricing follows the global regional matrix in
 * docs/L3xy_Unit_Economics_and_Pricing.md.
 *
 * ─── ⚠️ STRIPE IS NOT LIVE — DO NOT ASSUME BILLING IS WIRED UP ⚠️ ───────────
 * The stripePriceId / STRIPE_PRICE_* fields throughout this file are DORMANT
 * scaffolding. STRIPE_SECRET_KEY is NOT configured on any deployment; every
 * Stripe route in routes/billing.ts + routes/public.ts fail-closes with
 * "not configured". Nothing in production charges a card.
 *
 * The ACTUAL billing flow today is fully manual/external:
 *   • Subscriptions: external ACH invoicing; platform_admin records payments
 *     via POST /tenants/:id/record-payment (see subscription-lifecycle-scheduler).
 *   • Per-hire fees: fee ledger review queue + CSV export for external
 *     invoicing (routes/fee-ledger.ts). NO payment processor by design.
 * If you set STRIPE_SECRET_KEY you are turning on self-serve card checkout —
 * make sure that is an intentional product decision first.
 *
 * ─── Pricing model ──────────────────────────────────────────────────────────
 * Every paid plan has THREE pricing dimensions per region:
 *   1. Platform fee / month          (subscription, charged monthly)
 *   2. Per-seat fee / month          (overage above plan's includedSeats —
 *                                     billed as a metered Stripe line item)
 *   3. Per-hire fee                  (charged on attributed hires)
 *
 * Growth's regional pricing comes directly from the published rate card.
 * Starter is set at ~37% of Growth across every dimension and every region,
 * anchored at the historic US $299/mo headline. This keeps the Starter tier
 * coherent globally (same value ladder relative to Growth in every market)
 * without each region needing a separate Starter rate card.
 *
 * ─── Per-seat overage ──────────────────────────────────────────────────────
 * `maxStaffSeats` on a plan is the *included* seat count. Tenants can add
 * seats above that — the per-seat fee is added to the monthly invoice. A
 * `maxStaffSeats` of `-1` means unlimited included seats (Enterprise).
 */

export type PlanCode = "demo" | "starter" | "growth" | "enterprise";

/* ── Regional pricing ──────────────────────────────────────────────────────
 * 14-region matrix covering every commercially relevant market. Each region
 * has its own headline price and its own Stripe Price IDs for the three
 * dimensions (platform / per-seat / per-hire is captured at headline only —
 * per-hire is invoiced manually post-hire and so doesn't need a Stripe Price).
 *
 * If a regional Stripe Price ID isn't configured (env var missing) the system
 * falls back to the US (USD) Stripe Price ID — the customer still sees the
 * regional headline price on the marketing page but is charged in USD at
 * checkout. This lets you launch the regional pricing display before
 * setting up regional Stripe Prices, and never breaks the existing US flow.
 *
 * IMPORTANT: charging non-USD currencies natively (vs displaying the local
 * symbol and charging USD on int'l cards) requires either a multi-currency
 * Stripe Price OR a Stripe entity in the relevant country. If you don't have
 * that yet, leave the regional STRIPE_PRICE_*_<region> env vars unset and the
 * customer will be charged in USD.
 */
export type Region =
  | "us"          // US + Canada
  | "gb"          // United Kingdom
  | "eu"          // Western Europe (Eurozone + EFTA)
  | "eu_east"     // Eastern Europe (PL/CZ/HU/RO/BG/etc.)
  | "au"          // Australia + New Zealand
  | "gcc"         // Gulf Cooperation Council (UAE/SA/QA/KW/BH/OM)
  | "sg_hk"       // Singapore + Hong Kong
  | "jp"          // Japan
  | "kr"          // South Korea
  | "latam"       // Latin America (MX/BR/AR/CL/CO/PE/etc.)
  | "in"          // India
  | "pk_bd_lk"    // Pakistan + Bangladesh + Sri Lanka
  | "sea"         // SE Asia (PH/VN/ID/TH/MY)
  | "africa"      // Africa (NG/KE/ZA/EG and others)
  | "row";        // Rest of World (USD fallback)

export interface RegionalPrice {
  region: Region;
  currency: string;        // ISO 4217 — "USD", "INR", "EUR", "GBP", ...
  symbol: string;           // "$", "₹", "€", "£", ...
  priceMonthly: number;     // platform fee per month, in `currency`
  pricePerSeat: number;     // per-seat fee per month (above includedSeats)
  perHireFee: number;       // headline per-hire fee in `currency`
  /** Stripe Price ID for the platform-fee subscription (monthly). */
  stripePriceId?: string;
  /** Stripe Price ID for the per-seat metered line item (monthly). */
  stripeSeatPriceId?: string;
  /** Stripe Price ID for the annual platform-fee subscription. Sales-led:
   *  populated via env once an annual contract is signed for a region.
   *  Falls back to the monthly price (with `fallbackToMonthly=true`) when
   *  unset, so checkout never breaks on a tenant set to billingTerm='annual'
   *  before the env slot is filled. */
  stripePriceIdAnnual?: string;
  /** Stripe Price ID for the per-seat metered line item, annual cadence. */
  stripeSeatPriceIdAnnual?: string;
  /** True when the regional Stripe Price isn't configured and the system
   *  will fall back to the US (USD) Stripe Price at checkout. The
   *  marketing page surfaces this so customers aren't surprised. */
  fallbackToUsd?: boolean;
  /** True when the tenant is on the annual contract but no annual Stripe
   *  Price ID is configured for this region — checkout falls back to the
   *  monthly price and logs a warning. Sales must fill in the env. */
  fallbackToMonthly?: boolean;
}

const REGION_META: Record<Region, { currency: string; symbol: string; label: string }> = {
  us:       { currency: "USD", symbol: "$",   label: "US / Canada" },
  gb:       { currency: "GBP", symbol: "£",   label: "United Kingdom" },
  eu:       { currency: "EUR", symbol: "€",   label: "Western Europe" },
  eu_east:  { currency: "EUR", symbol: "€",   label: "Eastern Europe" },
  au:       { currency: "AUD", symbol: "A$",  label: "Australia / NZ" },
  gcc:      { currency: "USD", symbol: "$",   label: "GCC (Gulf)" },
  sg_hk:    { currency: "SGD", symbol: "S$",  label: "Singapore / Hong Kong" },
  jp:       { currency: "JPY", symbol: "¥",   label: "Japan" },
  kr:       { currency: "KRW", symbol: "₩",   label: "South Korea" },
  latam:    { currency: "USD", symbol: "$",   label: "Latin America" },
  in:       { currency: "INR", symbol: "₹",   label: "India" },
  pk_bd_lk: { currency: "USD", symbol: "$",   label: "Pakistan / Bangladesh / Sri Lanka" },
  sea:      { currency: "USD", symbol: "$",   label: "Southeast Asia" },
  africa:   { currency: "USD", symbol: "$",   label: "Africa" },
  row:      { currency: "USD", symbol: "$",   label: "Rest of World" },
};

/** ISO-3166-1 alpha-2 (uppercase) → region bucket. Add countries as needed.
 *  Keep this table the canonical source — UI dropdowns / IP geolocation all
 *  funnel through regionFromCountry(). */
const COUNTRY_TO_REGION: Record<string, Region> = {
  // US / Canada
  US: "us", CA: "us",

  // UK
  GB: "gb",

  // Western Europe (Eurozone + EFTA)
  AT: "eu", BE: "eu", CY: "eu", DE: "eu", EE: "eu", ES: "eu", FI: "eu",
  FR: "eu", GR: "eu", IE: "eu", IT: "eu", LU: "eu", MT: "eu", NL: "eu",
  PT: "eu", SI: "eu", SK: "eu",
  NO: "eu", IS: "eu", LI: "eu", CH: "eu", DK: "eu", SE: "eu",

  // Eastern Europe — distinct lower-cost band per the rate card
  PL: "eu_east", CZ: "eu_east", HU: "eu_east", RO: "eu_east", BG: "eu_east",
  HR: "eu_east", LV: "eu_east", LT: "eu_east", RS: "eu_east", UA: "eu_east",
  BY: "eu_east", MD: "eu_east", AL: "eu_east", BA: "eu_east", MK: "eu_east",
  ME: "eu_east", XK: "eu_east",

  // Australia + NZ
  AU: "au", NZ: "au",

  // GCC
  AE: "gcc", SA: "gcc", QA: "gcc", KW: "gcc", BH: "gcc", OM: "gcc",

  // Singapore + Hong Kong
  SG: "sg_hk", HK: "sg_hk",

  // Japan
  JP: "jp",

  // South Korea
  KR: "kr",

  // Latin America
  MX: "latam", BR: "latam", AR: "latam", CL: "latam", CO: "latam", PE: "latam",
  UY: "latam", VE: "latam", EC: "latam", BO: "latam", PY: "latam", CR: "latam",
  PA: "latam", DO: "latam", GT: "latam", HN: "latam", SV: "latam", NI: "latam",
  CU: "latam", PR: "latam",

  // India
  IN: "in",

  // Pakistan / Bangladesh / Sri Lanka
  PK: "pk_bd_lk", BD: "pk_bd_lk", LK: "pk_bd_lk",

  // SE Asia (per rate card: PH/VN/ID/TH/MY)
  PH: "sea", VN: "sea", ID: "sea", TH: "sea", MY: "sea",

  // Africa (per rate card: NG/KE/ZA/EG named; bucket the rest here too)
  NG: "africa", KE: "africa", ZA: "africa", EG: "africa", GH: "africa",
  ET: "africa", TZ: "africa", UG: "africa", MA: "africa", DZ: "africa",
  TN: "africa", CI: "africa", SN: "africa", ZW: "africa", AO: "africa",
  CM: "africa", RW: "africa",
};

export function regionFromCountry(country?: string | null): Region {
  if (!country) return "us";
  return COUNTRY_TO_REGION[country.toUpperCase()] ?? "row";
}

/** Every country with an explicit rate-card mapping. Used only by the
 *  catalog seed script to materialise editable rows. */
export function __seedKnownCountries(): string[] {
  return Object.keys(COUNTRY_TO_REGION);
}

export function regionMeta(region: Region) {
  return REGION_META[region] ?? REGION_META.us;
}

export function listRegions(): Array<{ region: Region; label: string; currency: string; symbol: string }> {
  return (Object.keys(REGION_META) as Region[]).map((r) => {
    const m = REGION_META[r];
    return { region: r, label: m.label, currency: m.currency, symbol: m.symbol };
  });
}

export interface PlanLimits {
  /** Max simultaneously-open job requisitions. -1 = unlimited. */
  maxOpenJobs: number;
  /** Max interview sessions that can be created in a calendar month. -1 = unlimited. */
  maxInterviewsPerMonth: number;
  /** Included recruiter / hiring-manager seats on the tenant. Above this,
   *  the per-seat regional fee is billed monthly. -1 = unlimited (no overage). */
  maxStaffSeats: number;
  /** Max sub-client tenants (only meaningful for agencies). -1 = unlimited. */
  maxSubClients: number;
  /** Max candidate-database searches per month. -1 = unlimited. */
  maxCandidateDbSearchesPerMonth: number;
  /** Max AI-generation actions per month (JD enrich, ICP scoring, summarisation). */
  maxAiGenerationsPerMonth?: number;
  /** Max outbound outreach messages per month. */
  maxOutreachMessagesPerMonth?: number;
}

export interface PlanFeatures {
  /** Access to the Living Talent Graph (re-engagement of past candidates). */
  livingTalentGraph: boolean;
  /** Access to the candidate database / cross-tenant search. */
  candidateDatabaseSearch: boolean;
  /** Cultural-fit interview module. */
  culturalInterviews: boolean;
  /** Programming / live-coding interview module. */
  programmingInterviews: boolean;
  /** Automated outreach reply drafting (Outreach Conversation Agent). */
  outreachConversationAgent: boolean;
  /** Recruiter Anti-Ghost monitor + auto re-engagement. */
  antiGhost: boolean;
  /** White-label branding (logo + primary color on candidate-facing pages). */
  whiteLabel: boolean;
  /** ATS / HRIS integrations (Greenhouse, Lever, Rippling, etc.). */
  integrations: boolean;
  /** Access to platform partner program (rev-share enrollment). */
  partnerProgram: boolean;
  /** SSO / SAML login. */
  sso: boolean;
  /** SCIM user provisioning. */
  scim: boolean;
  /** Custom data-retention policies (HIPAA / GDPR enterprise needs). */
  customDataRetention: boolean;
  /** Dedicated CSM (vs. shared / self-serve support). */
  dedicatedCsm: boolean;
}

interface RegionalPriceEntry {
  priceMonthly: number;
  pricePerSeat: number;
  perHireFee: number;
  /** Env var name holding the platform-fee Stripe Price ID for this region. */
  stripePriceIdEnv: string;
  /** Env var name holding the per-seat metered Stripe Price ID for this region. */
  stripeSeatPriceIdEnv: string;
  /** Env var name for the ANNUAL platform-fee Stripe Price ID. Optional:
   *  unset means "no annual price configured for this region yet"; checkout
   *  for an annual-contract tenant falls back to the monthly price. */
  stripePriceIdAnnualEnv?: string;
  /** Env var name for the ANNUAL per-seat Stripe Price ID. */
  stripeSeatPriceIdAnnualEnv?: string;
}

export interface PlanPackage {
  code: PlanCode;
  name: string;
  tagline: string;
  /** US headline subscription price in USD per month. 0 = free, -1 = "contact us". */
  priceUsdPerMonth: number;
  /** US headline per-seat fee in USD (above maxStaffSeats). */
  pricePerSeatUsdPerMonth: number;
  /** US headline per-hire fee in USD (charged on attributed hires). 0 = none. */
  perHireFeeUsd: number;
  /** Free trial / demo expiry in days from plan activation. 0 = no expiry. */
  expiresAfterDays: number;
  /** Stripe Price ID for the recurring subscription (set via env in production). */
  stripePriceId?: string;
  /** Stripe Price ID for per-seat overage (set via env in production). */
  stripeSeatPriceId?: string;
  /** Whether the plan can be self-served signed up for (true) or sales-led only (false). */
  selfServe: boolean;
  /** Whether to display the plan publicly on the pricing page. */
  publiclyVisible: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  /** Per-region pricing. Stripe Price IDs are resolved from env vars at
   *  request time inside getRegionalPrice(). */
  regionalPricing?: Partial<Record<Region, RegionalPriceEntry>>;
}

const ALL_FEATURES_OFF: PlanFeatures = {
  livingTalentGraph: false,
  candidateDatabaseSearch: false,
  culturalInterviews: false,
  programmingInterviews: false,
  outreachConversationAgent: false,
  antiGhost: false,
  whiteLabel: false,
  integrations: false,
  partnerProgram: false,
  sso: false,
  scim: false,
  customDataRetention: false,
  dedicatedCsm: false,
};

/**
 * GROWTH regional matrix — direct from the published rate card.
 * Per-hire is the headline charged on attributed hires (invoiced post-hire).
 */
const GROWTH_REGIONAL: Partial<Record<Region, RegionalPriceEntry>> = {
  us:       { priceMonthly: 799,      pricePerSeat: 199,    perHireFee: 250,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT",
              stripePriceIdAnnualEnv: "STRIPE_PRICE_GROWTH_ANNUAL",
              stripeSeatPriceIdAnnualEnv: "STRIPE_PRICE_GROWTH_SEAT_ANNUAL" },
  gb:       { priceMonthly: 649,      pricePerSeat: 159,    perHireFee: 199,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_GB",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_GB" },
  eu:       { priceMonthly: 749,      pricePerSeat: 179,    perHireFee: 230,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_EU",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_EU" },
  eu_east:  { priceMonthly: 399,      pricePerSeat: 99,     perHireFee: 120,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_EU_EAST",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_EU_EAST" },
  au:       { priceMonthly: 1199,     pricePerSeat: 299,    perHireFee: 375,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_AU",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_AU" },
  gcc:      { priceMonthly: 799,      pricePerSeat: 199,    perHireFee: 250,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_GCC",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_GCC" },
  sg_hk:    { priceMonthly: 899,      pricePerSeat: 229,    perHireFee: 299,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_SG_HK",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_SG_HK" },
  jp:       { priceMonthly: 99000,    pricePerSeat: 24000,  perHireFee: 35000,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_JP",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_JP" },
  kr:       { priceMonthly: 999000,   pricePerSeat: 249000, perHireFee: 330000,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_KR",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_KR" },
  latam:    { priceMonthly: 349,      pricePerSeat: 89,     perHireFee: 120,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_LATAM",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_LATAM" },
  in:       { priceMonthly: 14999,    pricePerSeat: 2999,   perHireFee: 2500,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_IN",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_IN" },
  pk_bd_lk: { priceMonthly: 99,       pricePerSeat: 24,     perHireFee: 20,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_PK_BD_LK",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_PK_BD_LK" },
  sea:      { priceMonthly: 249,      pricePerSeat: 59,     perHireFee: 80,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_SEA",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_SEA" },
  africa:   { priceMonthly: 179,      pricePerSeat: 39,     perHireFee: 50,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH_AFRICA",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT_AFRICA" },
  row:      { priceMonthly: 799,      pricePerSeat: 199,    perHireFee: 250,
              stripePriceIdEnv: "STRIPE_PRICE_GROWTH",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_GROWTH_SEAT" },
};

/**
 * STARTER regional matrix — derived as ~37% of Growth across every dimension
 * and every region, with US anchored at the historic $299/mo headline. Numbers
 * are rounded to clean marketing values per currency. The same env-var-fallback
 * chain to the US Stripe Price applies.
 */
const STARTER_REGIONAL: Partial<Record<Region, RegionalPriceEntry>> = {
  us:       { priceMonthly: 299,      pricePerSeat: 79,     perHireFee: 99,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT",
              stripePriceIdAnnualEnv: "STRIPE_PRICE_STARTER_ANNUAL",
              stripeSeatPriceIdAnnualEnv: "STRIPE_PRICE_STARTER_SEAT_ANNUAL" },
  gb:       { priceMonthly: 249,      pricePerSeat: 59,     perHireFee: 79,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_GB",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_GB" },
  eu:       { priceMonthly: 279,      pricePerSeat: 69,     perHireFee: 89,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_EU",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_EU" },
  eu_east:  { priceMonthly: 149,      pricePerSeat: 39,     perHireFee: 49,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_EU_EAST",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_EU_EAST" },
  au:       { priceMonthly: 449,      pricePerSeat: 119,    perHireFee: 149,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_AU",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_AU" },
  gcc:      { priceMonthly: 299,      pricePerSeat: 79,     perHireFee: 99,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_GCC",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_GCC" },
  sg_hk:    { priceMonthly: 339,      pricePerSeat: 89,     perHireFee: 119,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_SG_HK",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_SG_HK" },
  jp:       { priceMonthly: 37000,    pricePerSeat: 9000,   perHireFee: 13000,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_JP",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_JP" },
  kr:       { priceMonthly: 369000,   pricePerSeat: 89000,  perHireFee: 119000,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_KR",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_KR" },
  latam:    { priceMonthly: 129,      pricePerSeat: 35,     perHireFee: 49,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_LATAM",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_LATAM" },
  in:       { priceMonthly: 5599,     pricePerSeat: 1199,   perHireFee: 999,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_IN",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_IN" },
  pk_bd_lk: { priceMonthly: 39,       pricePerSeat: 9,      perHireFee: 9,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_PK_BD_LK",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_PK_BD_LK" },
  sea:      { priceMonthly: 99,       pricePerSeat: 25,     perHireFee: 30,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_SEA",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_SEA" },
  africa:   { priceMonthly: 69,       pricePerSeat: 15,     perHireFee: 19,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER_AFRICA",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT_AFRICA" },
  row:      { priceMonthly: 299,      pricePerSeat: 79,     perHireFee: 99,
              stripePriceIdEnv: "STRIPE_PRICE_STARTER",
              stripeSeatPriceIdEnv: "STRIPE_PRICE_STARTER_SEAT" },
};

export const PLAN_PACKAGES: Record<PlanCode, PlanPackage> = {
  /**
   * DEMO — single-job sandbox for prospects who want to try the platform.
   * Self-served via POST /api/plans/start-trial (email-verified). Expires in
   * 14 days. Hard-capped to 1 open job + 20 interview sessions, no candidate-DB
   * access, no integrations, no white-label. No per-seat overage — capped at 2.
   */
  demo: {
    code: "demo",
    name: "Demo",
    tagline: "Try L3xy with one job and twenty interviews — 14 days free.",
    priceUsdPerMonth: 0,
    pricePerSeatUsdPerMonth: 0,
    perHireFeeUsd: 0,
    expiresAfterDays: 14,
    selfServe: true,
    publiclyVisible: false,
    limits: {
      maxOpenJobs: 1,
      maxInterviewsPerMonth: 20,
      maxStaffSeats: 2,
      maxSubClients: 0,
      maxCandidateDbSearchesPerMonth: 10,
      maxAiGenerationsPerMonth: 50,
      maxOutreachMessagesPerMonth: 25,
    },
    features: {
      ...ALL_FEATURES_OFF,
      culturalInterviews: true,
      programmingInterviews: true,
    },
  },

  /**
   * STARTER — small in-house TA team. 3 included seats, $79/seat overage.
   * Self-serve signup. No integrations, no white-label.
   */
  starter: {
    code: "starter",
    name: "Starter",
    tagline: "For solo recruiters and small in-house TA teams.",
    priceUsdPerMonth: 299,
    pricePerSeatUsdPerMonth: 79,
    perHireFeeUsd: 99,
    expiresAfterDays: 0,
    selfServe: true,
    publiclyVisible: true,
    // TODO(stripe): NOT wired up — env vars unset, billing.ts dormant (see file header).
    stripePriceId: process.env.STRIPE_PRICE_STARTER,
    stripeSeatPriceId: process.env.STRIPE_PRICE_STARTER_SEAT,
    limits: {
      maxOpenJobs: 5,
      maxInterviewsPerMonth: 100,
      maxStaffSeats: 3,
      maxSubClients: 0,
      maxCandidateDbSearchesPerMonth: 250,
      maxAiGenerationsPerMonth: 1000,
      maxOutreachMessagesPerMonth: 500,
    },
    features: {
      ...ALL_FEATURES_OFF,
      livingTalentGraph: true,
      culturalInterviews: true,
      programmingInterviews: true,
      outreachConversationAgent: true,
      antiGhost: true,
    },
    regionalPricing: STARTER_REGIONAL,
  },

  /**
   * GROWTH — mid-market in-house TA, scaling staffing agencies. 10 included
   * seats, $199/seat overage. Adds candidate-DB, integrations, white-label,
   * partner program.
   */
  growth: {
    code: "growth",
    name: "Growth",
    tagline: "For scaling teams and staffing agencies.",
    priceUsdPerMonth: 799,
    pricePerSeatUsdPerMonth: 199,
    perHireFeeUsd: 250,
    expiresAfterDays: 0,
    selfServe: true,
    publiclyVisible: true,
    // TODO(stripe): NOT wired up — env vars unset, billing.ts dormant (see file header).
    stripePriceId: process.env.STRIPE_PRICE_GROWTH,
    stripeSeatPriceId: process.env.STRIPE_PRICE_GROWTH_SEAT,
    limits: {
      maxOpenJobs: 25,
      maxInterviewsPerMonth: 500,
      maxStaffSeats: 10,
      maxSubClients: 10,
      maxCandidateDbSearchesPerMonth: 2500,
      maxAiGenerationsPerMonth: 5000,
      maxOutreachMessagesPerMonth: 2500,
    },
    features: {
      ...ALL_FEATURES_OFF,
      livingTalentGraph: true,
      candidateDatabaseSearch: true,
      culturalInterviews: true,
      programmingInterviews: true,
      outreachConversationAgent: true,
      antiGhost: true,
      whiteLabel: true,
      integrations: true,
      partnerProgram: true,
    },
    regionalPricing: GROWTH_REGIONAL,
  },

  /**
   * ENTERPRISE — sales-led, custom contract. Limits removed, all features on,
   * SSO + SCIM + custom retention + dedicated CSM. No per-seat overage —
   * unlimited included.
   */
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    tagline: "For large recruiting orgs with custom needs.",
    priceUsdPerMonth: -1,
    pricePerSeatUsdPerMonth: 0,
    perHireFeeUsd: 250,
    expiresAfterDays: 0,
    selfServe: false,
    publiclyVisible: true,
    // TODO(stripe): NOT wired up — env vars unset, billing.ts dormant (see file header).
    stripePriceId: process.env.STRIPE_PRICE_ENTERPRISE,
    limits: {
      maxOpenJobs: -1,
      maxInterviewsPerMonth: -1,
      maxStaffSeats: -1,
      maxSubClients: -1,
      maxCandidateDbSearchesPerMonth: -1,
      maxAiGenerationsPerMonth: -1,
      maxOutreachMessagesPerMonth: -1,
    },
    features: {
      livingTalentGraph: true,
      candidateDatabaseSearch: true,
      culturalInterviews: true,
      programmingInterviews: true,
      outreachConversationAgent: true,
      antiGhost: true,
      whiteLabel: true,
      integrations: true,
      partnerProgram: true,
      sso: true,
      scim: true,
      customDataRetention: true,
      dedicatedCsm: true,
    },
  },
};

export function getPlan(code: string | null | undefined): PlanPackage {
  if (!code) return PLAN_PACKAGES.starter;
  const pkg = PLAN_PACKAGES[code as PlanCode];
  return pkg ?? PLAN_PACKAGES.starter;
}

/**
 * Resolve the regional pricing for a plan in a given region. Returns the
 * USD baseline if the plan has no `regionalPricing` table (e.g. Demo /
 * Enterprise). Stripe Price IDs are read from env at call time and fall
 * back to the US Stripe Price IDs when the regional env vars are missing —
 * this lets you publish regional headline prices before setting up regional
 * Stripe Prices, with `fallbackToUsd=true` so the UI can flag it.
 */
export function getRegionalPrice(plan: PlanPackage, region: Region): RegionalPrice {
  const meta = REGION_META[region] ?? REGION_META.us;

  // US-platform-fee env (always considered the universal fallback).
  const usPlatformEnvId =
    plan.code === "starter" ? process.env.STRIPE_PRICE_STARTER :
    plan.code === "growth"  ? process.env.STRIPE_PRICE_GROWTH  :
    plan.stripePriceId;
  const usSeatEnvId =
    plan.code === "starter" ? process.env.STRIPE_PRICE_STARTER_SEAT :
    plan.code === "growth"  ? process.env.STRIPE_PRICE_GROWTH_SEAT  :
    plan.stripeSeatPriceId;
  // US ANNUAL envs — universal fallback for annual contracts in regions that
  // haven't been configured yet. Like above, undefined is fine and is handled
  // downstream (callers receive stripePriceIdAnnual=undefined and fall back
  // to the monthly Price ID with fallbackToMonthly=true).
  const usPlatformAnnualEnvId =
    plan.code === "starter" ? process.env.STRIPE_PRICE_STARTER_ANNUAL :
    plan.code === "growth"  ? process.env.STRIPE_PRICE_GROWTH_ANNUAL  :
    undefined;
  const usSeatAnnualEnvId =
    plan.code === "starter" ? process.env.STRIPE_PRICE_STARTER_SEAT_ANNUAL :
    plan.code === "growth"  ? process.env.STRIPE_PRICE_GROWTH_SEAT_ANNUAL  :
    undefined;

  const entry = plan.regionalPricing?.[region];
  if (!entry) {
    // No regional table for this plan (e.g. Demo / Enterprise — pricing is
    // either irrelevant or sales-led). Return the USD baseline as-is, with
    // no fallback warning: there is nothing to "fall back" *from* because
    // regional pricing was never offered for this plan.
    return {
      region,
      currency: "USD",
      symbol: "$",
      priceMonthly: plan.priceUsdPerMonth,
      pricePerSeat: plan.pricePerSeatUsdPerMonth,
      perHireFee: plan.perHireFeeUsd,
      stripePriceId: usPlatformEnvId,
      stripeSeatPriceId: usSeatEnvId,
      stripePriceIdAnnual: usPlatformAnnualEnvId,
      stripeSeatPriceIdAnnual: usSeatAnnualEnvId,
      fallbackToUsd: false,
      fallbackToMonthly: false,
    };
  }
  const stripePriceId = process.env[entry.stripePriceIdEnv] || usPlatformEnvId;
  const stripeSeatPriceId = process.env[entry.stripeSeatPriceIdEnv] || usSeatEnvId;
  // Annual: try the regional annual env (if defined on the entry), then fall
  // back to the US annual env. Stays undefined when neither is set — callers
  // must treat undefined as "no annual price configured" and route to the
  // monthly price with fallbackToMonthly=true.
  const stripePriceIdAnnual =
    (entry.stripePriceIdAnnualEnv ? process.env[entry.stripePriceIdAnnualEnv] : undefined)
    || usPlatformAnnualEnvId;
  const stripeSeatPriceIdAnnual =
    (entry.stripeSeatPriceIdAnnualEnv ? process.env[entry.stripeSeatPriceIdAnnualEnv] : undefined)
    || usSeatAnnualEnvId;
  // Flag fallback whenever the region-specific platform price ID is unset
  // AND the customer would actually be charged a different amount than the
  // displayed headline. That's the case in two scenarios:
  //   1. Currency differs from USD (e.g. EUR/GBP/JPY) — local symbol
  //      shown, USD card on file would be charged.
  //   2. Currency is USD but the regional headline differs from the US
  //      baseline (e.g. LATAM $349 vs US $799, AFRICA $179 vs US $799).
  //      Without the region's own Stripe Price the customer sees the lower
  //      regional price but would be charged the US amount.
  // Plans with no regionalPricing entry never trigger fallback (handled in
  // the early-return branch above).
  const usEntry = plan.regionalPricing?.us;
  const regionPriceIdSet = Boolean(process.env[entry.stripePriceIdEnv]);
  const wouldChargeDifferentAmount = meta.currency !== "USD" ||
    (usEntry !== undefined && entry.priceMonthly !== usEntry.priceMonthly);
  const fallback = !regionPriceIdSet && wouldChargeDifferentAmount;
  return {
    region,
    currency: meta.currency,
    symbol: meta.symbol,
    priceMonthly: entry.priceMonthly,
    pricePerSeat: entry.pricePerSeat,
    perHireFee: entry.perHireFee,
    stripePriceId,
    stripeSeatPriceId,
    stripePriceIdAnnual,
    stripeSeatPriceIdAnnual,
    fallbackToUsd: fallback,
    // fallbackToMonthly: true means the tenant is on an annual contract but
    // no annual Price ID is configured for the resolved cadence. Callers
    // that don't request annual pricing can ignore this flag.
    fallbackToMonthly: !stripePriceIdAnnual,
  };
}

export function listPublicPlans(): PlanPackage[] {
  return Object.values(PLAN_PACKAGES).filter((p) => p.publiclyVisible);
}

/** Set of all valid region codes — handy for input validation in routes. */
export const ALL_REGIONS: ReadonlySet<Region> = new Set(Object.keys(REGION_META) as Region[]);

export function isRegion(value: unknown): value is Region {
  return typeof value === "string" && ALL_REGIONS.has(value as Region);
}

/* ── Country-level pricing catalog resolver ─────────────────────────────────
 *
 * Subscription prices are displayed at COUNTRY granularity. Tiers (seats /
 * usage caps / features) are IDENTICAL across countries (see PLAN_PACKAGES);
 * ONLY the displayed price varies by country. Resolution order:
 *   1. subscription_prices DB row (admin-editable override) for the exact
 *      (country, plan, term) — lets admins add/edit a country with NO deploy.
 *   2. Code rate-card fallback via regionFromCountry() — so EVERY country
 *      always resolves to a price even with an empty catalog.
 *
 * Monthly is the base; quarterly = monthly × 3, annual = monthly × 12. Per-seat
 * and per-hire fees are NOT term-multiplied (they're billed as they occur).
 * No in-system payment — these numbers are for DISPLAY + record-keeping only.
 */
import { db, subscriptionPricesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export type BillingTerm = "monthly" | "quarterly" | "annual";

/** Months covered by each billing term — also used to advance paid_through. */
export const TERM_MONTHS: Record<BillingTerm, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

export function isBillingTerm(value: unknown): value is BillingTerm {
  return value === "monthly" || value === "quarterly" || value === "annual";
}

/** Advance a date forward by one billing term (used by record-payment). */
export function advanceByTerm(from: Date, term: BillingTerm): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + TERM_MONTHS[term]);
  return d;
}

/** Currency + symbol for a country, derived from its region bucket. */
export function countryCurrency(country?: string | null): { currency: string; symbol: string } {
  const meta = regionMeta(regionFromCountry(country));
  return { currency: meta.currency, symbol: meta.symbol };
}

export interface ResolvedCountryPrice {
  country: string;
  planCode: PlanCode;
  billingTerm: BillingTerm;
  currency: string;
  symbol: string;
  /** Platform fee for the WHOLE term, in major units. -1 = "contact us". */
  amount: number;
  /** Per-seat overage fee per MONTH, major units. */
  perSeatAmount: number;
  /** Per-hire fee, major units. */
  perHireAmount: number;
  taxNote: string;
  /** Where the number came from — useful for the admin UI. */
  source: "catalog" | "ratecard";
}

const DEFAULT_TAX_NOTE = "Prices exclusive of applicable VAT/GST.";

/** Code rate-card fallback for a (country, plan, term) — no DB. */
export function rateCardCountryPrice(
  country: string,
  planCode: PlanCode,
  term: BillingTerm,
): ResolvedCountryPrice {
  const cc = (country || "US").toUpperCase();
  const region = regionFromCountry(cc);
  const meta = regionMeta(region);
  const plan = getPlan(planCode);
  const entry = plan.regionalPricing?.[region];

  const monthly = entry?.priceMonthly ?? plan.priceUsdPerMonth;
  const perSeat = entry?.pricePerSeat ?? plan.pricePerSeatUsdPerMonth;
  const perHire = entry?.perHireFee ?? plan.perHireFeeUsd;

  // "Contact us" plans (enterprise, priceUsdPerMonth = -1) stay -1 for all terms.
  const amount = monthly < 0 ? -1 : monthly * TERM_MONTHS[term];

  return {
    country: cc,
    planCode,
    billingTerm: term,
    currency: meta.currency,
    symbol: meta.symbol,
    amount,
    perSeatAmount: perSeat,
    perHireAmount: perHire,
    taxNote: DEFAULT_TAX_NOTE,
    source: "ratecard",
  };
}

/**
 * Resolve the displayed price for a (country, plan, term): admin-editable DB
 * catalog row first, else the code rate-card. Demo is always free.
 */
export async function getCountryPrice(
  country: string | null | undefined,
  planCode: PlanCode,
  term: BillingTerm,
): Promise<ResolvedCountryPrice> {
  const cc = (country || "US").toUpperCase();

  if (planCode === "demo") {
    const { currency, symbol } = countryCurrency(cc);
    return {
      country: cc, planCode, billingTerm: term, currency, symbol,
      amount: 0, perSeatAmount: 0, perHireAmount: 0,
      taxNote: DEFAULT_TAX_NOTE, source: "ratecard",
    };
  }

  try {
    const [row] = await db
      .select()
      .from(subscriptionPricesTable)
      .where(and(
        eq(subscriptionPricesTable.country, cc),
        eq(subscriptionPricesTable.planCode, planCode),
        eq(subscriptionPricesTable.billingTerm, term),
        eq(subscriptionPricesTable.active, true),
      ))
      .limit(1);
    if (row) {
      return {
        country: row.country,
        planCode: row.planCode as PlanCode,
        billingTerm: row.billingTerm as BillingTerm,
        currency: row.currency,
        symbol: row.symbol,
        amount: row.amount,
        perSeatAmount: row.perSeatAmount,
        perHireAmount: row.perHireAmount,
        taxNote: row.taxNote,
        source: "catalog",
      };
    }
  } catch (err) {
    // Catalog read failed — fall through to the code rate-card so pricing
    // display never hard-fails on a transient DB issue. Log it so a real
    // catalog outage / migration drift is observable (admin overrides
    // silently ignored would otherwise look like the rate-card is "wrong").
    logger.warn(
      { err, country: cc, planCode, term },
      "[getCountryPrice] catalog read failed — falling back to code rate-card",
    );
  }

  return rateCardCountryPrice(cc, planCode, term);
}
