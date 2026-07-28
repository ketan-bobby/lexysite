/**
 * outreach-engine.ts — Multi-step Outreach Campaign Engine
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Manages the full lifecycle of recruiter outreach campaigns: from enrolling
 * candidates, generating personalised AI emails, sending them via SES, to
 * classifying inbound replies and updating engagement signals.
 *
 * ─── Four-phase pipeline ────────────────────────────────────────────────────
 *   Phase 0 — ensureDefaultSteps()     Seed a campaign's default 4-step sequence
 *                                      (Day 0, 3, 7, 14) if none exist yet.
 *
 *   Phase 1 — enrollCandidate()        Add a sourced_candidates row to a campaign.
 *                                      Resolves contact details, assigns A/B variant,
 *                                      bumps the campaign enrolled_count. Idempotent.
 *
 *   Phase 2 — generateMessages()       For every active enrollment ready for its
 *                                      next step (respecting delayDays), generates
 *                                      a personalised email with GPT-4o. A/B variants
 *                                      differ in narrative style (direct vs storytelling).
 *                                      stripAiCtaButtons() removes any button artifacts
 *                                      the model emits before real quick-reply buttons
 *                                      are appended at send time.
 *
 *   Phase 3 — sendScheduledMessages()  Sends all "scheduled" messages via Amazon SES.
 *                                      Performs a DNC guard before every send. Appends
 *                                      one-click quick-reply buttons (Interested /
 *                                      Not for this role / Stop emailing me) via the
 *                                      outreach-reply-tokens helper.
 *
 *   Phase 4 — classifyReply()          AI classifies inbound replies into one of:
 *                                      interested · not_interested · referral · question
 *                                      reengagement · out_of_office · unsubscribe
 *                                      Includes heuristic safety nets for short positive
 *                                      acks ("Got it", "Sure") and re-engagement patterns.
 *
 * ─── DNC (Do Not Contact) ────────────────────────────────────────────────────
 * Every send path (Phase 3, nurture cycle) checks candidates.do_not_contact
 * BEFORE sending. If flagged, the message is marked "failed" and the enrollment
 * is stopped. This is non-negotiable and enforced at the engine level, not the
 * route level.
 *
 * ─── A/B testing ─────────────────────────────────────────────────────────────
 * Each enrollment is randomly assigned variant A (direct value prop) or variant B
 * (storytelling/question-led). The variant drives different AI prompt instructions
 * so both message style and open/reply rates can be compared per campaign.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   outreach-scheduler.ts   — runs generate + send on all active campaigns hourly
 *   routes/outreach.ts      — exposes campaign management and manual trigger APIs
 *   routes/webhooks.ts      — calls classifyReply() when SES inbound mail arrives
 */

import { db } from "@workspace/db";
import {
  outreachEnrollmentsTable,
  outreachSequenceStepsTable,
  outreachStepMessagesTable,
  outreachRepliesTable,
  outreachAutopilotRunsTable,
  outreachCampaignsTable,
  sourcedCandidatesTable,
  candidatesTable,
  applicationsTable,
  recruiterInboxTable,
  jobsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import OpenAI from "openai";
import { logger } from "./logger";
import { sendEmail, plainToHtml } from "./email";
import { isRealEmail } from "./real-email";
import { findOutreachViolations, enforceOutreachGuardrails } from "./outreach-guardrails";

const openai = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });

/**
 * Strip any AI-generated "button-shaped" content from an outreach body before
 * we send it. The system already appends real reply buttons via
 * `buildQuickReplyBlocks`; if the AI also drops its own (e.g. an
 * "I am interested in this position." line beside "Thank you but I am not
 * interested.") we end up with duplicate / contradictory CTAs in the email.
 *
 * Conservative — only removes obvious button artifacts, leaves prose intact.
 */
export function stripAiCtaButtons(body: string): string {
  if (!body) return body;
  let out = body;
  // 1. Drop any HTML tags the model emitted (we send as plain-text → HTML).
  out = out.replace(/<\/?(?:button|a|input)\b[^>]*>/gi, "");
  // 2. Drop bracketed button placeholders like "[Yes, I'm interested]" or "[Schedule a call]".
  out = out.replace(/^[ \t]*\[[^\]\n]{1,80}\][ \t]*$/gim, "");
  // 3. Drop standalone lines that are just a short interested/not-interested CTA
  //    (case-insensitive). Matches things like "I am interested in this position.",
  //    "Yes, I am interested.", "Thank you but I am not interested.", "Not interested".
  const ctaLine = /^[ \t>*•\-]*(?:✓|✔|→)?[ \t]*(?:yes[,!.\s]+)?(?:thank[ \t]+you[, ]+but[ \t]+)?(?:i(?:'m| am)[ \t]+(?:not[ \t]+)?interested|not[ \t]+interested)\b[^\n]{0,80}$/gim;
  out = out.replace(ctaLine, "");
  // 4. Collapse the blank lines we just created.
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT SEQUENCE STEPS for a job campaign
// Step 1: Day 0  – Initial outreach
// Step 2: Day 3  – First follow-up
// Step 3: Day 7  – Second follow-up
// Step 4: Day 14 – Final follow-up / close-out
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STEPS = [
  { stepNumber: 1, type: "email", delayDays: 0,  subjectTemplate: "Exciting opportunity at {{company}}", bodyTemplate: "Initial personalised outreach" },
  { stepNumber: 2, type: "email", delayDays: 3,  subjectTemplate: "Following up – {{role}}", bodyTemplate: "Short, friendly follow-up referencing initial message" },
  { stepNumber: 3, type: "email", delayDays: 7,  subjectTemplate: "One more thought on {{role}}", bodyTemplate: "Value add follow-up with a relevant insight or achievement hook" },
  { stepNumber: 4, type: "email", delayDays: 14, subjectTemplate: "Last note – {{role}} role", bodyTemplate: "Final outreach, leave door open, no hard sell" },
];

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0: Seed default steps for a campaign (idempotent)
// ─────────────────────────────────────────────────────────────────────────────
export async function ensureDefaultSteps(campaignId: string) {
  const existing = await db.select().from(outreachSequenceStepsTable)
    .where(eq(outreachSequenceStepsTable.campaignId, campaignId));
  if (existing.length > 0) return existing;

  const rows = DEFAULT_STEPS.map(s => ({ ...s, campaignId }));
  return db.insert(outreachSequenceStepsTable).values(rows).returning();
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1: Enroll a sourced candidate into a campaign
// ─────────────────────────────────────────────────────────────────────────────
export async function enrollCandidate(opts: {
  campaignId: string;
  candidateId: string; // sourced_candidates.id
  jobId: string;
  tenantId: string;
}) {
  const { campaignId, candidateId, jobId, tenantId } = opts;

  // Idempotent – skip if already enrolled
  const [existing] = await db.select().from(outreachEnrollmentsTable)
    .where(and(
      eq(outreachEnrollmentsTable.campaignId, campaignId),
      eq(outreachEnrollmentsTable.candidateId, candidateId),
    )).limit(1);
  if (existing) return existing;

  // Resolve name + email from sourced_candidates rawData
  let recipientName = "";
  let recipientEmail = "";
  let recipientData: Record<string, any> = {};
  // Compliance guard: a Do-Not-Contact candidate must never be enrolled into
  // outreach, regardless of how they were surfaced (search, direct id, etc.).
  let isDnc = false;

  const [sc] = await db.select().from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.id, candidateId)).limit(1);

  if (sc) {
    const raw = sc.rawData as any;
    recipientName = raw.name || raw.firstName ? `${raw.firstName || ""} ${raw.lastName || ""}`.trim() : "";
    recipientEmail = raw.email || raw.contactInfo?.email || "";
    recipientData = {
      currentTitle: raw.title || raw.currentTitle || "",
      currentCompany: raw.company || raw.currentCompany || "",
      skills: Array.isArray(raw.skills) ? raw.skills.slice(0, 5).join(", ") : "",
      location: raw.location || "",
      yearsExperience: raw.yearsExperience || "",
    };
    isDnc = raw?.doNotContact === true;
    // DNC is authoritatively stored on the normalized candidate record, so
    // honour it even when the sourced row's rawData is stale.
    if (!isDnc && sc.normalizedCandidateId) {
      const [linked] = await db.select({ dnc: candidatesTable.doNotContact })
        .from(candidatesTable).where(eq(candidatesTable.id, sc.normalizedCandidateId)).limit(1);
      if (linked?.dnc) isDnc = true;
    }
  } else {
    const [cand] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    if (cand) {
      recipientName = `${cand.firstName} ${cand.lastName}`.trim();
      recipientEmail = cand.email || "";
      recipientData = { currentTitle: (cand as any).currentTitle || "", skills: Array.isArray((cand as any).skills) ? (cand as any).skills.slice(0, 5).join(", ") : "" };
      isDnc = cand.doNotContact === true;
    }
  }

  if (isDnc) {
    const err = new Error("Candidate is on the Do-Not-Contact list and cannot be enrolled in outreach.") as Error & { code?: string };
    err.code = "DNC_BLOCKED";
    throw err;
  }

  // Contact-email guard: a candidate with no real, deliverable email address
  // cannot be enrolled — every downstream send would bounce. This is a DISTINCT
  // failure from DNC (different problem, different recruiter remedy: add or
  // enrich an address) and is NON-overridable: no manual action can conjure an
  // address, so the block holds on every enrollment path, including this one
  // (the /outreach/campaigns/:id/enroll route which otherwise lacks the check).
  if (!isRealEmail(recipientEmail)) {
    const err = new Error("Candidate has no contact email on file and cannot be enrolled in outreach.") as Error & { code?: string };
    err.code = "NO_CONTACT_EMAIL";
    throw err;
  }

  // Assign A/B variant randomly
  const abVariant = Math.random() < 0.5 ? "A" : "B";

  const [enrollment] = await db.insert(outreachEnrollmentsTable).values({
    campaignId,
    candidateId,
    jobId,
    tenantId,
    recipientEmail,
    recipientName,
    recipientData,
    abVariant,
    status: "enrolled",
  }).returning();

  // Bump enrolled count on campaign
  await db.update(outreachCampaignsTable)
    .set({ enrolledCount: sql`${outreachCampaignsTable.enrolledCount} + 1` })
    .where(eq(outreachCampaignsTable.id, campaignId));

  logger.info({ campaignId, candidateId, enrollmentId: enrollment.id }, "Candidate enrolled in outreach campaign");
  return enrollment;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2: Generate AI messages for all enrollments ready for their next step
// ─────────────────────────────────────────────────────────────────────────────
export async function generateMessages(campaignId: string) {
  const [campaign] = await db.select().from(outreachCampaignsTable)
    .where(eq(outreachCampaignsTable.id, campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") return [];

  const steps = await db.select().from(outreachSequenceStepsTable)
    .where(eq(outreachSequenceStepsTable.campaignId, campaignId))
    .orderBy(outreachSequenceStepsTable.stepNumber);
  if (steps.length === 0) return [];

  const activeEnrollments = await db.select().from(outreachEnrollmentsTable)
    .where(and(
      eq(outreachEnrollmentsTable.campaignId, campaignId),
      // status is enrolled OR active (ready for next step)
    ));

  const ready = activeEnrollments.filter(e => e.status === "enrolled" || e.status === "active");
  const generated: any[] = [];

  // Cache jobs by id so we hit the DB once per distinct job, not once per
  // enrollment. The role context (esp. workType) is what keeps the model from
  // inventing nonsense like asking a candidate for a REMOTE role whether they
  // are open to relocating.
  const jobCache = new Map<string, typeof jobsTable.$inferSelect | null>();
  async function getJob(jobId: string | null) {
    if (!jobId) return null;
    if (jobCache.has(jobId)) return jobCache.get(jobId) ?? null;
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    jobCache.set(jobId, job ?? null);
    return job ?? null;
  }

  for (const enrollment of ready) {
    const nextStepNum = enrollment.currentStep + 1;
    const step = steps.find(s => s.stepNumber === nextStepNum);
    if (!step) continue;

    // Check delay since last send
    if (enrollment.lastSentAt && step.delayDays > 0) {
      const delayMs = step.delayDays * 24 * 60 * 60 * 1000;
      if (Date.now() - enrollment.lastSentAt.getTime() < delayMs) continue;
    }

    // Skip if this step message already exists
    const [existingMsg] = await db.select().from(outreachStepMessagesTable)
      .where(and(
        eq(outreachStepMessagesTable.enrollmentId, enrollment.id),
        eq(outreachStepMessagesTable.stepNumber, nextStepNum),
      )).limit(1);
    if (existingMsg) continue;

    // Build AI prompt
    const recipientData = (enrollment.recipientData as Record<string, any>) || {};
    const contextLines = Object.entries(recipientData)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const toneInstruction = {
      friendly: "Write in a warm, approachable tone. Use casual language.",
      direct: "Be concise and to the point. No fluff.",
      professional: "Write in a polished, business-appropriate tone.",
      casual: "Write like you are messaging a friend. Keep it brief and natural.",
    }["professional"];

    const stepInstruction = nextStepNum === 1
      ? "This is the initial outreach. Introduce yourself and the opportunity warmly. Make it personal."
      : `This is follow-up #${nextStepNum - 1}. Reference that you reached out before. Keep it shorter and add new value – don't repeat the first message.`;

    const variantInstruction = enrollment.abVariant === "B"
      ? "Use a storytelling approach — lead with a question or short anecdote about the candidate's background."
      : "Use a direct approach — lead with the value proposition and why this role fits them specifically.";

    // ── Role context + work-arrangement guardrail ──────────────────────────
    // Without the actual job fields the model writes generic recruiter prose
    // and can contradict the role (e.g. asking a candidate for a REMOTE job if
    // they're willing to relocate). Feed it the real role facts and forbid
    // raising relocation in cold outreach.
    const job = await getJob(enrollment.jobId);
    const workTypeLabel = job?.workType === "remote"
      ? "Remote"
      : job?.workType === "hybrid"
        ? "Hybrid"
        : job?.workType === "onsite"
          ? "Onsite"
          : null;
    const roleContext = job
      ? [
          "Role / opportunity context (use ONLY these facts about the job — do not invent others):",
          job.title ? `Job title: ${job.title}` : "",
          workTypeLabel ? `Work arrangement: ${workTypeLabel}` : "",
          job.location ? `Location: ${job.location}` : "",
          job.employmentType ? `Employment type: ${job.employmentType.replace(/_/g, " ")}` : "",
        ].filter(Boolean).join("\n")
      : "Role / opportunity context: not specified — keep the opportunity description generic and do NOT invent job-specific details (location, work arrangement, salary, etc.).";

    const relocationGuardrail = job?.workType === "remote"
      ? `- This role is REMOTE. State or imply it is remote-friendly. NEVER ask whether the candidate is open to relocating, commuting, or moving — relocation is irrelevant for a remote role and asking makes the outreach look automated and careless.`
      : `- NEVER ask whether the candidate is open to relocating, moving, or commuting in this cold outreach. Relocation is a sensitive late-stage topic handled by a human recruiter, never raised in an initial/follow-up outreach email.`;

    try {
      const systemPrompt = `You are a world-class tech recruiter writing personalized outreach emails.
${toneInstruction}
${stepInstruction}
${variantInstruction}

Candidate info:
Name: ${enrollment.recipientName || "there"}
${contextLines}

${roleContext}

Rules:
- Under 180 words
- Do NOT use "I hope this email finds you well" or similar openers
- Do NOT use [BRACKET] placeholders — fill in real content from candidate info above
${relocationGuardrail}
- Do NOT contradict or invent role facts (work arrangement, location, salary, seniority). If a detail isn't given in the role context above, leave it out rather than guessing.
- Sign off as "Alex, Talent Team"
- End with ONE single sentence asking if they're open to a quick chat (e.g. "Would you be open to a 15-minute call this week?"). Phrase it as a normal sentence — NOT as a button, label, link, or quoted option.
- DO NOT include any reply buttons, CTA buttons, action buttons, button-shaped text, "click here" links, HTML, markdown links, or lists of canned replies like "Yes, I am interested" / "Not interested". The system AUTOMATICALLY appends one-click reply buttons after your message — adding your own creates duplicates and confuses the candidate.
- Return valid JSON: { "subject": "...", "body": "..." }
- The body field must be plain prose only — no <button>, no [Yes I'm interested], no markdown buttons, no lists of multiple-choice replies.`;

      const userPrompt = step.bodyTemplate
        ? `Use this as a directional guide (not a template to copy): ${step.bodyTemplate}`
        : `Generate step ${nextStepNum} outreach email.`;

      // Generate, then VERIFY the draft against the relocation/role guardrails.
      // Prompt rules reduce violations but don't guarantee them; this is the
      // deterministic safety net — regenerate once on a violation, then strip
      // the offending sentence as a last resort so it never reaches a candidate.
      async function draft(extraUser?: string) {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          max_tokens: 600,
          temperature: extraUser ? 0.5 : 0.72,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: extraUser ? `${userPrompt}\n\n${extraUser}` : userPrompt },
          ],
          response_format: { type: "json_object" },
        });
        return JSON.parse(completion.choices[0]?.message?.content || "{}");
      }

      let result = await draft();
      let violations = findOutreachViolations(`${result.subject ?? ""}\n${result.body ?? ""}`, { workType: job?.workType });
      if (violations.length > 0) {
        logger.warn({ enrollmentId: enrollment.id, step: nextStepNum, violations: violations.map(v => v.code) }, "Outreach draft violated guardrails — regenerating");
        const correction = `YOUR PREVIOUS DRAFT BROKE A RULE: ${violations.map(v => v.message).join("; ")}. Rewrite the email and DO NOT mention relocation, moving, or commuting anywhere.${job?.workType === "remote" ? " Make clear the role is remote-friendly." : ""}`;
        result = await draft(correction);
      }

      // Final deterministic enforcement: sanitizes subject AND body and
      // substitutes a neutral fallback if sanitizing empties the body, so a
      // guardrail-violating (or blank) message can never reach a candidate.
      const enforced = enforceOutreachGuardrails(
        { subject: result.subject, body: result.body },
        { workType: job?.workType },
      );
      if (enforced.sanitized) {
        logger.error({ enrollmentId: enrollment.id, step: nextStepNum, remaining: enforced.violations.map(v => v.code) }, "Outreach draft STILL violated guardrails after retry — sanitized before send");
      }
      result.subject = enforced.subject;
      const cleanedBody = stripAiCtaButtons(enforced.body || "");
      // Governance: the FIRST outreach message to a candidate must never
      // auto-send — it enters the unified approval queue ("pending_approval")
      // and a human approves it before the scheduler picks it up. Follow-up
      // drip steps (step ≥ 2) keep auto-sending ("scheduled"). The scheduler's
      // sendScheduledMessages only sends "scheduled" rows, so a pending_approval
      // step-1 is naturally skipped until approval flips it to "scheduled".
      const initialStatus = nextStepNum === 1 ? "pending_approval" : "scheduled";
      const [msg] = await db.insert(outreachStepMessagesTable).values({
        campaignId,
        enrollmentId: enrollment.id,
        stepNumber: nextStepNum,
        toEmail: enrollment.recipientEmail,
        subject: result.subject || step.subjectTemplate || "Quick question",
        body: cleanedBody,
        status: initialStatus,
        abVariant: enrollment.abVariant,
        scheduledFor: new Date(),
      }).returning();

      generated.push(msg);
      logger.info({ enrollmentId: enrollment.id, step: nextStepNum }, "Message generated");
    } catch (err: any) {
      logger.error({ enrollmentId: enrollment.id, step: nextStepNum, err: err.message }, "AI generation failed");
    }
  }

  return generated;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3: Send all scheduled messages (simulated — no real email provider yet)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendScheduledMessages(campaignId: string) {
  const pending = await db.select().from(outreachStepMessagesTable)
    .where(and(
      eq(outreachStepMessagesTable.campaignId, campaignId),
      eq(outreachStepMessagesTable.status, "scheduled"),
    ));

  const results = { sent: 0, failed: 0 };
  const now = new Date();

  for (const msg of pending) {
    const [enrollment] = await db.select().from(outreachEnrollmentsTable)
      .where(eq(outreachEnrollmentsTable.id, msg.enrollmentId)).limit(1);

    if (!enrollment || enrollment.status === "replied" || enrollment.status === "stopped") {
      await db.update(outreachStepMessagesTable)
        .set({ status: "failed", failedReason: "Enrollment stopped" })
        .where(eq(outreachStepMessagesTable.id, msg.id));
      continue;
    }

    // ── Pre-send DNC guard ────────────────────────────────────────────────
    const [dncCheck] = await db.select({ doNotContact: candidatesTable.doNotContact })
      .from(candidatesTable)
      .where(eq(candidatesTable.email, msg.toEmail))
      .limit(1);
    if (dncCheck?.doNotContact) {
      await db.update(outreachStepMessagesTable)
        .set({ status: "failed", failedReason: "Do Not Contact – candidate opted out" })
        .where(eq(outreachStepMessagesTable.id, msg.id));
      await db.update(outreachEnrollmentsTable)
        .set({ status: "stopped", updatedAt: now })
        .where(eq(outreachEnrollmentsTable.id, msg.enrollmentId));
      logger.info({ to: msg.toEmail }, "[DNC] Message suppressed – candidate is DNC");
      continue;
    }

    try {
      // Append quick-reply buttons (Interested / Not for this role / Stop
      // emailing me). Same buttons go on every step so the candidate can
      // bail at any time with one click — and DNC is always available.
      const { buildQuickReplyBlocks } = await import("./outreach-reply-tokens");
      const baseUrl = process.env.PUBLIC_API_BASE_URL
        || process.env.REPLIT_DEV_DOMAIN
        || "http://localhost:8080";
      const baseAbs = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
      const quick = buildQuickReplyBlocks(msg.enrollmentId, baseAbs);
      const fullText = `${msg.body || ""}${quick.text}`;
      const fullHtml = `${plainToHtml(msg.body || "")}${quick.html}`;

      // ── Send-router: the FIRST outreach step for a candidate owned by a
      // recruiter goes from that recruiter's OWN Outlook mailbox (Graph);
      // automated follow-ups (step > 1) always stay on SES. Owner = the job's
      // assigned recruiter. Any failure falls back to SES inside sendEmail.
      let senderUserId: string | undefined;
      const ownerJobId = (msg as any).jobId as string | undefined;
      if (ownerJobId && msg.stepNumber === 1) {
        try {
          const [ownerJob] = await db
            .select({ rec: jobsTable.assignedRecruiterId })
            .from(jobsTable)
            .where(eq(jobsTable.id, ownerJobId))
            .limit(1);
          if (ownerJob?.rec) senderUserId = ownerJob.rec;
        } catch {
          /* non-fatal — fall back to SES */
        }
      }

      // Real send via Amazon SES (falls back to a logged simulation when SES_FROM_EMAIL is not set)
      const result = await sendEmail({
        to: msg.toEmail,
        subject: msg.subject,
        html: fullHtml,
        text: fullText,
        senderUserId,
        useRecruiterMailbox: Boolean(senderUserId),
        audit: {
          tenantId: (msg as any).tenantId ?? null,
          actorLabel: "Outreach Engine",
          subjectType: "candidate",
          subjectId: (msg as any).candidateId ?? null,
          subjectLabel: msg.toEmail,
          action: "outreach.message.sent",
          metadata: {
            enrollmentId: msg.enrollmentId,
            stepMessageId: msg.id,
            jobId: (msg as any).jobId ?? null,
          },
        },
      });
      if (!result.ok) throw new Error(result.error || "Email send failed");

      // Demo-domain send was hard-refused at the transport — record it as
      // "suppressed" and DO NOT bump sentCount (or count it in results.sent),
      // so a by-design demo suppression never enters the reply/failure
      // denominators. Advance the enrollment step so the sequence still
      // progresses (nothing is ever actually delivered for demo candidates).
      if (result.suppressed) {
        await db.update(outreachStepMessagesTable)
          .set({ status: "suppressed", sentAt: now })
          .where(eq(outreachStepMessagesTable.id, msg.id));
        await db.update(outreachEnrollmentsTable)
          .set({ currentStep: msg.stepNumber, lastSentAt: now, updatedAt: now })
          .where(eq(outreachEnrollmentsTable.id, msg.enrollmentId));
        continue;
      }

      await db.update(outreachStepMessagesTable)
        .set({ status: "sent", sentAt: now })
        .where(eq(outreachStepMessagesTable.id, msg.id));

      await db.update(outreachEnrollmentsTable)
        .set({
          status: "active",
          currentStep: msg.stepNumber,
          totalStepsSent: sql`${outreachEnrollmentsTable.totalStepsSent} + 1`,
          lastSentAt: now,
          updatedAt: now,
        })
        .where(eq(outreachEnrollmentsTable.id, msg.enrollmentId));

      await db.update(outreachCampaignsTable)
        .set({ sentCount: sql`${outreachCampaignsTable.sentCount} + 1` })
        .where(eq(outreachCampaignsTable.id, campaignId));

      results.sent++;
    } catch (err: any) {
      await db.update(outreachStepMessagesTable)
        .set({ status: "failed", failedReason: err.message })
        .where(eq(outreachStepMessagesTable.id, msg.id));
      results.failed++;
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4: AI reply classification
// ─────────────────────────────────────────────────────────────────────────────
type ReplyClassification = "interested" | "not_interested" | "referral" | "question" | "reengagement" | "out_of_office" | "unsubscribe";
type ReplySentiment = "positive" | "negative" | "neutral" | "out_of_office";

export async function classifyReply(opts: {
  campaignId: string;
  enrollmentId: string;
  messageId?: string;
  replyBody: string;
  /**
   * Inline image attachments parsed from the inbound MIME message. Forwarded
   * to `notifyRecruiterOfReply` so the recruiter inbox dialog can render
   * `[cid:xxx]` tokens as actual images instead of fallback chips.
   */
  replyAttachments?: Array<{ cid: string; filename: string; contentType: string; url: string }>;
}) {
  const { campaignId, enrollmentId, messageId, replyBody, replyAttachments } = opts;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 150,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `Classify this email reply from a job candidate.
You MUST pick exactly one classification from this list — do NOT invent new categories:
- "interested" — wants to learn more about THIS specific role, agreeing, acknowledging positively (e.g. "Yes", "Sure", "Acknowledged", "Sounds good", "Tell me more", "I'm in")
- "not_interested" — politely or firmly declining
- "referral" — suggesting someone else to contact
- "question" — asking a specific question about THIS role that needs an answer before they can decide
- "reengagement" — replying to an old outreach saying they are now actively job-hunting and asking what roles you have for them generally (e.g. "I'm looking for a new job, do you have anything that suits me?", "I'm now open to opportunities — what are you working on?", "Do you have anything else available?", "Any other roles open right now?"). Use when the candidate is asking us to find them a job rather than responding to the original role.
- "out_of_office" — auto-reply / OOO message
- "unsubscribe" — asking to stop emails / do not contact

Short positive acknowledgements like "Acknowledged", "Got it", "Sounds good", "Yes please" are ALWAYS "interested".
Return JSON: { "classification": "<one of the seven above>", "sentiment": "positive|negative|neutral|out_of_office" }`,
      },
      { role: "user", content: replyBody },
    ],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(completion.choices[0]?.message?.content || "{}");

  // ── Validate against the enums; the LLM occasionally invents categories
  // (e.g. "acknowledged", "thanks") which silently break stage advancement.
  const ALLOWED_CLS: ReplyClassification[] = ["interested","not_interested","referral","question","reengagement","out_of_office","unsubscribe"];
  const ALLOWED_SENT: ReplySentiment[] = ["positive","negative","neutral","out_of_office"];
  let classification: ReplyClassification = (ALLOWED_CLS as string[]).includes(result?.classification)
    ? result.classification as ReplyClassification
    : "question";
  let sentiment: ReplySentiment = (ALLOWED_SENT as string[]).includes(result?.sentiment)
    ? result.sentiment as ReplySentiment
    : "neutral";

  // Heuristic safety net: short positive acks → "interested" / "positive"
  const bodyTrim = replyBody.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  const firstLine = bodyTrim.split(/\r?\n/)[0]?.trim() ?? "";
  const POSITIVE_ACK = new Set([
    "acknowledged", "acknowledge", "ack",
    "yes", "yes please", "yes!", "sure", "sure thing", "sounds good",
    "ok", "okay", "ok!", "okay!", "k",
    "got it", "got it!", "noted", "thanks", "thank you",
    "interested", "i'm interested", "im interested", "i am interested",
    "tell me more", "let's talk", "lets talk", "let's chat", "lets chat",
    "happy to chat", "happy to talk", "i'm in", "im in", "count me in",
  ]);
  const aiClassRaw = (result?.classification ?? "").toString().toLowerCase();
  if (
    classification === "question" &&
    (POSITIVE_ACK.has(firstLine) || POSITIVE_ACK.has(bodyTrim) || aiClassRaw === "acknowledged" || aiClassRaw === "ack")
  ) {
    classification = "interested";
    sentiment = "positive";
    logger.info({ enrollmentId, firstLine, aiClassRaw }, "[classifyReply] Short positive ack → reclassified as interested");
  }

  // Heuristic safety net: re-engagement intent ("got anything else for me?")
  // — keep in sync with webhooks.ts REENGAGE_PATTERNS.
  const REENGAGE_PATTERNS = [
    /\b(looking|hunting|searching) (for|to find) (a |an |some |another |new )?(new )?(job|role|opportunit|position|gig)/i,
    /\b(open|available) (to|for) (new )?(opportunit|role|job|position|gig)/i,
    /\bdo you (have|got) (anything|any (other|more) )(else|opportunit|role|job|position)/i,
    /\bwhat (roles|jobs|positions|opportunities) (do you|are) (have|open|hiring|available)/i,
    /\b(any|other) (open|available) (roles|jobs|positions)/i,
    /\b(currently|now|just) (looking|exploring|on the market|job[- ]hunting)/i,
    /\bany (suitable )?(roles|jobs|positions) (that )?(suit|fit|match) /i,
    /\bsuit me\b|\bfit me\b|\bsomething (for|that suits) me\b/i,
    /\bback on the (job )?market\b/i,
  ];
  if (
    classification !== "unsubscribe" &&
    classification !== "not_interested" &&
    classification !== "out_of_office" &&
    REENGAGE_PATTERNS.some(re => re.test(replyBody))
  ) {
    if (classification !== "reengagement") {
      logger.info({ enrollmentId, was: classification }, "[classifyReply] Re-engagement intent detected → reclassified");
    }
    classification = "reengagement";
    sentiment = "positive";
  }

  const [reply] = await db.insert(outreachRepliesTable).values({
    campaignId,
    enrollmentId,
    messageId: messageId || null,
    body: replyBody,
    sentiment,
    classification,
  }).returning();

  // Update enrollment status
  const newStatus = classification === "unsubscribe" ? "stopped" : "replied";
  await db.update(outreachEnrollmentsTable)
    .set({ status: newStatus, repliedAt: new Date(), updatedAt: new Date() })
    .where(eq(outreachEnrollmentsTable.id, enrollmentId));

  // ── DNC propagation on unsubscribe ───────────────────────────────────────
  if (classification === "unsubscribe") {
    const now = new Date();
    // Resolve to a normalised candidate via sourced_candidates if needed
    const [sc] = await db.select().from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, enrollmentId)).limit(1);
    const resolvedId = sc?.normalizedCandidateId ?? null;

    // Mark by normalised candidate ID
    if (resolvedId) {
      await db.update(candidatesTable)
        .set({ doNotContact: true, dncAt: now, dncReason: "ai_unsubscribe", updatedAt: now } as any)
        .where(eq(candidatesTable.id, resolvedId));
    }

    // Also mark by email (covers candidates not yet normalised)
    const [enrl] = await db.select().from(outreachEnrollmentsTable)
      .where(eq(outreachEnrollmentsTable.id, enrollmentId)).limit(1);
    if (enrl?.recipientEmail) {
      await db.update(candidatesTable)
        .set({ doNotContact: true, dncAt: now, dncReason: "ai_unsubscribe", updatedAt: now } as any)
        .where(eq(candidatesTable.email, enrl.recipientEmail));
    }

    logger.info({ enrollmentId }, "[DNC] Candidate flagged via AI unsubscribe detection");
  }

  // Update campaign reply counters
  await db.update(outreachCampaignsTable)
    .set({
      repliedCount: sql`${outreachCampaignsTable.repliedCount} + 1`,
      positiveRepliesCount: sentiment === "positive"
        ? sql`${outreachCampaignsTable.positiveRepliesCount} + 1`
        : outreachCampaignsTable.positiveRepliesCount,
    })
    .where(eq(outreachCampaignsTable.id, campaignId));

  // Advance candidate stage in sourced_candidates
  const [enrollment] = await db.select().from(outreachEnrollmentsTable)
    .where(eq(outreachEnrollmentsTable.id, enrollmentId)).limit(1);

  if (enrollment) {
    const stageMap: Record<string, string> = {
      interested: "interview",
      not_interested: "rejected",
      unsubscribe: "rejected",
      referral: "rejected",
      question: "shortlisted",
      reengagement: "shortlisted",
      out_of_office: "shortlisted",
    };
    const newStage = stageMap[classification] || "shortlisted";
    const [sc] = await db.select().from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, enrollment.candidateId)).limit(1);
    if (sc) {
      const raw = sc.rawData as any;
      if (sc.normalizedCandidateId && enrollment.jobId) {
        await changeCandidateStage({
          tenantId: enrollment.tenantId,
          candidateId: sc.normalizedCandidateId,
          jobId: enrollment.jobId,
          to: newStage,
          actor: { type: "system", label: "Outreach reply classifier" },
          source: "outreach_reply_engine",
          sourcedId: sc.id,
          sourcedRawDataPatch: { replyClassification: classification, replySentiment: sentiment },
          metadata: { classification, sentiment },
        });
      } else {
        // stage-write-exempt: sourced row lacks a canonical candidateId/jobId to key the STAGE_CHANGED event + audit rows
        await db.update(sourcedCandidatesTable)
          .set({ rawData: { ...raw, stage: newStage, replyClassification: classification, replySentiment: sentiment } })
          .where(eq(sourcedCandidatesTable.id, sc.id));
      }
    }

    // Notify the assigned recruiter (inbox + email/digest based on prefs).
    // Covers ALL classifications including not_interested/unsubscribe — the
    // old code silently moved declines to "rejected" with no recruiter
    // signal, leaving recruiters in the dark on bow-outs.
    try {
      const { notifyRecruiterOfReply } = await import("./recruiter-reply-notify.js");
      await notifyRecruiterOfReply({
        tenantId: enrollment.tenantId,
        jobId: enrollment.jobId,
        candidateId: enrollment.candidateId,
        candidateName: enrollment.recipientName ?? null,
        candidateEmail: enrollment.recipientEmail,
        classification,
        body: replyBody,
        campaignId,
        attachments: replyAttachments,
      });
    } catch (err: any) {
      logger.error({ err: err?.message, enrollmentId }, "[classifyReply] recruiter notify failed");
    }

    // Conversation Agent: when the candidate is asking a question on a
    // campaign-driven outreach, draft a reply (and auto-send if the
    // tenant has opted in AND the topic is safe). Mirrors the
    // card-action path in webhooks.ts so behaviour is consistent
    // regardless of how the message was originally sent.
    //
    // Re-engagement Agent: when the candidate is asking us to find them a
    // job ("got anything for me?"), search the tenant's currently active
    // jobs and propose 1-3 matches.
    if (classification === "question") {
      try {
        const { draftReplyToCandidateQuestion } = await import("./agents/outreach-conversation");
        await draftReplyToCandidateQuestion({
          tenantId: enrollment.tenantId,
          jobId: enrollment.jobId,
          sourcedId: enrollment.candidateId,
          candidateId: null,
          candidateEmail: enrollment.recipientEmail,
          candidateName: enrollment.recipientName ?? null,
          inboundBody: replyBody,
          inboundReceivedAt: new Date(),
        });
      } catch (err: any) {
        logger.error({ err: err?.message, enrollmentId }, "[outreach-engine] Conversation Agent failed");
      }
    } else if (classification === "reengagement") {
      try {
        const { draftReengagementReply } = await import("./agents/outreach-conversation");
        await draftReengagementReply({
          tenantId: enrollment.tenantId,
          jobId: enrollment.jobId,
          sourcedId: enrollment.candidateId,
          candidateId: null,
          candidateEmail: enrollment.recipientEmail,
          candidateName: enrollment.recipientName ?? null,
          inboundBody: replyBody,
          inboundReceivedAt: new Date(),
        });
      } catch (err: any) {
        logger.error({ err: err?.message, enrollmentId }, "[outreach-engine] Re-engagement Agent failed");
      }
    }
  }

  return { reply, classification, sentiment };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOPILOT: Generate + Send for a single campaign
// ─────────────────────────────────────────────────────────────────────────────
export async function runAutopilot(campaignId: string) {
  await ensureDefaultSteps(campaignId);
  const generated = await generateMessages(campaignId);
  const sendResult = await sendScheduledMessages(campaignId);

  await db.insert(outreachAutopilotRunsTable).values({
    campaignId,
    messagesGenerated: generated.length,
    messagesSent: sendResult.sent,
    messagesFailed: sendResult.failed,
  });

  logger.info({ campaignId, generated: generated.length, sent: sendResult.sent, failed: sendResult.failed }, "Autopilot run complete");

  return {
    generated: generated.length,
    sent: sendResult.sent,
    failed: sendResult.failed,
  };
}
