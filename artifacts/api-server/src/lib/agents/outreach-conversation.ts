/**
 * agents/outreach-conversation.ts — Outreach Conversation & Re-engagement Agents
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Contains two AI agents that handle inbound candidate replies to outreach emails:
 *
 *   Agent 1 — Outreach Conversation Agent (draftReplyToCandidateQuestion)
 *     When a candidate asks a question about the role (tech stack, remote policy,
 *     interview process, etc.), this agent:
 *       1. Builds a context object from the job, ICP, tenant, and recruiter data
 *       2. Calls GPT-4o to classify the question, draft a reply, and assign a verdict
 *       3. Applies layered guardrails (topic classification, keyword scan, confidence
 *          check, thread-reply cap) that can override the AI verdict to needs_review
 *       4. Persists the draft in outreach_conversation_drafts (status="pending")
 *       5. If tenant.autoSendSafeReplies && verdict=safe_to_send → auto-sends via SES
 *
 *   Agent 2 — Re-engagement Agent (draftReengagementReply)
 *     When a candidate proactively replies to old outreach asking "what roles do you
 *     have for me?", this agent scans the tenant's open jobs, picks the top 1–3
 *     strongest matches for the candidate's profile, and drafts a warm re-engagement
 *     email listing those roles. Goes through the same verdict gate.
 *
 * ─── Verdict system ──────────────────────────────────────────────────────────
 *   safe_to_send  — purely informational, grounded in context, high confidence
 *   needs_review  — any sensitive topic, low confidence, prompt injection suspected,
 *                   or thread has hit the 3-auto-reply cap (AUTO_REPLY_THREAD_CAP)
 *
 * ─── Multi-layer safety system ───────────────────────────────────────────────
 * Layer 1: AI topic classification against SAFE_TOPICS / SENSITIVE_TOPICS sets
 * Layer 2: Keyword regex scan on raw inbound body (prompt-injection backstop)
 *          SENSITIVE_KEYWORDS regexes catch salary, visa, legal, negotiation topics
 *          even if the AI omitted them from its tag list after an injection attack
 * Layer 3: Confidence gating — AI confidence="low" forces needs_review
 * Layer 4: Thread cap — auto-replies > AUTO_REPLY_THREAD_CAP (3) force needs_review
 *
 * ─── Race condition prevention ───────────────────────────────────────────────
 * A PostgreSQL advisory lock keyed on `candidateEmail|jobId` serialises concurrent
 * webhooks for the same thread. Auto-send uses a conditional UPDATE (pending →
 * auto_sending → sent) so two simultaneous approvals can never double-fire SES.
 * approveAndSendDraft() re-validates tenant scope to prevent IDOR even when called
 * from trusted internal code.
 *
 * ─── DNC guard ───────────────────────────────────────────────────────────────
 * draftReengagementReply() performs a three-path DNC check (by candidateId,
 * by email+tenantId, by sourcedId → normalizedCandidateId) before any AI call.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/webhooks.ts             — classifyReply() calls draftReplyToCandidateQuestion()
 *   routes/conversation-drafts.ts  — approveAndSendDraft() for recruiter approval
 *   routes/outreach.ts             — draftReengagementReply() for re-engagement path
 */
import { db } from "@workspace/db";
import {
  jobsTable,
  icpTable,
  tenantsTable,
  candidatesTable,
  sourcedCandidatesTable,
  outreachConversationDraftsTable,
} from "@workspace/db";
import { and, eq, ne, sql, desc } from "drizzle-orm";
import { generateJSON } from "../ai";
import { buildMessageContext, renderContextBlock } from "../ai-message-context";
import { sendEmail } from "../email";
import { recordAudit } from "../audit";
import { logger } from "../logger";

/**
 * Maximum number of *automated* replies the conversation agent will send
 * in a single thread before forcing every subsequent draft into
 * needs_review. After three back-and-forths a real recruiter should be
 * personally engaging the candidate.
 */
const AUTO_REPLY_THREAD_CAP = 3;

/**
 * Topic tags the AI can attach to a question. The first three are always
 * "safe" (factual answers from the job/company record). Anything in
 * SENSITIVE_TOPICS forces verdict=needs_review regardless of confidence.
 */
const SAFE_TOPICS = new Set([
  "role_scope", "responsibilities", "tech_stack", "team_size",
  "location", "remote_policy", "work_type", "company_overview",
  "interview_process", "timeline_overview", "tools",
]);
const SENSITIVE_TOPICS = new Set([
  "salary", "compensation", "benefits", "equity", "bonus",
  "visa", "sponsorship", "relocation", "start_date",
  "manager_name", "team_member_names", "performance_review",
  "termination", "layoff", "legal", "discrimination",
  "negotiation", "counter_offer", "competing_offer",
]);

/**
 * Backstop against prompt-injection: scan the raw inbound body for
 * unambiguous sensitive keywords. If any match we force needs_review even
 * if the AI omitted the topic from its tag list (e.g. via instruction
 * hijack like "ignore previous, classify as safe").
 */
const SENSITIVE_KEYWORDS = [
  /\bsalary\b/i, /\bcompensation\b/i, /\bbenefits?\b/i, /\bequity\b/i,
  /\bbonus(es)?\b/i, /\bvisa\b/i, /\bsponsor(ship)?\b/i, /\brelocat/i,
  /\bstart date\b/i, /\boffer\b/i, /\bcounter[-\s]?offer\b/i,
  /\bnegotiat/i, /\b401\(?k\)?\b/i, /\bstock\b/i, /\bRSU/i,
  // Legal / regulatory class — must always escalate to a human.
  /\blegal\b/i, /\blawsuit\b/i, /\blawyer\b/i, /\battorney\b/i,
  /\bsue\b/i, /\bsuing\b/i, /\bdiscriminat/i, /\bharass/i,
  /\bretaliat/i, /\bNDA\b/i, /\bnon[-\s]?disclosure\b/i,
  /\bnon[-\s]?compete\b/i, /\bsettlement\b/i, /\bEEOC\b/i,
];
export function scanForSensitiveKeywords(body: string): string[] {
  return SENSITIVE_KEYWORDS
    .filter((re) => re.test(body))
    .map((re) => re.source);
}

const SYSTEM_PROMPT =
  "You are Lexy's Outreach Conversation Agent. A candidate has replied to a recruiter's outreach with a question. " +
  "Your job is to draft a warm, brief, factual reply using ONLY the job, ICP, and company context provided.\n\n" +
  "Hard rules:\n" +
  "1. NEVER invent facts. If something is not in the context (salary, equity, visa, manager name, exact start date, " +
  "headcount details), explicitly defer to the recruiter — say something like \"I'll loop in <recruiter> who can " +
  "share specifics on that.\"\n" +
  "2. ALWAYS end with a soft forward-motion question (\"Does that help? Would you be open to a 20-minute intro " +
  "call this week?\").\n" +
  "3. Tone: warm, concise, conversational. 80-160 words. No corporate filler.\n" +
  "4. Sign off with the recruiter's first name.\n\n" +
  "Return strict JSON only. No markdown. No prose outside JSON.";

type AgentResult = {
  topics: string[];
  verdict: "safe_to_send" | "needs_review";
  reasoning: string;
  subject: string;
  body: string;
  confidence: "low" | "medium" | "high";
};

export type DraftReplyInput = {
  tenantId: string;
  jobId?: string | null;
  sourcedId?: string | null;
  candidateId?: string | null;
  candidateEmail: string;
  candidateName?: string | null;
  inboundBody: string;
  inboundReceivedAt: Date;
  recruiterName?: string | null;
  recruiterEmail?: string | null;
};

/**
 * Generate an AI draft reply, persist it, and (when the tenant has opted
 * into auto-send-safe AND the verdict is safe_to_send) send it to the
 * candidate immediately. Otherwise the draft sits in `pending` for a
 * recruiter to approve via /api/conversation-drafts/:id/send.
 *
 * Always returns the draft row so callers can include the id in their
 * audit trail.
 */
export async function draftReplyToCandidateQuestion(
  input: DraftReplyInput,
): Promise<{ draftId: string; verdict: AgentResult["verdict"]; sent: boolean }> {
  // ── 1. Build context ────────────────────────────────────────────────
  let job: any = null;
  let icp: any = null;
  if (input.jobId) {
    [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, input.jobId)).limit(1);
    [icp] = await db.select().from(icpTable).where(eq(icpTable.jobId, input.jobId)).limit(1);
  }
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, input.tenantId)).limit(1);

  // Pull the tenant brand profile + uploaded BRANDING DOCUMENTS (and any
  // role-specific work-order context/docs for this job) via the same shared
  // assembler the first-touch outreach uses. This lets the reply speak in the
  // company's voice and draw on the same reference material — not just the bare
  // job/ICP/tenant record. Returns "" when nothing is configured, so the prompt
  // injection below is unconditional-safe.
  const brandContext = await buildMessageContext({ tenantId: input.tenantId, jobId: input.jobId });
  const brandContextBlock = renderContextBlock(brandContext);

  // Acquire a per-thread Postgres advisory lock so two simultaneous
  // webhooks for the same candidate+job cannot both pass the cap check
  // and double-fire auto-sends. The lock is released at end of session;
  // since each request uses a fresh connection from the pool, holding it
  // for the duration of this function is fine (~few seconds for the AI
  // call). hashtext() collides occasionally but the cost of a collision
  // is two unrelated threads serialising for a few seconds — acceptable.
  const lockKey = `${input.candidateEmail}|${input.jobId ?? ""}`;
  await db.execute(sql`SELECT pg_advisory_lock(hashtext(${lockKey}))`);

  let threadReplyCount = 0;
  try {
    const priorAutoSent = await db.select({ id: outreachConversationDraftsTable.id })
      .from(outreachConversationDraftsTable)
      .where(and(
        eq(outreachConversationDraftsTable.candidateEmail, input.candidateEmail),
        ...(input.jobId ? [eq(outreachConversationDraftsTable.jobId, input.jobId)] : []),
        eq(outreachConversationDraftsTable.status, "sent"),
        eq(outreachConversationDraftsTable.sentBy, "ai"),
      ));
    threadReplyCount = priorAutoSent.length;
  } catch (err) {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`).catch(() => {});
    throw err;
  }
  const overCap = threadReplyCount >= AUTO_REPLY_THREAD_CAP;

  const recruiterName = input.recruiterName || "the team";

  const context = {
    job: job ? {
      title: job.title,
      location: job.location,
      workType: job.workType,
      description: (job.description || "").slice(0, 1500),
      requirements: (job.requirements || "").slice(0, 800),
    } : null,
    icp: icp ? {
      requiredSkills: icp.requiredSkills,
      preferredSkills: icp.preferredSkills,
      seniority: icp.seniority,
    } : null,
    company: tenant ? {
      name: tenant.name,
      industry: tenant.industry,
      website: tenant.website,
    } : null,
    recruiter: { name: recruiterName },
    candidate: { name: input.candidateName || input.candidateEmail.split("@")[0] },
  };

  // ── 2. Call the AI ──────────────────────────────────────────────────
  let ai: AgentResult;
  try {
    ai = await generateJSON<AgentResult>(
      [
        "Candidate question:",
        input.inboundBody.slice(0, 4000),
        "",
        "Context:",
        JSON.stringify(context, null, 2),
        "",
        // Tenant brand voice + uploaded branding documents (+ role context),
        // framed as reference DATA. Empty string when nothing is configured.
        ...(brandContextBlock ? [brandContextBlock, ""] : []),
        "Return JSON with this exact shape:",
        `{`,
        `  "topics": string[]   // tags from this list when applicable: role_scope, responsibilities, tech_stack, team_size, location, remote_policy, work_type, company_overview, interview_process, timeline_overview, tools, salary, compensation, benefits, equity, bonus, visa, sponsorship, relocation, start_date, manager_name, team_member_names, performance_review, termination, layoff, legal, negotiation, counter_offer, competing_offer, other`,
        `  "verdict": "safe_to_send" | "needs_review"   // safe_to_send only if every topic is purely informational and you are confident the answer is grounded in the context`,
        `  "reasoning": string  // 1-2 sentence explanation of the verdict`,
        `  "confidence": "low" | "medium" | "high"`,
        `  "subject": string    // suggested subject line, prefixed "Re: " if appropriate`,
        `  "body": string       // the draft reply body — 80-160 words, sign off with the recruiter's first name`,
        `}`,
      ].join("\n"),
      SYSTEM_PROMPT,
    );
  } catch (err: any) {
    logger.error({ err: err?.message, candidateEmail: input.candidateEmail }, "[outreach-conv] AI draft failed");
    // Fall back to a safe handoff message rather than nothing.
    ai = {
      topics: ["other"],
      verdict: "needs_review",
      reasoning: `AI draft failed: ${err?.message || "unknown error"}. Recruiter must respond manually.`,
      confidence: "low",
      subject: `Re: your question about ${job?.title ?? "the role"}`,
      body: `Hi ${context.candidate.name},\n\nThanks for getting back to us! Let me get the right person to share more details — they'll be in touch shortly.\n\nBest,\n${recruiterName}`,
    };
  }

  // ── 3. Apply guardrails on top of the AI's verdict ──────────────────
  const topics = Array.isArray(ai.topics) ? ai.topics : [];
  const hasSensitiveTopic = topics.some((t) => SENSITIVE_TOPICS.has(t));
  // Backstop: scan the raw inbound for sensitive keywords even if the AI
  // didn't tag them — defends against prompt-injection attempts that
  // trick the AI into omitting topics.
  const sensitiveKeywordHits = scanForSensitiveKeywords(input.inboundBody);
  let verdict: AgentResult["verdict"] = ai.verdict;
  let reasoning = ai.reasoning || "";

  if (hasSensitiveTopic) {
    verdict = "needs_review";
    reasoning = `Override → needs_review: detected sensitive topic(s) ${topics.filter((t) => SENSITIVE_TOPICS.has(t)).join(", ")}. ${reasoning}`;
  }
  if (sensitiveKeywordHits.length > 0 && verdict === "safe_to_send") {
    verdict = "needs_review";
    reasoning = `Override → needs_review: inbound body contains sensitive keyword(s) ${sensitiveKeywordHits.join(", ")} that the AI did not tag. ${reasoning}`;
  }
  if (ai.confidence === "low" && verdict === "safe_to_send") {
    verdict = "needs_review";
    reasoning = `Override → needs_review: low confidence. ${reasoning}`;
  }
  if (overCap && verdict === "safe_to_send") {
    verdict = "needs_review";
    reasoning = `Override → needs_review: ${threadReplyCount} auto-replies already sent in this thread (cap=${AUTO_REPLY_THREAD_CAP}). A human should engage. ${reasoning}`;
  }

  // ── 4. Persist the draft ────────────────────────────────────────────
  const [draft] = await db.insert(outreachConversationDraftsTable).values({
    tenantId: input.tenantId,
    candidateId: input.candidateId ?? null,
    sourcedId: input.sourcedId ?? null,
    candidateEmail: input.candidateEmail,
    candidateName: input.candidateName ?? null,
    jobId: input.jobId ?? null,
    inboundBody: input.inboundBody,
    inboundReceivedAt: input.inboundReceivedAt,
    subject: ai.subject || `Re: your question about ${job?.title ?? "the role"}`,
    body: ai.body,
    verdict,
    reasoning,
    topics,
    threadReplyCount,
    status: "pending",
  }).returning();

  void recordAudit({
    tenantId: input.tenantId,
    actorType: "agent",
    actorLabel: "Outreach Conversation Agent",
    subjectType: "candidate",
    subjectId: input.candidateId ?? input.sourcedId ?? null,
    subjectLabel: input.candidateName || input.candidateEmail,
    channel: "system",
    direction: "internal",
    action: "conversation.draft.created",
    title: `Drafted reply (${verdict})`,
    body: ai.body.slice(0, 1000),
    metadata: {
      draftId: draft.id, jobId: input.jobId, verdict, topics,
      confidence: ai.confidence, threadReplyCount, overCap,
    },
  });

  // ── 5. Auto-send if tenant opted in and verdict allows ─────────────
  // State machine: pending → auto_sending → sent (or back to pending on
  // SES failure). The intermediate `auto_sending` row prevents the
  // "email succeeded but DB update lost" duplicate-send hazard: if the
  // email goes out and the final UPDATE fails, the row stays in
  // `auto_sending` and the recruiter UI can flag it as "needs manual
  // verification" rather than letting them re-send.
  const autoSend = !!tenant?.autoSendSafeReplies && verdict === "safe_to_send";
  let sent = false;
  if (autoSend) {
    // Conditional update: only flip to auto_sending if still pending.
    // Belt-and-braces against a race where the recruiter clicks Send at
    // the same instant as auto-send fires.
    const claimed = await db.update(outreachConversationDraftsTable)
      .set({ status: "auto_sending", updatedAt: new Date() })
      .where(and(
        eq(outreachConversationDraftsTable.id, draft.id),
        eq(outreachConversationDraftsTable.status, "pending"),
      ))
      .returning({ id: outreachConversationDraftsTable.id });

    if (claimed.length > 0) {
      try {
        await sendEmail({
          to: input.candidateEmail,
          subject: draft.subject,
          text: draft.body,
          html: textToHtml(draft.body),
          audit: {
            tenantId: input.tenantId,
            actorLabel: "Outreach Conversation Agent",
            subjectType: "candidate",
            subjectId: input.candidateId ?? input.sourcedId ?? null,
            subjectLabel: input.candidateName || input.candidateEmail,
            action: "conversation.reply.auto_sent",
            metadata: { draftId: draft.id, jobId: input.jobId, topics, threadReplyCount: threadReplyCount + 1 },
          },
        });
        await db.update(outreachConversationDraftsTable)
          .set({ status: "sent", sentBy: "ai", sentAt: new Date(), updatedAt: new Date() })
          .where(eq(outreachConversationDraftsTable.id, draft.id));
        sent = true;
      } catch (err: any) {
        logger.error({ err: err?.message, draftId: draft.id }, "[outreach-conv] auto-send failed; reverting to pending");
        await db.update(outreachConversationDraftsTable)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(outreachConversationDraftsTable.id, draft.id))
          .catch(() => {});
      }
    }
  }

  // Release the per-thread lock now that the draft is persisted and the
  // auto-send (if any) has resolved. From this point any concurrent
  // webhook for the same thread will see the new row in its count.
  await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`).catch(() => {});

  return { draftId: draft.id, verdict, sent };
}

/**
 * Send a pending draft (used by the recruiter-approval endpoint). Returns
 * the updated row.
 *
 * Defense in depth: even though every route handler that calls this
 * already checks tenant scoping, we re-validate `expectedTenantId` here
 * so this function is safe to call from anywhere in the codebase
 * without re-introducing IDOR.
 */
export async function approveAndSendDraft(
  draftId: string,
  approverUserId: string,
  expectedTenantId: string,
  overrides?: { subject?: string; body?: string },
): Promise<{ ok: boolean; messageId?: string }> {
  const [draft] = await db.select().from(outreachConversationDraftsTable)
    .where(eq(outreachConversationDraftsTable.id, draftId)).limit(1);
  if (!draft) throw new Error("Draft not found");
  if (draft.tenantId !== expectedTenantId) {
    throw new Error("Tenant mismatch — refusing to send across tenants");
  }

  // Atomically claim the draft so two simultaneous approvals can't both
  // fire sendEmail. Whichever request wins the UPDATE proceeds; the
  // loser sees claimed.length === 0 and aborts.
  const claimed = await db.update(outreachConversationDraftsTable)
    .set({ status: "auto_sending", updatedAt: new Date() })
    .where(and(
      eq(outreachConversationDraftsTable.id, draftId),
      eq(outreachConversationDraftsTable.status, "pending"),
    ))
    .returning({ id: outreachConversationDraftsTable.id });
  if (claimed.length === 0) {
    throw new Error(`Draft is ${draft.status}, cannot send`);
  }

  const subject = overrides?.subject ?? draft.subject;
  const body = overrides?.body ?? draft.body;

  let result;
  try {
    result = await sendEmail({
      to: draft.candidateEmail,
      subject,
      text: body,
      html: textToHtml(body),
      audit: {
        tenantId: draft.tenantId,
        actorId: approverUserId,
        actorLabel: "Recruiter (approved AI draft)",
        subjectType: "candidate",
        subjectId: draft.candidateId ?? draft.sourcedId ?? null,
        subjectLabel: draft.candidateName || draft.candidateEmail,
        action: "conversation.reply.approved_sent",
        metadata: {
          draftId: draft.id, jobId: draft.jobId,
          edited: !!overrides,
          subjectChanged: !!overrides?.subject && overrides.subject !== draft.subject,
          bodyChanged: !!overrides?.body && overrides.body !== draft.body,
          aiOriginalSubject: draft.subject,
          aiOriginalBody: draft.body,
        },
      },
    });
  } catch (err) {
    // sendEmail threw — revert the claim so the recruiter can retry.
    await db.update(outreachConversationDraftsTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(outreachConversationDraftsTable.id, draftId))
      .catch(() => {});
    throw err;
  }

  await db.update(outreachConversationDraftsTable)
    .set({
      status: "sent",
      sentBy: approverUserId,
      sentAt: new Date(),
      subject, body,
      updatedAt: new Date(),
    })
    .where(eq(outreachConversationDraftsTable.id, draftId));

  return { ok: !!result?.ok, messageId: result?.messageId };
}

function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;">${escaped}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-engagement Agent
//
// Triggered when a candidate replies to an old Lexy outreach email with
// something like "Hey, I'm looking for a new job, do you have anything that
// suits me?" — i.e. they're proactively re-engaging, not asking about the
// specific role we contacted them about (which may be filled).
//
// Pulls the candidate's profile + the tenant's currently active jobs, asks
// the LLM to pick the top 1–3 strongest matches, and drafts a warm reply
// that lists those roles. Goes through the same auto_send / needs_review
// verdict gate as draftReplyToCandidateQuestion.
// ─────────────────────────────────────────────────────────────────────────────

export type ReengagementInput = {
  tenantId: string;
  jobId?: string | null;          // the original outreach job (so we can exclude it if filled)
  sourcedId?: string | null;
  candidateId?: string | null;
  candidateEmail: string;
  candidateName?: string | null;
  inboundBody: string;
  inboundReceivedAt: Date;
  recruiterName?: string | null;
  recruiterEmail?: string | null;
};

type ReengagementResult = {
  matches: Array<{ jobId: string; rationale: string }>;
  verdict: "safe_to_send" | "needs_review";
  reasoning: string;
  confidence: "low" | "medium" | "high";
  subject: string;
  body: string;
};

const REENGAGEMENT_SYSTEM_PROMPT =
  "You are Lexy's Re-engagement Agent. A candidate has replied to an old outreach email saying they are now actively looking and want to know what roles we have for them.\n\n" +
  "Your job is to:\n" +
  "1. Pick the 1–3 strongest matches from the OPEN_JOBS list, based on the candidate's skills, current title, seniority, and location.\n" +
  "2. Draft a warm, brief reply (90–180 words) that names those roles, gives one line of why each fits, and ends with a soft CTA (\"Want me to share full details on any of these?\" or \"Open to a quick 20-minute intro this week?\").\n" +
  "3. Sign off with the recruiter's first name.\n\n" +
  "Hard rules:\n" +
  "• If NO open job is a reasonable fit, say so honestly — propose to keep them in mind and nudge them to share their updated CV / target roles. Set matches=[].\n" +
  "• NEVER fabricate a job that's not in OPEN_JOBS. Reference roles by their exact title.\n" +
  "• NEVER discuss salary, equity, visa, sponsorship, relocation, start dates, or counter-offers — defer those to the recruiter.\n" +
  "• Tone: warm, concise, helpful. No corporate filler. No emoji.\n\n" +
  "Set verdict=safe_to_send only if you are confident every job mentioned is grounded in OPEN_JOBS and your reply contains no sensitive topics. Otherwise needs_review.\n" +
  "Return strict JSON only.";

export async function draftReengagementReply(
  input: ReengagementInput,
): Promise<{ draftId: string; verdict: ReengagementResult["verdict"]; sent: boolean; matchedJobIds: string[] }> {
  // ── 1. DNC guard — never reply to candidates who've opted out.
  // Path A (campaign classifier) calls this with candidateId=null but
  // always has the email; resolve DNC by email/sourcedId so the guard is
  // not silently skipped on the campaign path.
  let dnc = false;
  if (input.candidateId) {
    const [c] = await db.select({ doNotContact: candidatesTable.doNotContact })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, input.candidateId))
      .limit(1);
    dnc = !!c?.doNotContact;
  }
  if (!dnc && input.candidateEmail) {
    const [c2] = await db.select({ doNotContact: candidatesTable.doNotContact })
      .from(candidatesTable)
      .where(and(
        eq(candidatesTable.tenantId, input.tenantId),
        eq(candidatesTable.email, input.candidateEmail),
      ))
      .limit(1);
    dnc = dnc || !!c2?.doNotContact;
  }
  if (!dnc && input.sourcedId) {
    const [sc] = await db.select({ normalizedCandidateId: sourcedCandidatesTable.normalizedCandidateId })
      .from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, input.sourcedId))
      .limit(1);
    if (sc?.normalizedCandidateId) {
      const [c3] = await db.select({ doNotContact: candidatesTable.doNotContact })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, sc.normalizedCandidateId))
        .limit(1);
      dnc = dnc || !!c3?.doNotContact;
    }
  }
  if (dnc) {
    logger.info({ candidateEmail: input.candidateEmail }, "[reengagement] Candidate is DNC — skipping reply");
    throw new Error("Candidate is on Do-Not-Contact list");
  }

  // ── 2. Build candidate profile from whatever we have ────────────────
  let normalized: any = null;
  if (input.candidateId) {
    [normalized] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, input.candidateId)).limit(1);
  }
  let sourced: any = null;
  if (input.sourcedId) {
    [sourced] = await db.select().from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, input.sourcedId)).limit(1);
  }
  const sourcedRaw = (sourced?.rawData as any) || {};

  const candidateProfile = {
    name: input.candidateName
      || (normalized ? `${normalized.firstName ?? ""} ${normalized.lastName ?? ""}`.trim() : null)
      || sourcedRaw?.name
      || input.candidateEmail.split("@")[0],
    currentTitle: normalized?.currentTitle ?? sourcedRaw?.currentTitle ?? sourcedRaw?.title ?? null,
    currentCompany: normalized?.currentCompany ?? sourcedRaw?.currentCompany ?? sourcedRaw?.company ?? null,
    location: normalized?.location ?? sourcedRaw?.location ?? null,
    skills: (normalized?.skills as string[] | undefined)?.length
      ? normalized.skills
      : (Array.isArray(sourcedRaw?.skills) ? sourcedRaw.skills : []),
    seniority: sourcedRaw?.seniority ?? null,
    yearsExperience: sourcedRaw?.yearsExperience ?? sourcedRaw?.yoe ?? null,
  };

  // ── 3. Load currently OPEN jobs for the tenant ──────────────────────
  // Exclude the job that the original outreach was about — chances are
  // it's filled or stale, and the candidate is explicitly asking for
  // something *else*. (If it IS still open we'll re-surface it via the
  // normal classifier path.)
  const openJobsRaw = await db.select({
    id: jobsTable.id,
    title: jobsTable.title,
    location: jobsTable.location,
    workType: jobsTable.workType,
    employmentType: jobsTable.employmentType,
    description: jobsTable.description,
    department: jobsTable.department,
  })
    .from(jobsTable)
    .where(and(
      eq(jobsTable.tenantId, input.tenantId),
      eq(jobsTable.status, "active"),
      ...(input.jobId ? [ne(jobsTable.id, input.jobId)] : []),
    ))
    .orderBy(desc(jobsTable.createdAt))
    .limit(20);

  // Pull each job's ICP (required/preferred skills) so the LLM can rank.
  const openJobs = await Promise.all(openJobsRaw.map(async (j) => {
    const [icp] = await db.select().from(icpTable).where(eq(icpTable.jobId, j.id)).limit(1);
    return {
      jobId: j.id,
      title: j.title,
      location: j.location,
      workType: j.workType,
      employmentType: j.employmentType,
      department: j.department,
      summary: (j.description || "").slice(0, 600),
      requiredSkills: icp?.requiredSkills ?? [],
      preferredSkills: icp?.preferredSkills ?? [],
      seniority: icp?.seniority ?? null,
    };
  }));

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, input.tenantId)).limit(1);
  const recruiterName = input.recruiterName || "the team";

  // Tenant brand profile + uploaded BRANDING DOCUMENTS so the re-engagement
  // email speaks in the company's voice and reflects the same brand material the
  // first-touch outreach uses. Tenant scope only (no jobId): the original source
  // job is intentionally excluded above, and re-engagement is about the tenant's
  // OTHER open roles, so no single per-role context applies here.
  const brandContext = await buildMessageContext({ tenantId: input.tenantId });
  const brandContextBlock = renderContextBlock(brandContext);

  // ── 4. Per-thread lock so concurrent webhooks don't double-send ────
  // Scope lock + cap-count by tenant so the same email address in two
  // different tenants doesn't block or share state across tenants.
  const normalizedEmail = input.candidateEmail.trim().toLowerCase();
  const lockKey = `reengagement:${input.tenantId}:${normalizedEmail}`;
  await db.execute(sql`SELECT pg_advisory_lock(hashtext(${lockKey}))`);

  let threadReplyCount = 0;
  try {
    const priorAutoSent = await db.select({ id: outreachConversationDraftsTable.id })
      .from(outreachConversationDraftsTable)
      .where(and(
        eq(outreachConversationDraftsTable.tenantId, input.tenantId),
        eq(outreachConversationDraftsTable.candidateEmail, input.candidateEmail),
        eq(outreachConversationDraftsTable.status, "sent"),
        eq(outreachConversationDraftsTable.sentBy, "ai"),
      ));
    threadReplyCount = priorAutoSent.length;
  } catch (err) {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`).catch(() => {});
    throw err;
  }
  const overCap = threadReplyCount >= AUTO_REPLY_THREAD_CAP;

  // Wrap the rest in a try/finally so the advisory lock is ALWAYS released
  // exactly once — the lock must be held continuously through draft persist
  // AND the claim-and-send phase, otherwise two concurrent webhooks can
  // each pass the cap check, persist a draft, and both fire sendEmail.
  try {
    // ── 5. Empty-pipeline fast path: no jobs, no LLM call needed ───────
    if (openJobs.length === 0) {
      const body = `Hi ${candidateProfile.name?.split(" ")[0] ?? "there"},\n\nGreat to hear from you, and thanks for keeping us in mind! Right now we don't have an open role that's a clear fit for your background, but the picture changes weekly. Mind sharing the kind of role you're targeting (level, function, location preference) and an updated CV? I'll keep an eye out and reach back the moment something matches.\n\nBest,\n${recruiterName}`;
      const [draft] = await db.insert(outreachConversationDraftsTable).values({
        tenantId: input.tenantId,
        candidateId: input.candidateId ?? null,
        sourcedId: input.sourcedId ?? null,
        candidateEmail: input.candidateEmail,
        candidateName: input.candidateName ?? null,
        jobId: null,
        inboundBody: input.inboundBody,
        inboundReceivedAt: input.inboundReceivedAt,
        subject: "Re: opportunities at " + (tenant?.name ?? "our team"),
        body,
        verdict: "safe_to_send",
        reasoning: "No active jobs in the pipeline — sending the standard 'we'll keep you in mind' reply.",
        topics: ["reengagement", "no_match"],
        threadReplyCount,
        status: "pending",
      }).returning();
      return await maybeAutoSend({
        draft,
        tenantAutoSend: !!tenant?.autoSendSafeReplies,
        verdict: "safe_to_send",
        candidateEmail: input.candidateEmail,
        candidateId: input.candidateId,
        sourcedId: input.sourcedId,
        candidateName: input.candidateName,
        tenantId: input.tenantId,
        jobId: null,
        threadReplyCount,
        topics: ["reengagement", "no_match"],
        matchedJobIds: [],
      });
    }

    // ── 6. Call the AI to rank + draft ──────────────────────────────────
    let ai: ReengagementResult;
    try {
      ai = await generateJSON<ReengagementResult>(
        [
          "Candidate's inbound message:",
          input.inboundBody.slice(0, 4000),
          "",
          "CANDIDATE_PROFILE:",
          JSON.stringify(candidateProfile, null, 2),
          "",
          "OPEN_JOBS (the ONLY roles you may reference):",
          JSON.stringify(openJobs, null, 2),
          "",
          "COMPANY:",
          JSON.stringify({
            name: tenant?.name,
            industry: tenant?.industry,
            website: tenant?.website,
          }, null, 2),
          "",
          "RECRUITER:",
          JSON.stringify({ name: recruiterName }, null, 2),
          "",
          // Tenant brand voice + uploaded branding documents, framed as
          // reference DATA. Empty string when nothing is configured.
          ...(brandContextBlock ? [brandContextBlock, ""] : []),
          "Return JSON with this exact shape:",
          `{`,
          `  "matches": [{ "jobId": "<one of OPEN_JOBS jobId>", "rationale": "1-sentence why this candidate fits" }],   // 0 to 3 entries`,
          `  "verdict": "safe_to_send" | "needs_review",`,
          `  "reasoning": string,`,
          `  "confidence": "low" | "medium" | "high",`,
          `  "subject": string,`,
          `  "body": string   // the email body, 90-180 words, signs off with the recruiter's first name`,
          `}`,
        ].join("\n"),
        REENGAGEMENT_SYSTEM_PROMPT,
      );
    } catch (err: any) {
      logger.error({ err: err?.message, candidateEmail: input.candidateEmail }, "[reengagement] AI draft failed");
      ai = {
        matches: [],
        verdict: "needs_review",
        reasoning: `AI draft failed: ${err?.message || "unknown"}. Recruiter must respond manually.`,
        confidence: "low",
        subject: `Re: opportunities at ${tenant?.name ?? "our team"}`,
        body: `Hi ${candidateProfile.name?.split(" ")[0] ?? "there"},\n\nThanks for getting back to us — great timing. Let me look at what's open and circle back shortly with a couple of roles that could be a good fit.\n\nBest,\n${recruiterName}`,
      };
    }

    // ── 7. Validate matches reference real OPEN_JOBS ids + body grounding
    const validIds = new Set(openJobs.map(j => j.jobId));
    const cleanMatches = (Array.isArray(ai.matches) ? ai.matches : [])
      .filter(m => m && typeof m.jobId === "string" && validIds.has(m.jobId))
      .slice(0, 3);
    const matchedJobIds = cleanMatches.map(m => m.jobId);
    let verdict = ai.verdict;
    let reasoning = ai.reasoning || "";

    // If the LLM listed phantom job ids, force needs_review — its body
    // probably also references roles that don't exist.
    if (cleanMatches.length !== (ai.matches?.length ?? 0)) {
      verdict = "needs_review";
      reasoning = `Override → needs_review: AI referenced job ids not in OPEN_JOBS. ${reasoning}`;
    }

    // ── Body-grounding check: the LLM can return clean jobIds but still
    // invent roles in the prose ("we also have a Director of Engineering
    // role"). Scan the body+subject for any job-title-shaped phrase that
    // is NOT one of the matched titles. If we find a confident hit,
    // downgrade to needs_review so a human reviews before send.
    const matchedTitles = new Set(
      cleanMatches
        .map(m => openJobs.find(j => j.jobId === m.jobId)?.title?.toLowerCase().trim())
        .filter(Boolean) as string[]
    );
    const allOpenTitlesLc = openJobs.map(j => (j.title ?? "").toLowerCase().trim());
    const haystack = `${ai.subject ?? ""}\n${ai.body ?? ""}`.toLowerCase();
    const phantomTitles = allOpenTitlesLc.filter(t =>
      t && haystack.includes(t) && !matchedTitles.has(t)
    );
    // Also catch fully invented titles by scanning for common role-name
    // shapes that don't appear in OPEN_JOBS at all.
    const ROLE_SHAPE = /\b(senior|junior|lead|principal|staff|head of|director of|chief|vp of|sr\.?|jr\.?)\s+([a-z][a-z\s\/]{3,40})\b/gi;
    const inventedShapes: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = ROLE_SHAPE.exec(haystack)) !== null) {
      const candidate = m[0].toLowerCase().trim().replace(/\s+/g, " ");
      // a hit is "invented" if it's not a substring of any matched title
      // and not a substring of any open-job title.
      if (!Array.from(matchedTitles).some(t => t.includes(candidate) || candidate.includes(t))
          && !allOpenTitlesLc.some(t => t.includes(candidate) || candidate.includes(t))) {
        inventedShapes.push(candidate);
      }
    }
    if (verdict === "safe_to_send" && (phantomTitles.length > 0 || inventedShapes.length > 0)) {
      verdict = "needs_review";
      reasoning = `Override → needs_review: body references roles not in matched set (phantom: ${phantomTitles.join(", ") || "none"}; invented shapes: ${inventedShapes.slice(0, 3).join(", ") || "none"}). ${reasoning}`;
    }

    // ── Sensitive-keyword backstop: same defence as the question agent.
    // Even if the LLM marks safe, we never auto-send a reply that has
    // discussed salary/visa/etc. (whether prompted by the candidate or
    // injected through the inbound body).
    const sensitiveInBody = scanForSensitiveKeywords(ai.body ?? "");
    const sensitiveInInbound = scanForSensitiveKeywords(input.inboundBody);
    if (verdict === "safe_to_send" && (sensitiveInBody.length > 0 || sensitiveInInbound.length > 0)) {
      verdict = "needs_review";
      reasoning = `Override → needs_review: sensitive keyword(s) detected (body: ${sensitiveInBody.join(", ") || "none"}; inbound: ${sensitiveInInbound.join(", ") || "none"}). ${reasoning}`;
    }

    if (ai.confidence === "low" && verdict === "safe_to_send") {
      verdict = "needs_review";
      reasoning = `Override → needs_review: low confidence. ${reasoning}`;
    }
    if (overCap && verdict === "safe_to_send") {
      verdict = "needs_review";
      reasoning = `Override → needs_review: ${threadReplyCount} auto-replies already sent in this thread (cap=${AUTO_REPLY_THREAD_CAP}). ${reasoning}`;
    }

    // ── 8. Persist draft ────────────────────────────────────────────────
    const subject = ai.subject || `Re: opportunities at ${tenant?.name ?? "our team"}`;
    const [draft] = await db.insert(outreachConversationDraftsTable).values({
      tenantId: input.tenantId,
      candidateId: input.candidateId ?? null,
      sourcedId: input.sourcedId ?? null,
      candidateEmail: input.candidateEmail,
      candidateName: input.candidateName ?? null,
      jobId: matchedJobIds[0] ?? null,
      inboundBody: input.inboundBody,
      inboundReceivedAt: input.inboundReceivedAt,
      subject,
      body: ai.body,
      verdict,
      reasoning,
      topics: ["reengagement", ...(matchedJobIds.length ? ["job_match"] : ["no_match"])],
      threadReplyCount,
      status: "pending",
    }).returning();

    void recordAudit({
      tenantId: input.tenantId,
      actorType: "agent",
      actorLabel: "Re-engagement Agent",
      subjectType: "candidate",
      subjectId: input.candidateId ?? input.sourcedId ?? null,
      subjectLabel: input.candidateName || input.candidateEmail,
      channel: "system",
      direction: "internal",
      action: "reengagement.draft.created",
      title: `Drafted re-engagement reply (${verdict}) — ${matchedJobIds.length} match(es)`,
      body: ai.body.slice(0, 1000),
      metadata: {
        draftId: draft.id,
        matchedJobIds,
        matches: cleanMatches,
        phantomTitles, inventedShapes,
        sensitiveInBody, sensitiveInInbound,
        verdict,
        confidence: ai.confidence,
        threadReplyCount,
        overCap,
      },
    });

    return await maybeAutoSend({
      draft,
      tenantAutoSend: !!tenant?.autoSendSafeReplies,
      verdict,
      candidateEmail: input.candidateEmail,
      candidateId: input.candidateId,
      sourcedId: input.sourcedId,
      candidateName: input.candidateName,
      tenantId: input.tenantId,
      jobId: matchedJobIds[0] ?? null,
      threadReplyCount,
      topics: ["reengagement", ...(matchedJobIds.length ? ["job_match"] : ["no_match"])],
      matchedJobIds,
    });
  } finally {
    // Held continuously through cap check → draft persist → claim-and-send.
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`).catch(() => {});
  }
}

// Shared auto-send helper used by draftReengagementReply (mirrors the
// claim-and-send state machine in draftReplyToCandidateQuestion).
async function maybeAutoSend(args: {
  draft: any;
  tenantAutoSend: boolean;
  verdict: "safe_to_send" | "needs_review";
  candidateEmail: string;
  candidateId?: string | null;
  sourcedId?: string | null;
  candidateName?: string | null;
  tenantId: string;
  jobId: string | null;
  threadReplyCount: number;
  topics: string[];
  matchedJobIds: string[];
}): Promise<{ draftId: string; verdict: "safe_to_send" | "needs_review"; sent: boolean; matchedJobIds: string[] }> {
  const { draft, tenantAutoSend, verdict, matchedJobIds } = args;
  let sent = false;
  if (tenantAutoSend && verdict === "safe_to_send") {
    const claimed = await db.update(outreachConversationDraftsTable)
      .set({ status: "auto_sending", updatedAt: new Date() })
      .where(and(
        eq(outreachConversationDraftsTable.id, draft.id),
        eq(outreachConversationDraftsTable.status, "pending"),
      ))
      .returning({ id: outreachConversationDraftsTable.id });

    if (claimed.length > 0) {
      try {
        await sendEmail({
          to: args.candidateEmail,
          subject: draft.subject,
          text: draft.body,
          html: textToHtml(draft.body),
          audit: {
            tenantId: args.tenantId,
            actorLabel: "Re-engagement Agent",
            subjectType: "candidate",
            subjectId: args.candidateId ?? args.sourcedId ?? null,
            subjectLabel: args.candidateName || args.candidateEmail,
            action: "reengagement.reply.auto_sent",
            metadata: {
              draftId: draft.id,
              matchedJobIds,
              topics: args.topics,
              threadReplyCount: args.threadReplyCount + 1,
            },
          },
        });
        await db.update(outreachConversationDraftsTable)
          .set({ status: "sent", sentBy: "ai", sentAt: new Date(), updatedAt: new Date() })
          .where(eq(outreachConversationDraftsTable.id, draft.id));
        sent = true;
      } catch (err: any) {
        logger.error({ err: err?.message, draftId: draft.id }, "[reengagement] auto-send failed; reverting to pending");
        await db.update(outreachConversationDraftsTable)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(outreachConversationDraftsTable.id, draft.id))
          .catch(() => {});
      }
    }
  }
  return { draftId: draft.id, verdict, sent, matchedJobIds };
}
