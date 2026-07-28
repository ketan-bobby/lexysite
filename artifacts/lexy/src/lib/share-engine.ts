/**
 * lib/share-engine.ts — Viral Share Content Engine
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Transforms raw Lexy intelligence scores into shareable social-media content.
 * Zero external dependencies — derives everything from the intelligence data
 * already present in the app. Does not call any API or modify any core logic.
 *
 * ─── Core functions ──────────────────────────────────────────────────────────
 *   extractInsight(scores, signals, name?)  Build a LexyInsight object from raw
 *                                   engine outputs. Normalises all scores to
 *                                   [0, 100], derives a tier label, approximates a
 *                                   percentile, and picks the dominant signals.
 *   generateCaptions(insight, name?)  Generate three caption variants (LinkedIn /
 *                                   X / reflective) using rule-based templates.
 *
 * ─── Types ───────────────────────────────────────────────────────────────────
 *   LexyScores     — raw score fields from the intelligence engine
 *   LexySignals    — structured screening / interview / verification data
 *   LexyInsight    — the normalised, shareable snapshot derived from both
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/share/ShareCard.tsx   — renders the insight as a visual card
 *   components/share/ShareModal.tsx  — generates captions for the share dialog
 */

/* ── Types ─────────────────────────────────────────────────────────────── */

export interface LexyScores {
  fitScore?: number | null;
  qualityScore?: number | null;
  trustScore?: number | null;
  conversionScore?: number | null;
  hireProbability?: number | null;
  talentMatchScore?: number | null;
}

export interface LexySignals {
  screening?: {
    resumeMatchScore?: number | null;
    skillMatchScore?: number | null;
    score?: number | null;
    strengthAreas?: string[];
    gapAreas?: string[];
    gapFlags?: string[];
  };
  interview?: {
    communicationScore?: number | null;
    technicalDepthScore?: number | null;
    behavioralScore?: number | null;
    answerQualityScore?: number | null;
    interviewScore?: number | null;
    strengths?: string[];
    weaknesses?: string[];
  };
  verification?: {
    identityConfidence?: number | null;
    verdict?: string | null;
  };
  proctoring?: {
    integrityScore?: number | null;
  };
}

export interface LexyInsight {
  /** 0-100 approximated percentile vs typical candidates in the system */
  percentile_rank: number;
  /** Short identity label for this candidate */
  identity_label: string;
  /** The single strongest trait */
  strongest_trait: string;
  /** The single biggest improvement area */
  biggest_gap: string;
  /** One-sentence summary */
  short_summary: string;
  /** The three key signals for the share card */
  signals: {
    communication: { label: string; score: number; color: string };
    problem_solving: { label: string; score: number; color: string };
    role_fit: { label: string; score: number; color: string };
  };
  /** Raw composite score (hireProbability or talentMatchScore) */
  composite_score: number;
  /** Tier label */
  tier: "Exceptional" | "Strong" | "Promising" | "Developing";
}

export interface ShareCaptions {
  linkedin: string;
  x: string;
  reflective: string;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

import { bandBy } from "./score-band";

function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function scoreColor(score: number): string {
  // Collapsed to the canonical 3-band match colours (was a bespoke 4-colour ramp).
  return bandBy(score, { strong: "#4ade80", good: "#facc15", fair: "#fb7185" });
}

/** Approximate percentile from composite score using an S-curve */
function approximatePercentile(score: number): number {
  // Most candidates cluster around 45-70. Map score → percentile.
  // Deterministic: the same score must always produce the same percentile
  // (this appears on a shareable public artifact — no jitter).
  if (score >= 90) return clamp(97 - (score % 2));
  if (score >= 80) return clamp(88 + Math.floor((score - 80) / 2));
  if (score >= 70) return clamp(72 + Math.floor((score - 70) * 1.5));
  if (score >= 60) return clamp(52 + Math.floor((score - 60) * 2));
  if (score >= 50) return clamp(32 + Math.floor((score - 50) * 2));
  return clamp(score * 0.6);
}

// Identity-tier ladder for the shareable card: a 4-level DESCRIPTIVE rubric,
// finer-grained than the 3-band match colour and a distinct presentational
// quantity — its boundaries are its own, not the canonical match cutoffs.
const TIER_EXCEPTIONAL_MIN = 80;
const TIER_STRONG_MIN = 65;
const TIER_PROMISING_MIN = 50;
// Copy toggle: at/above this composite the snapshot says "candidates analysed",
// below it "profiles in the pool" — a prose threshold, not a colour band.
const ANALYSED_POOL_COPY_MIN = 70;
function deriveTier(score: number): LexyInsight["tier"] {
  if (score >= TIER_EXCEPTIONAL_MIN) return "Exceptional";
  if (score >= TIER_STRONG_MIN) return "Strong";
  if (score >= TIER_PROMISING_MIN) return "Promising";
  return "Developing";
}

const IDENTITY_LABELS: Record<LexyInsight["tier"], string[]> = {
  Exceptional: [
    "Ready-to-hire talent — top 10% of applicants",
    "High-impact hire — exceptional across all signals",
    "Elite candidate — rare cross-signal strength",
  ],
  Strong: [
    "Strong fit for this role and team",
    "Reliable performer with clear upside potential",
    "Solid candidate with standout communication skills",
  ],
  Promising: [
    "Emerging talent with strong core fundamentals",
    "Growth-oriented candidate with transferable strengths",
    "Solid foundation — ready to accelerate",
  ],
  Developing: [
    "Early-stage candidate with identified growth areas",
    "Foundational skills in place — coaching potential",
    "Developing talent — best fit with mentorship support",
  ],
};

/* ── Percentile display floor ──────────────────────────────────────────────
 * The share card/captions are PUBLIC artifacts the candidate posts under
 * their own name. A raw "Top 82%" is a self-published bad rank the platform
 * generated for them. Rule: only render a "Top N%" figure when it's at least
 * as good as "Top 50%"; below that, callers must fall back to the tier /
 * identity label (growth-framed, no number). */
const TOP_PERCENT_DISPLAY_FLOOR = 50;
export function topPercentLabel(percentile_rank: number): string | null {
  const topN = 100 - percentile_rank + 1;
  return topN <= TOP_PERCENT_DISPLAY_FLOOR ? `Top ${topN}%` : null;
}

function pickLabel(tier: LexyInsight["tier"], score: number): string {
  const pool = IDENTITY_LABELS[tier];
  // Deterministic: use score to pick from pool so label is stable per candidate
  return pool[score % pool.length];
}

/* ── Insight Extractor ─────────────────────────────────────────────────── */

export function extractInsight(
  scores: LexyScores,
  signals: LexySignals,
  candidateName?: string,
): LexyInsight {
  // Resolve composite score — prefer hireProbability, fall back to talentMatchScore, then average
  const composite = clamp(
    scores.hireProbability ??
    scores.talentMatchScore ??
    (((scores.fitScore ?? 60) + (scores.qualityScore ?? 60) + (scores.trustScore ?? 60) + (scores.conversionScore ?? 60)) / 4),
  );

  const tier = deriveTier(composite);
  const percentile_rank = approximatePercentile(composite);
  const identity_label = pickLabel(tier, composite);

  // Derive the three card signals
  const commScore = clamp(
    signals.interview?.communicationScore ??
    signals.interview?.behavioralScore ??
    scores.qualityScore ??
    60,
  );

  const psScore = clamp(
    signals.interview?.technicalDepthScore ??
    signals.interview?.answerQualityScore ??
    scores.fitScore ??
    60,
  );

  const rfScore = clamp(
    signals.screening?.skillMatchScore ??
    signals.screening?.resumeMatchScore ??
    scores.fitScore ??
    scores.talentMatchScore ??
    60,
  );

  // Derive strongest trait
  // Prefer screening strength areas (from resume analysis — always English) over
  // interview strengths which may be in the candidate's native language.
  const strengthSources: string[] = [
    ...(signals.screening?.strengthAreas ?? []),
    ...(signals.interview?.strengths ?? []),
  ];

  let strongest_trait: string;
  if (strengthSources.length > 0) {
    strongest_trait = strengthSources[0];
  } else {
    const maxPair = [
      ["Communication", commScore],
      ["Problem solving", psScore],
      ["Role fit alignment", rfScore],
      ["Analytical depth", scores.qualityScore ?? 0],
      ["Trust & verification", scores.trustScore ?? 0],
    ].sort((a, b) => (b[1] as number) - (a[1] as number));
    strongest_trait = maxPair[0][0] as string;
  }

  // Derive biggest gap
  // Prefer screening gap areas (resume analysis — always English) over interview
  // weaknesses which may be in the candidate's native language.
  const gapSources: string[] = [
    ...(signals.screening?.gapAreas ?? []),
    ...(signals.screening?.gapFlags ?? []),
    ...(signals.interview?.weaknesses ?? []),
  ];

  let biggest_gap: string;
  if (gapSources.length > 0) {
    biggest_gap = gapSources[0];
  } else {
    const minPair = [
      ["Communication under pressure", commScore],
      ["Technical depth", psScore],
      ["Domain-specific experience", rfScore],
      ["Interview performance", scores.qualityScore ?? 0],
      ["Verification completeness", scores.trustScore ?? 0],
    ].sort((a, b) => (a[1] as number) - (b[1] as number));
    biggest_gap = minPair[0][0] as string;
  }

  // Short summary
  const name = candidateName ? `${candidateName.split(" ")[0]}` : "This candidate";
  const tierAdj = { Exceptional: "exceptionally", Strong: "strongly", Promising: "solidly", Developing: "steadily" }[tier];
  const pctLabel = topPercentLabel(percentile_rank);
  const short_summary = pctLabel
    ? `${name} ${tierAdj} aligns with the role — scoring in the ${pctLabel.toLowerCase()} with a standout in ${strongest_trait.toLowerCase()}.`
    : `${name} ${tierAdj} aligns with the role — with a standout in ${strongest_trait.toLowerCase()} and a clear growth path.`;

  return {
    percentile_rank,
    identity_label,
    strongest_trait,
    biggest_gap,
    short_summary,
    composite_score: composite,
    tier,
    signals: {
      communication: { label: "Communication", score: commScore, color: scoreColor(commScore) },
      problem_solving: { label: "Problem Solving", score: psScore, color: scoreColor(psScore) },
      role_fit: { label: "Role Fit", score: rfScore, color: scoreColor(rfScore) },
    },
  };
}

/* ── Caption Generator ─────────────────────────────────────────────────── */

export function generateCaptions(insight: LexyInsight, candidateName?: string): ShareCaptions {
  const first = candidateName?.split(" ")[0] ?? "I";
  const isFirstPerson = !candidateName;
  const subject = isFirstPerson ? "I" : first;
  const possessive = isFirstPerson ? "My" : `${first}'s`;
  const { percentile_rank, strongest_trait, biggest_gap, tier, composite_score, identity_label } = insight;
  const pctLabel = topPercentLabel(percentile_rank);

  const linkedin = `${possessive} Lexy AI Career Snapshot just came in — and it's eye-opening.

${pctLabel
    ? `${subject} scored in the ${pctLabel.toLowerCase()} of candidates analysed by Lexy's intelligence engine.`
    : `Lexy's intelligence engine mapped ${isFirstPerson ? "my" : `${first}'s`} profile: ${identity_label.toLowerCase()}.`}

✅ Strongest signal: ${strongest_trait}
📍 Growth edge: ${biggest_gap}

What stood out? Lexy doesn't just score — it explains *why*. The AI pinpoints exactly where ${isFirstPerson ? "I" : "they"} shine and where the real opportunity for growth lives.

${tier === "Exceptional" || tier === "Strong" ? "If you're hiring for a high-impact role, this is the kind of signal-backed profile that cuts through the noise." : "Transparency like this is rare in hiring. Knowing your gaps is the first step to closing them."}

Curious what your Lexy profile says about you? 👇
#Hiring #TalentIntelligence #CareerGrowth #LexyAI`;

  const x = `Just got my Lexy AI career snapshot.

${pctLabel
    ? `${pctLabel} of ${composite_score >= ANALYSED_POOL_COPY_MIN ? "candidates analysed" : "profiles in the pool"}.`
    : `${identity_label}.`}

💪 Strength: ${strongest_trait}
📈 Gap: ${biggest_gap}

The AI doesn't sugarcoat it — and that's exactly what makes it useful.

Get yours 👇 #LexyAI #Hiring`;

  const reflective = `Getting honest feedback about yourself is uncomfortable. Getting it from AI is… weirdly liberating.

Lexy analysed ${isFirstPerson ? "my" : `${first}'s`} hiring profile and surfaced something I didn't expect — ${pctLabel
    ? `${isFirstPerson ? "I" : "they"} rank in the ${pctLabel.toLowerCase()} overall, but ${biggest_gap.toLowerCase()} is still a real gap to close.`
    : `${isFirstPerson ? "my" : "their"} ${strongest_trait.toLowerCase()} is a genuine strength, and ${biggest_gap.toLowerCase()} is the clearest place to grow next.`}

${possessive} strongest signal — ${strongest_trait.toLowerCase()} — is something ${isFirstPerson ? "I've" : "they've"} built over time without realising how valuable it was to an employer.

That contrast — knowing what you're genuinely good at *and* what you need to work on — is the clearest career development signal I've seen come out of a hiring tool.

If you want that kind of clarity, try Lexy. It's honest in a way most feedback isn't.`;

  return { linkedin, x, reflective };
}
