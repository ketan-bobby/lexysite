/**
 * Guardrail for ONGOING autonomous outreach (anti-ghost nurture, re-engagement,
 * external-click check-ins, follow-ups). These messages keep auto-sending — but
 * only after passing the same deterministic guardrails the first-touch email
 * uses, and only if they don't touch a sensitive topic.
 *
 * Flow:
 *   1. enforceOutreachGuardrails() scrubs relocation/onsite language from the
 *      generated copy (idempotent, side-effect free).
 *   2. scanForSensitiveKeywords() checks the sanitized copy for sensitive topics
 *      (salary, visa, equity, legal/regulatory, …).
 *   3. If sensitive → DO NOT send. Persist a `needs_review` draft in the
 *      recruiter inbox (outreach_conversation_drafts) so a human takes over.
 *   4. Otherwise → return the sanitized subject/body for the caller to send.
 *
 * Returns `{ escalated: true }` when the caller must NOT send, or
 * `{ escalated: false, subject, body }` with the clean copy to send.
 */
import { db, outreachConversationDraftsTable } from "@workspace/db";
import { enforceOutreachGuardrails, type GuardrailContext } from "./outreach-guardrails";
import { scanForSensitiveKeywords } from "./agents/outreach-conversation";
import { recordAudit } from "./audit";
import { logger } from "./logger";

export interface OngoingGuardrailInput {
  tenantId: string;
  candidateId?: string | null;
  sourcedId?: string | null;
  candidateEmail: string;
  candidateName?: string | null;
  jobId?: string | null;
  subject: string;
  body: string;
  /** Where the message came from, for the escalation reasoning + audit. */
  source: string;
  /** Job-context hints (e.g. remote) so relocation scrubbing is accurate. */
  ctx?: GuardrailContext;
}

export type OngoingGuardrailResult =
  | { escalated: true; draftId: string; sensitiveHits: string[] }
  | { escalated: false; subject: string; body: string; sanitized: boolean };

export async function guardrailOngoingMessage(
  input: OngoingGuardrailInput,
): Promise<OngoingGuardrailResult> {
  // 1. Deterministic scrub (relocation / onsite language).
  const enforced = enforceOutreachGuardrails(
    { subject: input.subject, body: input.body },
    input.ctx ?? {},
  );

  // 2. Sensitive-topic scan on the sanitized copy.
  const sensitiveHits = scanForSensitiveKeywords(`${enforced.subject}\n${enforced.body}`);

  if (sensitiveHits.length === 0) {
    return {
      escalated: false,
      subject: enforced.subject,
      body: enforced.body,
      sanitized: enforced.sanitized,
    };
  }

  // 3. Sensitive → escalate to the recruiter inbox instead of auto-sending.
  const reasoning =
    `Override → needs_review: autonomous ${input.source} message touched sensitive topic(s) ` +
    `(${sensitiveHits.join(", ")}). Held for recruiter review instead of auto-sending.`;

  const [draft] = await db
    .insert(outreachConversationDraftsTable)
    .values({
      tenantId: input.tenantId,
      candidateId: input.candidateId ?? null,
      sourcedId: input.sourcedId ?? null,
      candidateEmail: input.candidateEmail,
      candidateName: input.candidateName ?? null,
      jobId: input.jobId ?? null,
      // No real inbound for an outbound escalation — record why it's here.
      inboundBody: `[system] Autonomous ${input.source} message flagged for sensitive content before sending.`,
      inboundReceivedAt: new Date(),
      subject: enforced.subject,
      body: enforced.body,
      verdict: "needs_review",
      reasoning,
      topics: sensitiveHits,
      threadReplyCount: 0,
      status: "pending",
    })
    .returning();

  void recordAudit({
    tenantId: input.tenantId,
    actorType: "agent",
    actorLabel: `Anti-Ghost Guardrail (${input.source})`,
    subjectType: "candidate",
    subjectId: input.candidateId ?? input.sourcedId ?? null,
    subjectLabel: input.candidateName || input.candidateEmail,
    channel: "system",
    direction: "internal",
    action: "outreach.ongoing.escalated",
    title: "Ongoing message escalated to recruiter",
    body: enforced.body.slice(0, 1000),
    metadata: { draftId: draft.id, source: input.source, sensitiveHits, jobId: input.jobId },
  });

  logger.info(
    { tenantId: input.tenantId, draftId: draft.id, source: input.source, sensitiveHits },
    "[ongoing-guardrail] sensitive ongoing message escalated to recruiter inbox",
  );

  return { escalated: true, draftId: draft.id, sensitiveHits };
}
