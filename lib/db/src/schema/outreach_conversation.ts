/**
 * schema/outreach_conversation.ts — AI Outreach Conversation Draft Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   outreach_conversation_drafts   — AI-generated reply drafts awaiting recruiter
 *                                    approval. Created by the outreach-conversation
 *                                    agent when a candidate asks a question or
 *                                    requests re-engagement. Status lifecycle:
 *                                    pending → (approved → auto_sending → sent) |
 *                                    rejected | needs_review.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/agents/outreach-conversation.ts   — creates and auto-sends drafts
 *   routes/conversation-drafts.ts          — recruiter approval queue API
 */
import { pgTable, text, timestamp, jsonb, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * outreach_conversation_drafts — AI-generated replies to candidate questions.
 *
 * When a candidate replies with a "question" classification (e.g. "Tell me
 * more about the role"), the Outreach Conversation Agent reads the question
 * along with job/ICP/company context and produces a draft reply.
 *
 * Each draft has a `verdict`:
 *   • "safe_to_send" — purely informational, no salary/visa/start-date/legal
 *     content; the AI is confident the answer is factual and uncontroversial.
 *   • "needs_review" — touches a sensitive topic, ambiguous, or the AI is
 *     not confident; a recruiter must approve.
 *
 * A draft moves to status "sent" when delivered (either auto or by a
 * recruiter clicking Approve), "rejected" when a recruiter dismisses it,
 * or "expired" when stale.
 */
export const outreachConversationDraftsTable = pgTable(
  "outreach_conversation_drafts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),

    // Who we're replying to.
    candidateId: text("candidate_id"),
    sourcedId: text("sourced_id"),
    candidateEmail: text("candidate_email").notNull(),
    candidateName: text("candidate_name"),
    jobId: text("job_id"),

    // The question we're answering (so reviewers see context inline).
    inboundBody: text("inbound_body").notNull(),
    inboundReceivedAt: timestamp("inbound_received_at").notNull(),

    // Draft contents.
    subject: text("subject").notNull(),
    body: text("body").notNull(),

    // Routing decision.
    //   "safe_to_send" | "needs_review"
    verdict: text("verdict").notNull(),
    // Free-text rationale from the AI ("classified as role-info, no
    // sensitive topics detected"). Surfaced in the recruiter UI.
    reasoning: text("reasoning"),
    // Topics the AI thinks the candidate is asking about
    // (e.g. ["role_scope", "tech_stack"]). Used for analytics + UI.
    topics: jsonb("topics"),

    // How many auto-replies have already been sent in this thread.
    // The 4th question in any thread is forced to needs_review regardless
    // of topic safety so a human stays in the loop on long conversations.
    threadReplyCount: integer("thread_reply_count").notNull().default(0),

    // Lifecycle:
    //   "pending" → waiting for recruiter
    //   "auto_sending" → tenant has auto-send-safe enabled and verdict was safe_to_send
    //   "sent" → delivered to candidate
    //   "rejected" → recruiter dismissed
    //   "expired" → not actioned within N days
    status: text("status").notNull().default("pending"),
    // Who sent it. "ai" if auto-sent, userId if recruiter approved.
    sentBy: text("sent_by"),
    sentAt: timestamp("sent_at"),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at"),
    rejectedReason: text("rejected_reason"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    tenantStatusIdx: index("ocd_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    candidateIdx: index("ocd_candidate_idx").on(t.candidateEmail, t.jobId),
  }),
);

export type OutreachConversationDraft = typeof outreachConversationDraftsTable.$inferSelect;
export type InsertOutreachConversationDraft = typeof outreachConversationDraftsTable.$inferInsert;
