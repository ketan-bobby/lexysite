import type { z } from "zod/v4";
import type { ZohoActor } from "./zoho-oauth-store";
import { zohoStageHandoff } from "./zoho-stage-handoff";
import { zohoReviewedImport } from "./zoho-reviewed-import";
import { campaignById } from "./zoho-interview-campaigns";
import { matchStageMappings, stageMetadataInput } from "./zoho-stage-metadata-policy";
import { fingerprint } from "../recruiting-workflows";
import { CalendarError } from "../outlook-calendar-core";
import { stageEligibility } from "./zoho-stage-eligibility";

export function zohoStageValidation({
  handoff = zohoStageHandoff(),
  source = zohoReviewedImport(),
  campaignLookup = campaignById,
} = {}) {
  const conflict = () =>
    new CalendarError(
      409,
      "zoho_stage_validation_changed",
      "The connection, mapping or interview decision changed. Reload before checking again.",
    );
  return {
    async check(
      actor: ZohoActor,
      campaignId: string,
      recipientId: string,
      raw: z.infer<typeof stageMetadataInput>,
    ) {
      const input = stageMetadataInput.parse(raw);
      const before = await handoff.detail(actor, campaignId, recipientId);
      if (before.revision !== input.expectedRevision) throw conflict();
      const campaign = await campaignLookup(actor, campaignId);
      let metadata;
      try {
        metadata = await source.stageMetadata(
          actor,
          campaign.revision,
          before.externalJobId,
          before.applicationId,
          before.externalCandidateId,
        );
      } catch (error) {
        if (
          error instanceof CalendarError &&
          ["zoho_module_scope_missing", "zoho_module_access_denied"].includes(error.code)
        )
          throw new CalendarError(
            409,
            "zoho_stage_metadata_access_required",
            "Zoho did not permit read-only stage metadata access. The employer must authorize ZohoRecruit.settings.stage.READ and permit stage settings access before this check can finish. No permissions or records were changed.",
          );
        throw error;
      }
      if (metadata.accountRef !== campaign.accountRef) throw conflict();
      await metadata.assertCurrent();
      const after = await handoff.detail(actor, campaignId, recipientId);
      if (after.revision !== before.revision) throw conflict();
      const freshCampaign = await campaignLookup(actor, campaignId);
      if (
        freshCampaign.accountRef !== campaign.accountRef ||
        freshCampaign.revision !== campaign.revision
      )
        throw conflict();
      await metadata.assertCurrent();
      const matches = matchStageMappings(after.mapping, metadata.statuses);
      return {
        handoffRevision: after.revision,
        mappingRevision: after.mapping.revision,
        connectionRevision: campaign.revision,
        checkedAt: new Date().toISOString(),
        applicationId: metadata.binding.applicationId,
        externalJobId: metadata.binding.jobId,
        externalCandidateId: metadata.binding.candidateId,
        currentApplicationStatus: metadata.binding.currentStatus,
        identityVerified: true,
        catalogScope: "organization_default" as const,
        transitionEligibilityVerified: false,
        liveEnabled: false,
        catalogRevision: fingerprint({
          accountRef: metadata.accountRef,
          connection: campaign.revision,
          statuses: [...metadata.statuses].sort((a, b) => a.id.localeCompare(b.id)),
        }),
        mappings: stageEligibility(matches, metadata.binding.currentStatus),
        reason:
          "Application identity checked. Matches are against Zoho's organization default stage catalog only, not proof that this job/application permits a transition. No status was changed.",
      };
    },
  };
}
