/**
 * Interview answer quality for the candidate readiness score.
 *
 * History: the original metric was purely structural — character count
 * (avg length vs a 120-char benchmark) + substantive-answer ratio. That
 * rewarded verbose padding and punished short, dense, excellent answers
 * (same structure-over-substance failure mode fixed in the interview
 * grader rubric on 2026-07-07, but in a separate mechanism).
 *
 * This version scores VERIFIABLE SUBSTANCE, not volume:
 *  1. substantiveRatio (weight 0.35) — fraction of the candidate's turns
 *     that are real answers (>= 30 chars). Unchanged: one-word replies
 *     still earn nothing.
 *  2. substanceScore (weight 0.45) — per-answer evidence of specifics:
 *     numbers / percentages / currency / dates ("grew revenue 40%",
 *     "team of 12", "2019-2023"), named tools & proper nouns mentioned
 *     mid-sentence ("migrated to Kubernetes", "led the Visa integration"),
 *     and lexical density (unique-token ratio — padding and repetition
 *     lower it, dense answers raise it).
 *  3. depthScore (weight 0.20, was 0.60) — average answer length is now a
 *     minor signal only, and the full-credit benchmark is 100 chars.
 *
 * Fairness notes (candidate-facing score):
 *  - All substance signals are script-agnostic where possible (digits and
 *    currency work in any language). For space-less scripts (CJK etc.)
 *    tokenisation is unreliable, so lexical density falls back to a
 *    NEUTRAL value rather than penalising the answer.
 *  - Proper-noun detection only applies to Latin-script text and can only
 *    help, never hurt, an answer.
 */

export interface QualityTurn {
  role: string;
  content: string;
}

const SUBSTANTIVE_MIN = 30; // chars — below this = effectively no answer
const GOOD_ANSWER_LEN = 100; // chars — minor depth signal benchmark

/** Per-answer substance in [0, 1] from verifiable-specificity markers. */
export function answerSubstance(text: string): number {
  const t = text.trim();
  if (t.length === 0) return 0;

  // 1. Hard specifics: numbers (counts, years, percentages), currency.
  //    Script-agnostic — digits are digits in any language.
  const numberMarkers = (t.match(/\d+(?:[.,:]\d+)*%?/g) ?? []).length;
  const currencyMarkers = (t.match(/[$€£₹¥]/g) ?? []).length;

  // 2. Named tools / orgs / people: capitalized tokens that are NOT at the
  //    start of a sentence (Latin script best-effort; can only add credit).
  const midSentenceProper = (t.match(/(?<![.!?]\s|^)(?<=\s)[A-Z][A-Za-z0-9+#.-]{2,}/g) ?? [])
    .length;

  // Anti-gaming prose gate: markers only count when embedded in real prose.
  // An answer that is mostly digits ("1 2 3 4 5 ...") earns no marker credit.
  // Script-agnostic: any non-digit, non-space character counts as prose
  // (Latin letters, CJK, Devanagari, Arabic, ...).
  const proseChars = t.replace(/[\d\s%.,:;$€£₹¥-]/g, "").length;
  const proseGate = Math.min(1, proseChars / 40);

  // 3+ combined markers = full marker credit (scaled by the prose gate).
  const markerScore =
    Math.min(1, (numberMarkers + currencyMarkers + Math.min(midSentenceProper, 2)) / 3) * proseGate;

  // 3. Lexical density over WORD tokens (numeric tokens excluded so numeric
  //    spam cannot inflate uniqueness). Verbose padding and filler
  //    repetition drive this DOWN; short dense answers keep it high.
  const tokens = t
    .toLowerCase()
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && /[^\d%.,:;-]/.test(tok));
  let densityScore: number;
  if (tokens.length < 8) {
    // Too few whitespace word-tokens to judge. Either a genuinely short
    // answer or a space-less script (CJK). Stay NEUTRAL — never penalise
    // a script for how it tokenises.
    densityScore = 0.6;
  } else {
    const density = new Set(tokens).size / tokens.length;
    // 0.45 or below → 0 (heavy repetition), 0.80+ → 1 (dense, varied).
    densityScore = Math.max(0, Math.min(1, (density - 0.45) / 0.35));
  }

  // Anti-gaming repetition penalty: heavy repetition ("blah blah ... 40%")
  // halves whatever marker credit remains instead of merely diluting it.
  const repetitionMultiplier = 0.5 + 0.5 * densityScore;

  return (0.6 * markerScore + 0.4 * densityScore) * repetitionMultiplier;
}

/**
 * Compute how substantive the candidate's interview answers were (0-100).
 * Minimum returned is 5 (avoids divide-by-zero edge cases downstream).
 */
export function computeInterviewQuality(history: QualityTurn[]): number {
  const candidateMsgs = history.filter((m) => m.role === "user");
  if (candidateMsgs.length === 0) return 5;

  const substantive = candidateMsgs.filter((m) => m.content.trim().length >= SUBSTANTIVE_MIN);
  const substantiveRatio = substantive.length / candidateMsgs.length;

  if (substantive.length === 0) return 5;

  const substanceScore =
    substantive.reduce((acc, m) => acc + answerSubstance(m.content), 0) / substantive.length;

  const avgLen =
    substantive.reduce((acc, m) => acc + m.content.trim().length, 0) / substantive.length;
  const depthScore = Math.min(1, avgLen / GOOD_ANSWER_LEN);

  const quality = 0.35 * substantiveRatio + 0.45 * substanceScore + 0.2 * depthScore;
  return Math.max(5, Math.min(100, Math.round(quality * 100)));
}
