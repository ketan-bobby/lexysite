/**
 * outreach-generate.ts — First-touch cold outreach draft generator
 *
 * The single source of truth for producing a personalized first-touch outreach
 * email (subject, body, follow-up schedule). Shared by BOTH the orchestrator
 * (initial generation) and the reject endpoint (regeneration with recruiter
 * feedback) so the two callers stay byte-for-byte identical.
 *
 * Pipeline: build prompt (language + relocation/role guardrails + optional
 * brand context) → generateJSON → verify against deterministic guardrails →
 * retry once on violation → final enforcement/sanitize → strip AI CTA buttons.
 *
 * Notable exports: generateFirstTouchDraft, plus the FirstTouch* context/draft
 * interfaces.
 */
import { generateJSON } from "./ai";
import { stripAiCtaButtons } from "./outreach-engine";
import { findOutreachViolations, enforceOutreachGuardrails } from "./outreach-guardrails";
import { logger } from "./logger";

export interface FirstTouchCandidateCtx {
  name: string;
  currentTitle?: string | null;
  currentCompany?: string | null;
  skills?: string[] | null;
}

export interface FirstTouchJobCtx {
  title?: string | null;
  location?: string | null;
  workType?: string | null;
  company?: string | null;
  language?: string | null;
  /** Short role/JD summary. Truncated before injection to keep the prompt bounded. */
  description?: string | null;
}

export interface FirstTouchDraft {
  subject: string;
  body: string;
  tone?: string;
  callToAction?: string;
  followUpSchedule: Array<{ dayOffset: number; message: string }>;
  estimatedOpenRate?: number;
}

/**
 * Generate a first-touch cold outreach draft for a candidate/role.
 *
 * Single source of truth used by BOTH the orchestrator (initial generation)
 * and the reject endpoint (regeneration with recruiter feedback). The prompt,
 * guardrail verification, retry-on-violation, deterministic enforcement, and
 * CTA-stripping all live here so the two callers stay byte-for-byte identical.
 *
 * When `feedback` is supplied (a recruiter's rejection reason), it is injected
 * so the new draft directly addresses why the previous one was rejected.
 */
export async function generateFirstTouchDraft(opts: {
  candidate: FirstTouchCandidateCtx;
  job: FirstTouchJobCtx;
  feedback?: string;
  /** Pre-rendered tenant brand + role context block (see ai-message-context.ts).
   *  Injected as reference DATA; the role-accuracy/relocation guardrails below
   *  still take precedence over anything it contains. */
  contextBlock?: string;
  /** True when the contextBlock carries real company brand material (brand
   *  profile and/or distilled company documents). Drives whether the email
   *  sells the opportunity through the company's values/mission, or focuses on
   *  the role alone (when no brand material is available). */
  hasBrandContext?: boolean;
  logCtx?: Record<string, unknown>;
}): Promise<FirstTouchDraft> {
  const { candidate, job, feedback, contextBlock, hasBrandContext } = opts;
  const logCtx = opts.logCtx ?? {};

  const candidateCtx = {
    name: candidate.name,
    currentTitle: candidate.currentTitle ?? undefined,
    currentCompany: candidate.currentCompany ?? undefined,
    skills: candidate.skills?.slice(0, 5),
  };
  const jobCtx = {
    title: job.title ?? undefined,
    location: job.location ?? undefined,
    workType: job.workType ?? undefined,
    company: job.company ?? undefined,
    language: job.language ?? undefined,
    description: job.description ? job.description.slice(0, 800) : undefined,
  };

  const outreachLang = jobCtx.language ?? "en";
  const langInstruction = outreachLang !== "en"
    ? `IMPORTANT: Write the entire email — subject, body, and call to action — in the language with code "${outreachLang}". Do NOT write in English.`
    : "Write in English.";

  // Work-arrangement guardrail. Even though jobCtx carries workType, the
  // model will happily ask a candidate for a REMOTE role whether they're
  // open to relocating unless explicitly forbidden. Relocation is a
  // sensitive late-stage topic, never raised in cold outreach.
  const relocationGuardrail = jobCtx.workType === "remote"
    ? `- This role is REMOTE. State or imply it is remote-friendly. NEVER ask whether the candidate is open to relocating, commuting, or moving — relocation is irrelevant for a remote role and makes the outreach look careless and automated.`
    : `- NEVER ask whether the candidate is open to relocating, moving, or commuting. Relocation is a sensitive late-stage topic handled by a human recruiter, never raised in cold outreach.`;

  // Recruiter rejection feedback (regeneration only). Placed up top so the
  // model treats it as the primary instruction for the rewrite.
  const feedbackInstruction = feedback && feedback.trim().length > 0
    ? `A recruiter REJECTED the previous draft of this email with the following feedback:
"""
${feedback.trim()}
"""
Write a NEW, different version that directly addresses this feedback. Do not repeat the rejected approach.

`
    : "";

  const contextSection = contextBlock && contextBlock.trim().length > 0
    ? `${contextBlock.trim()}

`
    : "";

  // Persuasion strategy. When real company brand material is present, the email
  // should SELL the opportunity through the company's mission/values/culture so
  // it feels human and compelling — not a restatement of the work-order fields.
  // When no brand material is available, focus on the role itself and never
  // invent company values/mission/culture that aren't provided.
  const persuasionInstruction = hasBrandContext
    ? `MAKE THIS EMAIL GENUINELY ENTICING — your goal is to make the candidate WANT to reply:
- Lead with a specific, personalized hook tied to the candidate's background, then connect it to why THIS company and THIS role are a compelling move for them.
- Draw on the COMPANY & BRAND / COMPANY DOCUMENTS context above to convey what the company stands for — its mission, values, culture, and the impact this person could have. Sell the opportunity through values and impact, not a checklist of requirements.
- Mirror the company's brand voice/tone from that context.`
    : `No company brand material is provided, so focus the email on the ROLE itself — the work, the team, the impact, and why it's a strong next move for this candidate. Keep it warm and human. Do NOT invent company mission, values, or culture that are not provided.`;

  const outreachPrompt =
    `Write a personalized outreach email for this candidate about this role.

${feedbackInstruction}${contextSection}${persuasionInstruction}

${langInstruction}

Candidate: ${JSON.stringify(candidateCtx, null, 2)}
Role: ${JSON.stringify(jobCtx, null, 2)}

Return JSON:
{
  "subject": string (compelling email subject, in the required language),
  "body": string (2-3 short paragraphs, personalized, friendly, not salesy, in the required language),
  "tone": "professional" | "friendly" | "casual",
  "callToAction": string (in the required language),
  "estimatedOpenRate": number (0-100),
  "followUpSchedule": [{ "dayOffset": number, "message": string (in the required language) }]
}

Role-accuracy rules (CRITICAL — do not misrepresent the role):
${relocationGuardrail}
- Use ONLY the role facts given above (title, location, work arrangement). Do NOT invent or contradict details (work arrangement, location, salary, seniority). If a detail isn't provided, leave it out rather than guessing.

Body rules (CRITICAL — violations create duplicate buttons in the candidate's inbox):
- Plain prose only. NO buttons, NO CTA buttons, NO action buttons, NO button-shaped text.
- NO HTML tags (no <button>, <a>, <input>, <table>, <div>).
- NO markdown links, NO "click here" links, NO bracketed [Yes I'm interested] / [Not interested] / [Don't contact] options.
- NO lists of multiple-choice canned replies at the end.
- NO [BRACKET] placeholders — fill in real content from the candidate info above.
- DO NOT copy the role/work-order or context fields verbatim, and DO NOT dump them as a bullet list of requirements — translate them into natural, flowing prose written directly to the candidate.
- DO NOT use "I hope this email finds you well" or similar generic openers.
- End with ONE single sentence asking if they're open to a quick chat (e.g. "Would you be open to a 15-minute call this week?"). Phrase it as normal sentence — NOT as a button, label, link, or quoted option.
- The system AUTOMATICALLY appends one-click reply buttons (Yes I'm interested / Not for this role / Don't contact me) AFTER your body. Adding your own creates duplicates and confuses the candidate.`;
  const outreachSystem =
    `You are Lexy's Outreach Agent. Write highly personalized, human-sounding outreach that gets responses. Always respect the required language. JSON only. Body must be plain prose with no buttons, no CTA links, and no canned reply lists — the system appends those automatically after your message.`;

  // Generate, then VERIFY the draft against the relocation/role guardrails.
  // The prompt rules reduce violations but don't guarantee them, so this is
  // the deterministic safety net: if the model slipped, regenerate once with
  // an explicit correction; if it STILL slips, strip the offending sentence
  // so a hallucinated relocation line never reaches the candidate.
  let result = await generateJSON<any>(outreachPrompt, outreachSystem);
  const violations = findOutreachViolations(
    `${result.subject ?? ""}\n${result.body ?? ""}`,
    { workType: jobCtx.workType },
  );
  if (violations.length > 0) {
    logger.warn({ ...logCtx, violations: violations.map(v => v.code) }, "[outreach] draft violated guardrails — regenerating");
    const correction = `\n\nYOUR PREVIOUS DRAFT BROKE A RULE: ${violations.map(v => v.message).join("; ")}. Rewrite the email and DO NOT mention relocation, moving, or commuting anywhere.${jobCtx.workType === "remote" ? " Make clear the role is remote-friendly." : ""} Return the same JSON shape.`;
    // The required output language is carried by langInstruction inside
    // outreachPrompt, so the retry stays in-language. The "en-US" arg is
    // provider routing only — it matches the first call (which uses the
    // default) so retries don't get rerouted to a different model.
    result = await generateJSON<any>(outreachPrompt + correction, outreachSystem, "en-US", { temperature: 0.5, seed: 7 });
  }

  // Final deterministic enforcement: sanitizes subject AND body, removes
  // remote-contradicting (on-site) sentences for remote roles, and falls
  // back to a neutral, fact-free message if sanitizing empties the body —
  // so a hallucinated/guardrail-violating line can never reach a candidate.
  const enforced = enforceOutreachGuardrails(
    { subject: result.subject, body: result.body },
    { workType: jobCtx.workType },
  );
  if (enforced.sanitized) {
    logger.error({ ...logCtx, remaining: enforced.violations.map(v => v.code) }, "[outreach] draft STILL violated guardrails after retry — sanitized before send");
  }

  const subject = enforced.subject || "Exciting opportunity";
  // Strip any button-shaped lines / HTML tags / [bracket] CTAs the AI
  // emitted despite the prompt rules above. Defence in depth: GPT-4o
  // sometimes ignores negative constraints and ships interactive
  // markup anyway. Without this, those AI-generated CTAs show up next
  // to our real buttons as the duplicate "I am interested" buttons
  // candidates have been seeing.
  const body = stripAiCtaButtons(enforced.body ?? "");

  return {
    subject,
    body,
    tone: result.tone,
    callToAction: result.callToAction,
    followUpSchedule: result.followUpSchedule ?? [],
    estimatedOpenRate: result.estimatedOpenRate,
  };
}
