import { zohoInterviewNoteStore } from "./zoho-interview-note-store";
import { assertZohoNoteSourceCurrent } from "./zoho-note-source-current";
import type { CampaignTx } from "./zoho-interview-campaigns";
import type { ZohoActor } from "./zoho-oauth-store";

import { assertStageAuthorityLocked, type StageAuthorityContext } from "./zoho-stage-authority-sql";
export { assertStageAuthorityLocked, type StageAuthorityContext } from "./zoho-stage-authority-sql";

/** Shared by local stage operations and future execution; does not authorize dispatch. */
export function zohoStageAuthority({
  authority = zohoInterviewNoteStore(),
  assertCurrent = assertZohoNoteSourceCurrent,
} = {}) {
  return {
    async fence<T>(
      actor: ZohoActor,
      c: StageAuthorityContext,
      work: (tx: CampaignTx) => Promise<T>,
    ) {
      return authority.fence(actor, c, async (tx) => {
        await assertStageAuthorityLocked(tx, actor, c);
        // Job/plan/campaign locks above may have waited after the note fence's
        // earlier read. Recheck using this transaction, never a second pool.
        await assertCurrent(
          actor,
          c.campaignId,
          c.recipientId,
          c.sourceEvidenceHash,
          c.latestReviewId,
          tx,
        );
        return work(tx);
      });
    },
  };
}
