/**
 * governance/jurisdictions.ts — Location → Jurisdiction Classifier
 *
 * Maps free-text candidate and job locations to ISO-style jurisdiction
 * codes that the enforcement service uses to look up policy. Locations
 * are user-entered free-text in this codebase (candidates.location,
 * jobs.location are both `text`), so this is necessarily a heuristic.
 *
 * ─── Default-gated when uncertain (per design spec) ──────────────────────────
 * If we cannot CONFIDENTLY exclude a regulated jurisdiction, we return
 * that jurisdiction in the result. Two examples:
 *   - Empty/null location → returns ALL platform-floor jurisdictions.
 *     A regulator-defensible posture: we did not know where the
 *     candidate was, so we did not auto-reject.
 *   - "New York" (state, ambiguous wrt NYC) → returns US-NY-NYC since
 *     NYC residents are a meaningful subset and the cost of false
 *     positive (a human review) is much smaller than the cost of
 *     false negative (an LL144 violation).
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   decision-enforcement.ts — primary consumer
 *
 * Intentionally a small, dependency-free module so it is easy for an
 * auditor to read end-to-end. When precision matters more (e.g. revenue
 * gating), wire in a real geocoder; for compliance gating, the safe-by-
 * default heuristic is the correct trade.
 */

export const PLATFORM_FLOOR_JURISDICTIONS = [
  "US-NY-NYC",
  "US-CO",
  "US-IL",
  "EU",
] as const;

export type JurisdictionCode = (typeof PLATFORM_FLOOR_JURISDICTIONS)[number];

/* EU member state names (English + the most common native spellings).
 * Used as a coarse EU filter — we do not currently distinguish DE vs FR
 * because the EU AI Act applies uniformly to all member states. */
const EU_MEMBER_HINTS = [
  "european union", "eu",
  "austria", "österreich",
  "belgium", "belgique", "belgië",
  "bulgaria", "българия",
  "croatia", "hrvatska",
  "cyprus", "κύπρος",
  "czechia", "czech republic", "česko",
  "denmark", "danmark",
  "estonia", "eesti",
  "finland", "suomi",
  "france",
  "germany", "deutschland",
  "greece", "ελλάδα",
  "hungary", "magyarország",
  "ireland", "éire",
  "italy", "italia",
  "latvia", "latvija",
  "lithuania", "lietuva",
  "luxembourg",
  "malta",
  "netherlands", "nederland", "holland",
  "poland", "polska",
  "portugal",
  "romania", "românia",
  "slovakia", "slovensko",
  "slovenia", "slovenija",
  "spain", "españa",
  "sweden", "sverige",
];

const NYC_HINTS = [
  "new york city", "nyc", "new york, ny", "manhattan", "brooklyn",
  "queens", "the bronx", "bronx", "staten island", "ny, ny",
];

const NY_STATE_HINTS = [
  "new york", "ny,", " ny", "new york state",
];

const CO_HINTS = [
  "colorado", " co,", " co ", "colorado,", "denver", "boulder",
  "colorado springs", "aurora, co", "fort collins", "lakewood, co",
  "thornton, co", "arvada, co", "westminster, co",
];

const IL_HINTS = [
  "illinois", " il,", " il ", "illinois,", "chicago", "naperville",
  "aurora, il", "joliet", "rockford", "elgin", "peoria",
  "springfield, il",
];

/** Lower-case + collapse whitespace for matching. */
function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return ` ${s.toLowerCase().replace(/\s+/g, " ").trim()} `;
}

/**
 * Inspect a single free-text location string and return any jurisdiction
 * codes that apply. Returns [] only when the string is non-empty AND we
 * can confidently say it lies outside every platform-floor jurisdiction.
 */
export function classifyLocation(raw: string | null | undefined): JurisdictionCode[] {
  const norm = normalize(raw);
  if (!norm.trim()) {
    /* Unknown location → default gated to ALL floor jurisdictions.
     * Costs a human review; avoids a regulatory miss. */
    return [...PLATFORM_FLOOR_JURISDICTIONS];
  }

  const out = new Set<JurisdictionCode>();

  if (NYC_HINTS.some((h) => norm.includes(h))) out.add("US-NY-NYC");
  /* "New York" state matches conservatively → still flag NYC because we
   * cannot rule out that the candidate is in the five boroughs. */
  else if (NY_STATE_HINTS.some((h) => norm.includes(h))) out.add("US-NY-NYC");

  if (CO_HINTS.some((h) => norm.includes(h))) out.add("US-CO");
  if (IL_HINTS.some((h) => norm.includes(h))) out.add("US-IL");
  if (EU_MEMBER_HINTS.some((h) => norm.includes(h))) out.add("EU");

  /* Remote-tagged candidates: cannot rule out NYC/CO/IL/EU. Gate.
   * "Remote, US" we still gate to the US floor jurisdictions. */
  if (norm.includes("remote")) {
    out.add("US-NY-NYC");
    out.add("US-CO");
    out.add("US-IL");
    if (!norm.includes("us only") && !norm.includes("us-only") && !norm.includes("united states only")) {
      out.add("EU");
    }
  }

  return [...out];
}

/**
 * Classify a (candidate, job) pair. A jurisdiction is triggered when
 * EITHER side touches it — regulators care about impact on the worker
 * and the job-market jurisdiction, not server location.
 */
export function classifyJurisdictions(
  candidateLocation: string | null | undefined,
  jobLocation: string | null | undefined,
): JurisdictionCode[] {
  const candidate = classifyLocation(candidateLocation);
  const job = classifyLocation(jobLocation);
  const union = new Set<JurisdictionCode>([...candidate, ...job]);
  return [...union];
}
