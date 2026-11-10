import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import { fingerprint } from "../recruiting-workflows";
import type { ZohoActor } from "./zoho-oauth-store";
import { zohoCampaignReviews } from "./zoho-campaign-reviews";
import { zohoInterviewNoteProvider } from "./zoho-interview-note-provider";
import { zohoInterviewNoteStore } from "./zoho-interview-note-store";
import { zohoOAuthConfig } from "./zoho-oauth-provider";

export const notePreviewInput = z.strictObject({ includeAssessment: z.boolean() });
export const notePublishInput = notePreviewInput.extend({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});
const changed = () =>
  new CalendarError(
    409,
    "zoho_note_changed",
    "This note, review or interview changed. Preview and approve the current text again.",
  );
type Reviews = ReturnType<typeof zohoCampaignReviews>;
export function zohoInterviewNotes({
  reviews = zohoCampaignReviews() as Pick<Reviews, "noteContext" | "detail">,
  provider = zohoInterviewNoteProvider(),
  store = zohoInterviewNoteStore(),
  staffLink = (sessionId: string) => {
    const cfg = zohoOAuthConfig();
    return cfg
      ? cfg.settingsUrl.replace(/\/settings\/ats$/, `/interviews/${encodeURIComponent(sessionId)}`)
      : null;
  },
} = {}) {
  async function document(
    actor: ZohoActor,
    campaignId: string,
    recipientId: string,
    includeAssessment: boolean,
  ) {
    const source = await reviews.noteContext(actor, campaignId, recipientId);
    // A new notes grant may renew the same employer/account, not the campaign.
    const writeRevision = await provider.publicationRevision(actor, source);
    const c = {
      ...source,
      sourceConnectionRevision: source.connectionRevision,
      connectionRevision: writeRevision ?? source.connectionRevision,
    };
    for (const id of [c.applicationId, c.externalCandidateId, c.externalJobId])
      if (!/^[1-9]\d{0,39}$/.test(id)) throw changed();
    const lines = [
      "Lexy interview progress",
      `Zoho job: ${c.externalJobId}`,
      `Zoho application: ${c.applicationId}`,
      `Zoho candidate: ${c.externalCandidateId}`,
      c.invitation.accepted
        ? "Invitation send acceptance recorded (inbox delivery unverified)"
        : `Invitation state: ${c.invitation.state} (send acceptance unconfirmed)`,
      `Invitation record last updated: ${c.invitation.at} (not a confirmed send time)`,
      `Interview state: ${c.sessionStatus ?? "not started"}`,
      ...(c.startedAt ? [`Started: ${c.startedAt}`] : []),
      ...(c.completedAt ? [`Completed: ${c.completedAt}`] : []),
    ];
    if (includeAssessment) {
      const r = await reviews.detail(actor, campaignId, recipientId);
      const decision = r.history[0];
      if (
        !r.reviewable ||
        r.decisionStale ||
        r.answersTruncated ||
        !["completed", "reviewed"].includes(r.sessionStatus) ||
        !r.completedAt ||
        !decision?.evidenceCurrent ||
        !["advance", "hold", "decline"].includes(decision.decision)
      )
        throw new CalendarError(
          409,
          "zoho_assessment_review_required",
          "Complete the interview and save a current human review before approving an assessment for Zoho.",
        );
      lines.push(
        "",
        "Interview assessment — approved for publication by the submitting administrator",
        `Human decision: ${decision.decision}`,
        `Review recorded: ${new Date(decision.createdAt).toISOString()}`,
        `Human review reason: ${decision.reason}`,
        `Interview score: ${r.assessment.score ?? "not available"}`,
        `Summary: ${r.assessment.summary ?? "not available"}`,
        `Recommendation: ${r.assessment.recommendation ?? "not available"}`,
        `Strengths: ${r.assessment.strengths.join("; ") || "not recorded"}`,
        `Development areas: ${r.assessment.developmentAreas.join("; ") || "not recorded"}`,
        `Concerns: ${r.assessment.concerns.join("; ") || "not recorded"}`,
        `Evidence revision: ${r.revision}`,
      );
    }
    if (c.sessionId) {
      const link = staffLink(c.sessionId);
      if (link) lines.push("", `Lexy staff review (sign-in and employer access required): ${link}`);
    }
    lines.push(
      "",
      "This note does not change an ATS hiring stage, reject a candidate, issue an offer or confirm employment.",
    );
    const title = `Lexy interview ${includeAssessment ? "assessment" : "progress"} — job ${c.externalJobId}`;
    const content = lines.join("\n");
    if (content.length > 12000)
      throw new CalendarError(
        422,
        "zoho_note_too_long",
        "This assessment is too long for note publication. Nothing was sent.",
      );
    return {
      c,
      title,
      content,
      revision: fingerprint({ context: c, title, content, includeAssessment }),
      contentRevision: fingerprint({
        accountRef: c.accountRef,
        campaignId,
        recipientId,
        title,
        content,
        includeAssessment,
      }),
    };
  }
  async function preview(
    actor: ZohoActor,
    campaignId: string,
    recipientId: string,
    raw: z.infer<typeof notePreviewInput>,
  ) {
    const input = notePreviewInput.parse(raw);
    const d = await document(actor, campaignId, recipientId, input.includeAssessment);
    const authorized = await provider.permitted(actor, d.c);
    const history = await store.receipts(actor, d.c);
    return {
      revision: d.revision,
      title: d.title,
      content: d.content,
      destination: "Candidates" as const,
      externalCandidateId: d.c.externalCandidateId,
      applicationId: d.c.applicationId,
      externalJobId: d.c.externalJobId,
      includeAssessment: input.includeAssessment,
      writeAuthorized: authorized,
      canPublish:
        authorized &&
        !history.some((h) => h.state === "review_required" || h.revision === d.contentRevision),
      history,
    };
  }
  return {
    preview,
    async publish(
      actor: ZohoActor,
      campaignId: string,
      recipientId: string,
      raw: z.infer<typeof notePublishInput>,
    ) {
      const input = notePublishInput.parse(raw);
      const before = await document(actor, campaignId, recipientId, input.includeAssessment);
      if (before.revision !== input.expectedRevision) throw changed();
      // All remote reads, token refresh and identity checks happen before a write claim.
      const connection = await provider.connect(actor, before.c);
      const current = await document(actor, campaignId, recipientId, input.includeAssessment);
      if (current.revision !== before.revision) throw changed();
      const claim = await store.claim(actor, current.c, current.contentRevision);
      if (!claim.acquired) return claim.receipt;
      try {
        const fresh = await document(actor, campaignId, recipientId, input.includeAssessment);
        if (fresh.revision !== current.revision) throw changed();
        await connection.guard();
        return await store.fence(actor, current.c, async (tx) => {
          const noteId = await connection.create(fresh.title, fresh.content, true);
          return store.delivered(actor, fresh.c, claim.receipt, noteId, tx);
        });
      } catch {
        // Includes failed local receipt persistence after possible provider acceptance.
        // Committed claim remains unresolved: never infer rejection or resend.
        throw new CalendarError(
          409,
          "zoho_note_review_required",
          "Publication was not fully confirmed. Inspect Zoho before further publication. No automatic retry will occur.",
        );
      }
    },
  };
}
