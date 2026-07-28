/* ─────────────────────────────────────────────────────────────────────────
   Outreach guardrail validator
   ---------------------------------------------------------------------------
   The prompt rules tell the model not to hallucinate role facts or raise
   relocation in cold outreach, but no prompt is obeyed 100% of the time. This
   module is the deterministic safety net: it inspects the GENERATED email and
   reports concrete violations so callers can regenerate or sanitize before a
   candidate ever sees it.

   Rules enforced:
   1. No relocation / moving / commute talk in cold outreach (sensitive,
      human-handled late-stage topic) — regardless of work arrangement.
   2. For REMOTE roles, the email must not contradict the role by implying
      on-site / in-office attendance.
   ───────────────────────────────────────────────────────────────────────── */

// "relocate", "relocation", "relocating", "re-locate", "commute", "commuting".
// Deliberately narrow so innocent words ("community", "communication", "remove",
// "improve") are NOT matched — "commut" only matches commute/commuter/commuting.
export const RELOCATION_RE = /\b(re-?locat\w*|commut\w*)\b/i;

// "move / moving" used in a relocation sense. The bare word "move" is far too
// common in normal copy ("move forward", "a great move for your career", "move
// the needle"), so we only flag it when it is framed as relocation:
//   • openness framing  — "open to moving", "willing to move", "considering moving"
//   • destination framing — "move to <place>", "moving closer", "relocate abroad"
// "move forward" is explicitly excluded to avoid the most common false positive.
export const MOVING_RE = new RegExp(
  [
    // openness / willingness + move(ing), but never "... move forward"
    "\\b(?:open to|willing to|able to|comfortable(?: with)?|considering|interested in|prepared to|happy to|would you(?: be)?(?: open to| willing to)?)\\s+mov(?:e|ing)\\b(?!\\s+forward)",
    // move(ing) + relocation-style destination
    "\\bmov(?:e|ing)\\s+(?:closer|abroad|overseas|across|to\\s+(?:a\\s+new\\s+(?:city|location|area|region|country)|our\\s+(?:office|hq|headquarters|city|area)|the\\s+(?:office|area|region|city|country)))",
  ].join("|"),
  "i",
);

// On-site / in-office language that contradicts a remote role.
export const ONSITE_RE = /\b(on-?site|in-?office|in the office|on[- ]premises?|come into the office|work from (the )?office)\b/i;

export interface GuardrailContext {
  /** "remote" | "hybrid" | "onsite" | null/undefined */
  workType?: string | null;
}

export interface GuardrailViolation {
  code: "relocation" | "remote_contradiction";
  message: string;
}

/** True if the text raises relocation/moving/commuting in any flagged form. */
export function hasRelocationLanguage(text: string): boolean {
  const hay = text || "";
  return RELOCATION_RE.test(hay) || MOVING_RE.test(hay);
}

/** Inspect generated outreach text (pass subject + body together) and return
 *  any guardrail violations found. Empty array = clean. */
export function findOutreachViolations(
  text: string,
  ctx: GuardrailContext = {},
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const hay = text || "";

  if (hasRelocationLanguage(hay)) {
    violations.push({
      code: "relocation",
      message: "mentions relocation/moving/commuting (not allowed in cold outreach)",
    });
  }

  if (ctx.workType === "remote" && ONSITE_RE.test(hay)) {
    violations.push({
      code: "remote_contradiction",
      message: "role is remote but the email implies on-site/in-office work",
    });
  }

  return violations;
}

/** Drop any sentence in `text` that trips a guardrail. Relocation/moving/commute
 *  sentences are always removed; on-site/in-office sentences are removed only for
 *  remote roles (where they contradict the role). Returns the cleaned text. */
export function stripViolatingSentences(
  text: string,
  ctx: GuardrailContext = {},
): string {
  if (!text) return text;
  const remote = ctx.workType === "remote";
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      if (hasRelocationLanguage(sentence)) return false;
      if (remote && ONSITE_RE.test(sentence)) return false;
      return true;
    })
    .join(" ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Backwards-compatible alias. Prefer {@link stripViolatingSentences}. */
export const stripRelocationSentences = (body: string): string =>
  stripViolatingSentences(body);

export interface OutreachDraft {
  subject?: string | null;
  body?: string | null;
}

export interface EnforcedOutreach {
  subject: string;
  body: string;
  /** Violations that remained after sanitizing (should always be empty). */
  violations: GuardrailViolation[];
  /** True if any sanitization was applied. */
  sanitized: boolean;
}

/** Final, guaranteed-clean enforcement step. Call this on the draft you are
 *  about to persist/send (after any regeneration attempts). It sanitizes BOTH
 *  the subject and the body, and — if sanitizing empties the body — substitutes
 *  a neutral, fact-free fallback so a candidate never receives a blank or
 *  guardrail-violating message. Idempotent and side-effect free. */
export function enforceOutreachGuardrails(
  draft: OutreachDraft,
  ctx: GuardrailContext = {},
): EnforcedOutreach {
  const rawSubject = (draft.subject ?? "").trim();
  const rawBody = (draft.body ?? "").trim();

  const before = findOutreachViolations(`${rawSubject}\n${rawBody}`, ctx);
  if (before.length === 0) {
    return { subject: rawSubject, body: rawBody, violations: [], sanitized: false };
  }

  let subject = stripViolatingSentences(rawSubject, ctx).trim();
  let body = stripViolatingSentences(rawBody, ctx).trim();

  // A subject is a single line; if sanitizing emptied it, use a safe generic one.
  if (!subject) subject = "Quick question";
  // If the body collapsed to nothing, fall back to a neutral, fact-free note
  // rather than sending an empty email.
  if (!body) {
    body =
      "Hi there,\n\nI came across your profile and thought your background could be a strong fit for a role we're hiring for. Would you be open to a quick 15-minute chat this week?\n\nAlex, Talent Team";
  }

  const after = findOutreachViolations(`${subject}\n${body}`, ctx);
  return { subject, body, violations: after, sanitized: true };
}
