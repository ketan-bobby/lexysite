/**
 * lib/fairness.ts — Algorithmic fairness guardrails
 *
 * Single source of truth for bias-mitigation applied to every place an LLM
 * scores, ranks, screens, or evaluates a candidate. Two exports:
 *
 *   • FAIRNESS_DIRECTIVE — a mandatory instruction appended to the system
 *     prompt of every candidate-evaluating model call. It forbids the model
 *     from considering protected characteristics or their common proxies
 *     (employer/school prestige, graduation years, name-inferred gender, etc.)
 *     and confines judgement to bona-fide, job-relevant qualifications.
 *
 *   • redactPii(text, names) — strips personally-identifying and protected
 *     details from free text (resumes, transcripts) BEFORE it reaches a model,
 *     so the model literally cannot see name/contact/DOB/etc. This is the
 *     "blind screening" technique: the most robust debiasing is to remove the
 *     biasing input entirely, not merely to instruct the model to ignore it.
 *
 * Both are intentionally model-agnostic and dependency-free so every
 * evaluation entrypoint can apply them consistently. Keeping this in one place
 * prevents drift where one scorer is debiased and another is not.
 */

/**
 * Mandatory fairness instruction. Append to the SYSTEM prompt (not the data)
 * of any model call that scores, ranks, screens, or evaluates a candidate.
 */
export const FAIRNESS_DIRECTIVE =
  "FAIRNESS REQUIREMENTS (mandatory, override any conflicting guidance): " +
  "Evaluate the candidate strictly on bona-fide, job-relevant qualifications, skills, and demonstrated competencies. " +
  "You MUST NOT consider, infer, reward, or penalize — directly or as a proxy — any of the following: " +
  "name; gender, pronouns, or sex; race, color, or ethnicity; national origin, nationality, or citizenship; " +
  "age, date of birth, or graduation/start years used to infer age; religion or creed; disability, health, or neurodivergence; " +
  "pregnancy, marital, or family/caregiver status; sexual orientation or gender identity; " +
  "the prestige, brand, ranking, or selectivity of the candidate's schools or employers (judge the substance of the experience, not the logo); " +
  "employment gaps or non-linear career paths in themselves; accent, dialect, grammar, or fluency where it does not impair job-relevant communication; " +
  "or physical appearance/photographs. If an attribute is not a genuine requirement of the role, ignore it entirely.";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin\.com|github\.com|twitter\.com|x\.com|facebook\.com)\/\S+/gi;
// Phone numbers only. Requires a phone-shaped grouping that totals >= 10 digits
// (US/international), so two-group year ranges like "2019-2021" (8 digits) and
// other date spans are NOT matched. A digit-count guard in the replace callback
// is a second line of defense against false positives.
const PHONE_RE = /(?:\+\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g;
// Labeled protected/personal fields commonly found on resumes/CVs.
const LABELED_RE =
  /\b(date of birth|d\.?o\.?b\.?|birth\s?date|gender|sex|marital status|nationality|citizenship|\bage\b|religion|race|ethnicity|visa status|pronouns)\b\s*[:\-]?[ \t]*.*/gim;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove personally-identifying and protected details from free text before it
 * is fed to a model. `names` lets the caller redact the candidate's own name
 * tokens with high precision (free-text name detection is otherwise unreliable).
 * Best-effort and lossless to job-relevant content: skills, titles, and
 * accomplishments are preserved.
 */
export function redactPii(text: string | null | undefined, names: string[] = []): string {
  if (!text) return "";
  let out = String(text);
  out = out.replace(EMAIL_RE, "[redacted-email]");
  out = out.replace(URL_RE, "[redacted-url]");
  // Only redact a phone match if it actually contains >= 10 digits; this
  // guards against any residual false positive (e.g. spaced date sequences).
  out = out.replace(PHONE_RE, (m) => ((m.match(/\d/g)?.length ?? 0) >= 10 ? "[redacted-phone]" : m));
  out = out.replace(LABELED_RE, "[redacted-personal-detail]");
  for (const raw of names) {
    const n = (raw ?? "").trim();
    if (n.length >= 2) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(n)}\\b`, "gi"), "[redacted-name]");
    }
  }
  return out;
}
