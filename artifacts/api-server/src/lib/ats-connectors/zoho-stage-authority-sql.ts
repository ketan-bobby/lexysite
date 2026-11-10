import { sql } from "drizzle-orm";
import { CalendarError } from "../outlook-calendar-core";
import type { NoteContext } from "./zoho-interview-note-store";
import type { CampaignTx } from "./zoho-interview-campaigns";
import type { ZohoActor } from "./zoho-oauth-store";

export type StageAuthorityContext = NoteContext & {
  mappingRevision: string;
  custodyRevision: string;
  configFingerprint: string;
};
const changed = () =>
  new CalendarError(
    409,
    "zoho_stage_authority_changed",
    "Stage access, candidate privacy, source evidence or employer permission changed. Refresh and review again.",
  );

/** Internal SQL barrier; caller already holds the shared note-source locks. */
export async function assertStageAuthorityLocked(
  tx: CampaignTx,
  actor: ZohoActor,
  c: StageAuthorityContext,
) {
  if (c.tenantId !== actor.tenantId || !/^[a-f0-9]{64}$/.test(c.custodyRevision)) throw changed();
  const binding = sql`
    SELECT c.id FROM candidates c
    JOIN zoho_campaign_recipients r ON r.candidate_id=c.id AND r.tenant_id=c.tenant_id
    JOIN zoho_interview_campaigns p ON p.id=r.campaign_id AND p.tenant_id=r.tenant_id
      AND p.account_ref=r.account_ref AND p.external_job_id=r.external_job_id
    JOIN zoho_stage_mappings m ON m.campaign_id=p.id AND m.tenant_id=p.tenant_id
    JOIN jobs j ON j.id=p.job_id AND j.tenant_id=p.tenant_id
    JOIN interview_plans ip ON ip.id=p.frozen_plan_id AND ip.tenant_id=p.tenant_id
      AND ip.job_id=j.id
    JOIN zoho_recruit_accounts a ON a.tenant_id=p.tenant_id AND a.account_ref=p.account_ref
    JOIN users u ON u.id=${actor.id} AND u.tenant_id=p.tenant_id
      AND u.role='tenant_admin' AND u.status='active' AND u.account_erased_at IS NULL
    JOIN users o ON o.id=a.user_id AND o.tenant_id=p.tenant_id
      AND o.role='tenant_admin' AND o.status='active' AND o.account_erased_at IS NULL
    WHERE c.id=${c.candidateId} AND c.tenant_id=${actor.tenantId}
      AND c.pool='tenant' AND c.do_not_contact IS NOT TRUE AND c.data_erased_at IS NULL
      AND r.id=${c.recipientId} AND r.campaign_id=${c.campaignId}
      AND r.external_application_id=${c.applicationId}
      AND r.external_candidate_id=${c.externalCandidateId} AND r.external_job_id=${c.externalJobId}
      AND p.revision=${c.sourceConnectionRevision} AND m.revision=${c.mappingRevision}
      AND a.account_ref=${c.accountRef} AND a.revision=${c.connectionRevision}
      AND a.approved_at IS NOT NULL AND a.fingerprint=${c.configFingerprint}
      AND encode(sha256(convert_to(a.refresh_token_enc,'UTF8')),'hex')=${c.custodyRevision}
      AND NOT EXISTS (SELECT 1 FROM candidate_erasure_tombstones t
        WHERE t.subject_id=c.id OR t.subject_id='ats-profile:' ||
          md5(jsonb_build_array(r.tenant_id,'zoho_recruit',r.account_ref,r.external_candidate_id)::text))
    FOR UPDATE OF c FOR SHARE OF r,p,m,j,ip,a,u,o
  `;
  if (!(await tx.execute(binding)).rows.length) throw changed();
  // READ COMMITTED takes its statement snapshot before waiting for locks.
  // An alias tombstone may be inserted by the candidate-lock holder without
  // changing the candidate tuple. Re-evaluate NOT EXISTS under a fresh snapshot
  // after owning the row locks; tuple rechecks alone cannot see that insertion.
  if (!(await tx.execute(binding)).rows.length) throw changed();
}
