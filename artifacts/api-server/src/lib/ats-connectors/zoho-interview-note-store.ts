import { randomUUID } from "node:crypto";
import { and, eq, desc, sql } from "drizzle-orm";
import { auditLogsTable as audits, dbAdmin } from "@workspace/db";
import { CalendarError } from "../outlook-calendar-core";
import type { ZohoActor } from "./zoho-oauth-store";
import type { NoteBinding } from "./zoho-interview-note-provider";
import { assertZohoNoteSourceCurrent } from "./zoho-note-source-current";
import type { CampaignTx } from "./zoho-interview-campaigns";

export type NoteContext = NoteBinding & {
  candidateId: string;
  campaignId: string;
  recipientId: string;
  tenantId: string;
  sourceEvidenceHash: string;
  latestReviewId: string | null;
  sourceConnectionRevision: string;
};
export type NoteReceipt = {
  id: string;
  revision: string;
  state: "published" | "review_required";
  providerNoteId: string | null;
  at: string;
};
const changed = () =>
  new CalendarError(
    409,
    "zoho_note_changed",
    "The interview, candidate, employer connection or access changed. Refresh before publishing.",
  );
export function zohoInterviewNoteStore({ database = dbAdmin } = {}) {
  async function receipts(
    actor: ZohoActor,
    c: NoteContext,
    handle: Pick<typeof dbAdmin, "select"> = dbAdmin,
  ) {
    const rows = await handle
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.tenantId, actor.tenantId),
          eq(audits.subjectId, c.recipientId),
          sql`${audits.action} IN ('zoho.interview_note.claimed','zoho.interview_note.published')`,
        ),
      )
      .orderBy(desc(audits.createdAt));
    const metadata = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const delivered = new Map(
      rows
        .filter((r) => r.action.endsWith(".published"))
        .map((r) => [String(metadata(r.metadata).attemptId), r]),
    );
    return rows
      .filter((r) => r.action.endsWith(".claimed"))
      .map((r) => {
        const done = delivered.get(r.id);
        return {
          id: r.id,
          revision: String(metadata(r.metadata).revision),
          state: done ? ("published" as const) : ("review_required" as const),
          providerNoteId:
            typeof metadata(done?.metadata).providerNoteId === "string"
              ? String(metadata(done?.metadata).providerNoteId)
              : null,
          at: (done?.createdAt ?? r.createdAt).toISOString(),
        };
      });
  }
  // Source locks fence erasure, staff revocation and account replacement during I/O.
  async function fence<T>(actor: ZohoActor, c: NoteContext, work: (tx: CampaignTx) => Promise<T>) {
    return database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
      // Match review writes' user -> recipient -> candidate lock order.
      await tx.execute(sql`SELECT id FROM users WHERE id=${actor.id}
        AND tenant_id=${actor.tenantId} AND role='tenant_admin' AND status='active' FOR SHARE`);
      await tx.execute(sql`SELECT id FROM zoho_campaign_recipients WHERE id=${c.recipientId}
        AND tenant_id=${actor.tenantId} AND campaign_id=${c.campaignId} FOR UPDATE`);
      const binding = sql`SELECT c.id FROM candidates c
        JOIN zoho_campaign_recipients r ON r.candidate_id=c.id AND c.tenant_id=r.tenant_id
        JOIN zoho_interview_campaigns p ON p.id=r.campaign_id AND p.tenant_id=r.tenant_id
          AND p.account_ref=r.account_ref AND p.external_job_id=r.external_job_id
        JOIN users u ON u.id=${actor.id} AND u.tenant_id=r.tenant_id
          AND u.role='tenant_admin' AND u.status='active' AND u.account_erased_at IS NULL
        JOIN zoho_recruit_accounts a ON a.tenant_id=r.tenant_id
          AND a.account_ref=p.account_ref AND a.approved_at IS NOT NULL
        JOIN users o ON o.id=a.user_id AND o.tenant_id=r.tenant_id
          AND o.role='tenant_admin' AND o.status='active' AND o.account_erased_at IS NULL
        WHERE c.id=${c.candidateId} AND c.data_erased_at IS NULL
          AND r.id=${c.recipientId} AND r.campaign_id=${c.campaignId}
          AND r.tenant_id=${actor.tenantId} AND r.account_ref=${c.accountRef}
          AND r.external_job_id=${c.externalJobId}
          AND r.external_candidate_id=${c.externalCandidateId}
          AND r.external_application_id=${c.applicationId}
          AND a.revision=${c.connectionRevision}
          AND p.revision=${c.sourceConnectionRevision}
          AND NOT EXISTS (SELECT 1 FROM candidate_erasure_tombstones t
            WHERE t.subject_id=c.id OR t.subject_id='ats-profile:' ||
              md5(jsonb_build_array(r.tenant_id,'zoho_recruit',r.account_ref,r.external_candidate_id)::text))
        FOR UPDATE OF c FOR SHARE OF u,o,a`;
      if (!(await tx.execute(binding)).rows.length) throw changed();
      if (!(await tx.execute(binding)).rows.length) throw changed();
      await tx.execute(sql`SELECT s.id FROM interview_sessions s
        JOIN zoho_campaign_recipients r ON r.session_id=s.id
        WHERE r.id=${c.recipientId} AND r.tenant_id=${actor.tenantId}
          AND s.tenant_id=${actor.tenantId} AND s.candidate_id=${c.candidateId}
        FOR SHARE OF s`);
      await tx.execute(sql`SELECT v.id FROM interview_summaries v
        JOIN zoho_campaign_recipients r ON r.session_id=v.interview_session_id
        WHERE r.id=${c.recipientId} AND r.tenant_id=${actor.tenantId} FOR SHARE OF v`);
      await assertZohoNoteSourceCurrent(
        actor,
        c.campaignId,
        c.recipientId,
        c.sourceEvidenceHash,
        c.latestReviewId,
        tx,
      );
      return work(tx);
    });
  }
  return {
    receipts,
    fence,
    async claim(
      actor: ZohoActor,
      c: NoteContext,
      revision: string,
    ): Promise<{ receipt: NoteReceipt; acquired: boolean }> {
      // Serializes across processes; committed claim precedes the provider request.
      return dbAdmin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${actor.tenantId + ":zoho-note:" + c.recipientId},0))`);
        const prior = await receipts(actor, c, tx);
        const same = prior.find((r) => r.revision === revision);
        if (same) return { receipt: same, acquired: false };
        if (prior.some((r) => r.state === "review_required"))
          throw new CalendarError(
            409,
            "zoho_note_review_required",
            "A previous note attempt may have reached Zoho. Inspect it before any further publication; automatic retry is disabled.",
          );
        const id = randomUUID(),
          at = new Date();
        await tx.insert(audits).values({
          id,
          tenantId: actor.tenantId,
          actorId: actor.id,
          actorType: "user",
          subjectType: "external",
          subjectId: c.recipientId,
          channel: "system",
          direction: "outbound",
          action: "zoho.interview_note.claimed",
          title: "Interview-note publication claimed; outcome unconfirmed",
          metadata: { revision, campaignId: c.campaignId },
          createdAt: at,
        });
        return {
          receipt: {
            id,
            revision,
            state: "review_required",
            providerNoteId: null,
            at: at.toISOString(),
          },
          acquired: true,
        };
      });
    },
    async delivered(
      actor: ZohoActor,
      c: NoteContext,
      attempt: NoteReceipt,
      providerNoteId: string,
      handle: Pick<typeof dbAdmin, "insert"> = dbAdmin,
    ) {
      const at = new Date();
      await handle.insert(audits).values({
        tenantId: actor.tenantId,
        actorId: actor.id,
        actorType: "user",
        subjectType: "external",
        subjectId: c.recipientId,
        channel: "system",
        direction: "outbound",
        action: "zoho.interview_note.published",
        title: "Zoho acknowledged an interview note",
        metadata: {
          attemptId: attempt.id,
          revision: attempt.revision,
          providerNoteId,
          campaignId: c.campaignId,
        },
        createdAt: at,
      });
      return { ...attempt, state: "published" as const, providerNoteId, at: at.toISOString() };
    },
  };
}
