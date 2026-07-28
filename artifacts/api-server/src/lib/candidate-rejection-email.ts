/**
 * candidate-rejection-email.ts — Empathetic Candidate Rejection Email
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Sends a carefully worded rejection email to a candidate. Called whenever a
 * candidate is moved to a rejected stage, either by a recruiter action or by
 * the system (e.g. auto-reject after a failed screening score threshold).
 *
 * ─── Tone & wording philosophy ───────────────────────────────────────────────
 * The copy is deliberately written to:
 *   • Never use the word "reject" or "unfortunately"
 *   • Frame the outcome as role-fit timing, not candidate inadequacy
 *   • Thank the candidate sincerely for their time
 *   • Leave the door open for future opportunities
 *   • Localise for Arabic (right-to-left) vs all other languages (English)
 *
 * ─── Best-effort design ──────────────────────────────────────────────────────
 * Returns { ok: false } on any failure (missing email, SES not configured, etc.)
 * but NEVER throws. Callers fire-and-forget or inspect the result without
 * needing try/catch.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   record-rejection.ts  — the canonical rejection bookkeeping helper
 *   routes/pipeline.ts   — direct reject button actions
 */
import { sendEmail, plainToHtml, isEmailConfigured } from "./email.js";
import { generateWithAI } from "./ai.js";
import { buildMessageContext, renderContextBlock } from "./ai-message-context.js";
import { logger } from "./logger.js";

export interface CandidateRejectionEmailInput {
  to: string;
  candidateFirstName?: string | null;
  candidateFullName?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  language?: string | null;
  tenantId?: string | null;
  candidateId?: string | null;
  rejectedBy?: "recruiter" | "hiring_manager" | "system" | null;
  metadata?: Record<string, any> | null;
}

export interface CandidateRejectionEmailResult {
  ok: boolean;
  skipped?: "no_email_service" | "no_to_address";
  error?: string;
}

/**
 * Send a sophisticated, empathetic rejection email to a candidate.
 *
 * Deliberately avoids the word "reject" and harsh language. Frames the
 * outcome in terms of role-fit rather than candidate inadequacy, thanks
 * the candidate for their time, and wishes them well. Localized for
 * Arabic vs everything-else; falls back to English when language is
 * unknown.
 *
 * Best-effort: returns `{ok:false}` on failure but never throws so
 * callers can fire-and-forget.
 */
export async function sendCandidateRejectionEmail(
  input: CandidateRejectionEmailInput,
): Promise<CandidateRejectionEmailResult> {
  if (!input.to) return { ok: false, skipped: "no_to_address" };
  if (!isEmailConfigured()) return { ok: false, skipped: "no_email_service" };

  const lang = (input.language ?? "en").toLowerCase();
  const isArabic = lang.startsWith("ar");

  const firstName =
    (input.candidateFirstName ?? "").trim() ||
    (input.candidateFullName ?? "").trim().split(/\s+/)[0] ||
    (isArabic ? "" : "there");

  const role = (input.jobTitle ?? "").trim();
  const company = (input.companyName ?? "").trim();

  const subjectEn = role
    ? `Update on your application for ${role}`
    : `An update on your application`;
  const subjectAr = role
    ? `تحديث بخصوص طلبك لوظيفة ${role}`
    : `تحديث بخصوص طلبك`;

  const bodyEn = `Dear ${firstName},

Thank you sincerely for the time and effort you invested in our process${role ? ` for the ${role} role` : ""}${company ? ` at ${company}` : ""}.

We were genuinely impressed by your background, and the decision was a difficult one. After careful consideration, we have decided to move forward with other candidates whose experience aligns more closely with what this particular role requires at this moment.

This decision is in no way a reflection of your talent or potential. We encourage you to keep us in mind for future opportunities — we would welcome the chance to reconnect when a role better suited to your strengths becomes available.

We wish you every success in the next chapter of your career, and thank you again for considering us.

Warm regards,
${company ? `The ${company} Hiring Team` : "The Hiring Team"}`;

  const bodyAr = `عزيزي/عزيزتي ${firstName},

نشكرك من القلب على الوقت والجهد اللذين بذلتهما خلال عملية التوظيف${role ? ` لوظيفة ${role}` : ""}${company ? ` في ${company}` : ""}.

لقد أعجبنا بمسيرتك المهنية وكان القرار صعبًا فعلًا. بعد دراسة دقيقة، قرّرنا متابعة الإجراءات مع مرشّحين آخرين تتوافق خبراتهم بشكل أوثق مع متطلبات هذه الوظيفة تحديدًا في هذه المرحلة.

هذا القرار لا يعكس بأي حال مواهبك أو إمكاناتك. نشجعك على البقاء على تواصل معنا لفرص مستقبلية — وسيسعدنا التواصل معك مجددًا حين تتاح وظيفة تناسب نقاط قوتك بشكل أفضل.

نتمنى لك كل التوفيق في الفصل القادم من مسيرتك المهنية، ونشكرك مرة أخرى على اهتمامك بنا.

مع أطيب التحيات،
${company ? `فريق التوظيف لدى ${company}` : "فريق التوظيف"}`;

  const subject = isArabic ? subjectAr : subjectEn;
  // The hardcoded template is the trusted FALLBACK. We try to produce a
  // brand-voiced version below and only use it when it passes safety checks.
  let body = isArabic ? bodyAr : bodyEn;

  // Brand-voice the rejection using the tenant brand profile + uploaded
  // branding documents (tenant scope only — no jobId, this is a company-voice
  // message). Best-effort and heavily guarded: a rejection is sensitive, so the
  // AI is constrained to the same tone philosophy as the template (no "reject",
  // no reasons, no false promises, no invented facts) and we fall back to the
  // proven template on ANY failure or suspicious output.
  if (input.tenantId) {
    try {
      const brandContextBlock = renderContextBlock(
        await buildMessageContext({ tenantId: input.tenantId }),
      );
      if (brandContextBlock) {
        const sys =
          "You write empathetic candidate rejection emails for a recruiting team. " +
          "STRICT RULES: never use the words 'reject', 'rejected', or 'unfortunately'. " +
          "Frame the outcome as role-fit/timing, never as candidate inadequacy. Thank them sincerely, " +
          "and leave the door open for future roles WITHOUT promising any specific future contact. " +
          "Do NOT state or invent a reason for the decision, feedback, scores, or any job/compensation detail. " +
          "Match the company's voice and approved language from the reference data. Plain text only, no markdown, " +
          "no placeholders. 90-150 words. Write in the candidate's language.";
        const prompt =
          `Candidate first name: ${firstName || "the candidate"}\n` +
          `Role: ${role || "the role"}\n` +
          `Company: ${company || "the company"}\n` +
          `Language: ${isArabic ? "Arabic" : lang}\n\n` +
          `${brandContextBlock}\n` +
          `Write the rejection email body only (no subject line). Begin with a greeting to the candidate by first name ` +
          `and end with a warm sign-off from the ${company ? company + " " : ""}hiring team.`;
        const raw = (await generateWithAI(prompt, sys, lang)) ?? "";
        const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();
        // Guard: only adopt the AI body if it is substantive and respects the
        // tone philosophy. Reject banned tone words, any URL/link (a rejection
        // must never carry a link), and unfilled template placeholders.
        // Otherwise keep the safe template.
        const banned = /\b(reject(ed)?|unfortunately)\b/i;
        const hasUrl = /https?:\/\/|www\./i.test(cleaned);
        const hasPlaceholder = /\{\{?\s*\w|\[\s*\w+\s*\]/.test(cleaned);
        if (
          cleaned.length >= 200 &&
          cleaned.length <= 2500 &&
          !banned.test(cleaned) &&
          !hasUrl &&
          !hasPlaceholder
        ) {
          body = cleaned;
        } else {
          logger.info(
            { len: cleaned.length },
            "[rejection-email] AI draft failed safety checks — using template fallback",
          );
        }
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        "[rejection-email] brand-voice generation failed — using template fallback",
      );
    }
  }

  try {
    const sendRes = await sendEmail({
      to: input.to,
      subject,
      text: body,
      html: plainToHtml(body),
      audit: {
        tenantId: input.tenantId ?? null,
        actorLabel: "Pipeline Engine",
        subjectType: "candidate",
        subjectId: input.candidateId ?? null,
        subjectLabel: input.candidateFullName ?? input.to,
        action: "candidate.rejection_email.sent",
        metadata: {
          jobTitle: role || null,
          rejectedBy: input.rejectedBy ?? null,
          language: lang,
          ...(input.metadata ?? {}),
        },
      },
    });
    return { ok: sendRes.ok, error: sendRes.error };
  } catch (err: any) {
    logger.error({ err: err?.message }, "Failed to send candidate rejection email");
    return { ok: false, error: err?.message };
  }
}
