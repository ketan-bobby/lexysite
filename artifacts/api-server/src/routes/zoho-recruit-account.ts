import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { getAuthUserId } from "../lib/auth-token";
import { CalendarError } from "../lib/outlook-calendar-core";
import { zohoEmployerAdmin, zohoOAuthService } from "../lib/ats-connectors/zoho-oauth-service";
import {
  zohoCallbackReason,
  zohoFailure,
  zohoOAuthConfig,
} from "../lib/ats-connectors/zoho-oauth-provider";
import { logger } from "../lib/logger";
import {
  zohoInterviewNotes,
  notePreviewInput,
  notePublishInput,
} from "../lib/ats-connectors/zoho-interview-notes";
import {
  PreviewZohoInterviewNoteResponse,
  PublishZohoInterviewNoteResponse,
} from "@workspace/api-zod";
import { zohoAccessCheck } from "../lib/ats-connectors/zoho-access-check";
import { CheckZohoRecruitAccessResponse, ListZohoJobApplicantsResponse } from "@workspace/api-zod";
import {
  PreviewZohoRecruitImportResponse,
  ConfirmZohoRecruitImportResponse,
} from "@workspace/api-zod";
import { zohoReviewedImport } from "../lib/ats-connectors/zoho-reviewed-import";
import {
  zohoImportSelection,
  zohoImportConfirmation,
  zohoJobApplicantSelection,
} from "../lib/ats-connectors/zoho-intake-record";
import { zohoInterviewCampaigns } from "../lib/ats-connectors/zoho-interview-campaigns";
import { campaignSelection, campaignAction } from "../lib/ats-connectors/zoho-campaign-policy";
import { zohoCampaignReviews } from "../lib/ats-connectors/zoho-campaign-reviews";
import { zohoReviewInput } from "../lib/ats-connectors/zoho-review-policy";
import { zohoStageHandoff } from "../lib/ats-connectors/zoho-stage-handoff";
import {
  zohoStageRequests,
  stageRequestInput,
  stageRequestAction,
} from "../lib/ats-connectors/zoho-stage-requests";
import {
  GetZohoStageRequestsResponse,
  PrepareZohoStageRequestResponse,
  ActOnZohoStageRequestResponse,
} from "@workspace/api-zod";
import { zohoStageValidation } from "../lib/ats-connectors/zoho-stage-validation";
import { zohoReviewExport, zohoReviewExportInput } from "../lib/ats-connectors/zoho-review-export";
import { PrepareZohoReviewExportResponse } from "@workspace/api-zod";
import { stageMetadataInput } from "../lib/ats-connectors/zoho-stage-metadata-policy";
import { CheckZohoStageMetadataResponse } from "@workspace/api-zod";
import {
  stageMappingInput,
  stageHandoffInput,
} from "../lib/ats-connectors/zoho-stage-handoff-policy";
import {
  GetZohoStageHandoffResponse,
  SaveZohoStageMappingResponse,
  TestZohoStageHandoffResponse,
} from "@workspace/api-zod";
import {
  GetZohoCampaignReviewQueueResponse,
  GetZohoCampaignApplicantReviewResponse,
  RecordZohoCampaignApplicantReviewResponse,
} from "@workspace/api-zod";
import {
  GetZohoCampaignWorkspaceResponse,
  CreateZohoInterviewCampaignResponse,
  GetZohoInterviewCampaignResponse,
  ActOnZohoInterviewCampaignResponse,
} from "@workspace/api-zod";

const cookieName = "lexy_zoho_flow";
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/api/zoho-recruit",
};
export function zohoRecruitAccountRouter(
  deps = {
    actor: zohoEmployerAdmin,
    service: zohoOAuthService,
    config: zohoOAuthConfig,
  },
  accessCheck = zohoAccessCheck,
  reviewedImport: () => Pick<
    ReturnType<typeof zohoReviewedImport>,
    "preview" | "confirm" | "applicants"
  > = zohoReviewedImport,
  campaignService = zohoInterviewCampaigns,
  reviewService = zohoCampaignReviews,
  handoffService = zohoStageHandoff,
  validationService = zohoStageValidation,
  exportService = zohoReviewExport,
  noteService = zohoInterviewNotes,
  stageRequests = zohoStageRequests,
) {
  const router = Router();
  const safeError = (res: Response, error: unknown) => {
    const safe = error instanceof CalendarError ? error : zohoFailure();
    return res.status(safe.status).json({ code: safe.code, error: safe.message });
  };
  const handle =
    (work: (req: Request, actor: Awaited<ReturnType<typeof deps.actor>>) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.set("Cache-Control", "no-store");
      try {
        return res.json(await work(req, await deps.actor(getAuthUserId(req))));
      } catch (error) {
        return safeError(res, error);
      }
    };
  const stageIds = z.object({ id: z.uuid(), recipientId: z.uuid() });
  router.get(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-requests",
    handle(async (req, actor) => {
      const ids = stageIds.safeParse(req.params);
      if (!ids.success) throw zohoFailure("invalid_request", 400);
      const scoped = await stageRequests().gateCandidateAccess(actor, {
        campaignId: ids.data.id,
        recipientId: ids.data.recipientId,
      });
      return GetZohoStageRequestsResponse.parse(await scoped.view());
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-requests",
    handle(async (req, actor) => {
      const ids = stageIds.safeParse(req.params);
      const body = stageRequestInput.safeParse(req.body);
      if (!ids.success || !body.success) throw zohoFailure("invalid_request", 400);
      const scoped = await stageRequests().gateCandidateAccess(actor, {
        campaignId: ids.data.id,
        recipientId: ids.data.recipientId,
      });
      return PrepareZohoStageRequestResponse.parse(await scoped.prepare(body.data));
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-requests/:requestId/actions",
    handle(async (req, actor) => {
      const ids = stageIds.extend({ requestId: z.uuid() }).safeParse(req.params);
      const body = stageRequestAction.safeParse(req.body);
      if (!ids.success || !body.success) throw zohoFailure("invalid_request", 400);
      const scoped = await stageRequests().gateCandidateAccess(actor, {
        campaignId: ids.data.id,
        recipientId: ids.data.recipientId,
      });
      return ActOnZohoStageRequestResponse.parse(await scoped.act(ids.data.requestId, body.data));
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/note-preview",
    handle(async (req, actor) => {
      const ids = z.object({ id: z.uuid(), recipientId: z.uuid() }).safeParse(req.params);
      const body = notePreviewInput.safeParse(req.body);
      if (!ids.success || !body.success) throw zohoFailure("invalid_request", 400);
      const view = await noteService().preview(actor, ids.data.id, ids.data.recipientId, body.data);
      return PreviewZohoInterviewNoteResponse.parse({
        ...view,
        history: view.history.map((receipt) => ({ ...receipt, at: new Date(receipt.at) })),
      });
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/note-publication",
    handle(async (req, actor) => {
      const ids = z.object({ id: z.uuid(), recipientId: z.uuid() }).safeParse(req.params);
      const body = notePublishInput.safeParse(req.body);
      if (!ids.success || !body.success) throw zohoFailure("invalid_request", 400);
      const receipt = await noteService().publish(
        actor,
        ids.data.id,
        ids.data.recipientId,
        body.data,
      );
      return PublishZohoInterviewNoteResponse.parse({ ...receipt, at: new Date(receipt.at) });
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/review-export",
    handle(async (req, actor) => {
      const ids = z.object({ id: z.uuid(), recipientId: z.uuid() }).safeParse(req.params);
      const body = zohoReviewExportInput.safeParse(req.body);
      if (!ids.success || !body.success) throw zohoFailure("invalid_request", 400);
      return PrepareZohoReviewExportResponse.parse(
        await exportService().prepare(actor, ids.data.id, ids.data.recipientId, body.data),
      );
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-validation",
    handle(async (req, actor) => {
      const ids = z.object({ id: z.uuid(), recipientId: z.uuid() }).safeParse(req.params);
      const body = stageMetadataInput.safeParse(req.body);
      if (!ids.success || !body.success) throw zohoFailure("invalid_request", 400);
      return CheckZohoStageMetadataResponse.parse(
        await validationService().check(actor, ids.data.id, ids.data.recipientId, body.data),
      );
    }),
  );
  router.get(
    "/zoho-recruit/account",
    handle(async (_req, actor) => deps.service().status(actor)),
  );
  router.post("/zoho-recruit/account/connect", async (req, res) => {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    try {
      const actor = await deps.actor(getAuthUserId(req));
      const consent = z
        .strictObject({
          confirmEmployerAuthority: z.literal(true),
          includeStageMetadata: z.boolean().optional(),
          includeInterviewNotes: z.boolean().optional(),
          includeStageWrites: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!consent.success) throw zohoFailure("zoho_consent_required", 400);
      const { browser, ...receipt } = await deps
        .service()
        .begin(
          actor,
          consent.data.includeStageMetadata === true,
          consent.data.includeInterviewNotes === true,
          consent.data.includeStageWrites === true,
        );
      res.cookie(cookieName, browser, { ...cookieOptions, maxAge: 10 * 60_000 });
      return res.json(receipt);
    } catch (error) {
      return safeError(res, error);
    }
  });
  for (const action of ["approve", "disconnect"] as const)
    router.post(
      `/zoho-recruit/account/${action}`,
      handle(async (req, actor) => {
        const parsed = z
          .strictObject({
            revision: z.uuid(),
            confirm: z.literal(true),
          })
          .safeParse(req.body);
        if (!parsed.success) throw zohoFailure("zoho_confirmation_required", 400);
        return deps.service()[action](actor, parsed.data.revision);
      }),
    );
  router.post(
    "/zoho-recruit/account/check-access",
    handle(async (req, actor) => {
      const parsed = z
        .strictObject({ revision: z.uuid(), confirm: z.literal(true) })
        .safeParse(req.body);
      if (!parsed.success) throw zohoFailure("zoho_confirmation_required", 400);
      return CheckZohoRecruitAccessResponse.parse(
        await accessCheck().check(actor, parsed.data.revision),
      );
    }),
  );
  router.post(
    "/zoho-recruit/imports/preview",
    handle(async (req, actor) => {
      const parsed = zohoImportSelection.safeParse(req.body);
      if (!parsed.success) throw zohoFailure("zoho_confirmation_required", 400);
      return PreviewZohoRecruitImportResponse.parse(
        await reviewedImport().preview(actor, parsed.data),
      );
    }),
  );
  router.post(
    "/zoho-recruit/imports/confirm",
    handle(async (req, actor) => {
      const parsed = zohoImportConfirmation.safeParse(req.body);
      if (!parsed.success) throw zohoFailure("zoho_confirmation_required", 400);
      return ConfirmZohoRecruitImportResponse.parse(
        await reviewedImport().confirm(actor, parsed.data),
      );
    }),
  );
  router.post(
    "/zoho-recruit/applicants",
    handle(async (req, actor) => {
      const parsed = zohoJobApplicantSelection.safeParse(req.body);
      if (!parsed.success) throw zohoFailure("zoho_confirmation_required", 400);
      return ListZohoJobApplicantsResponse.parse(
        await reviewedImport().applicants(actor, parsed.data),
      );
    }),
  );
  router.get(
    "/zoho-recruit/campaigns",
    handle(async (_req, actor) =>
      GetZohoCampaignWorkspaceResponse.parse(await campaignService().workspace(actor)),
    ),
  );
  router.put(
    "/zoho-recruit/campaigns/:id/stage-mapping",
    handle(async (req, actor) => {
      const id = z.uuid().safeParse(req.params.id);
      const input = stageMappingInput.safeParse(req.body);
      if (!id.success || !input.success) throw zohoFailure("zoho_confirmation_required", 400);
      return SaveZohoStageMappingResponse.parse(
        await handoffService().saveMapping(actor, id.data, input.data),
      );
    }),
  );
  const handoffParams = z.object({ id: z.uuid(), recipientId: z.uuid() });
  router.get(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/handoff",
    handle(async (req, actor) => {
      const params = handoffParams.safeParse(req.params);
      if (!params.success) throw zohoFailure("not_found", 404);
      return GetZohoStageHandoffResponse.parse(
        await handoffService().detail(actor, params.data.id, params.data.recipientId),
      );
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/handoff",
    handle(async (req, actor) => {
      const params = handoffParams.safeParse(req.params);
      const input = stageHandoffInput.safeParse(req.body);
      if (!params.success || !input.success) throw zohoFailure("zoho_confirmation_required", 400);
      return TestZohoStageHandoffResponse.parse(
        await handoffService().simulate(actor, params.data.id, params.data.recipientId, input.data),
      );
    }),
  );
  router.post(
    "/zoho-recruit/campaigns",
    handle(async (req, actor) => {
      const input = campaignSelection.safeParse(req.body);
      if (!input.success) throw zohoFailure("zoho_confirmation_required", 400);
      return CreateZohoInterviewCampaignResponse.parse(
        await campaignService().create(actor, input.data),
      );
    }),
  );
  router.get(
    "/zoho-recruit/campaigns/:id",
    handle(async (req, actor) => {
      const id = z.uuid().safeParse(req.params.id);
      if (!id.success) throw zohoFailure("zoho_confirmation_required", 400);
      return GetZohoInterviewCampaignResponse.parse(await campaignService().detail(actor, id.data));
    }),
  );
  router.get(
    "/zoho-recruit/campaigns/:id/reviews",
    handle(async (req, actor) => {
      const id = z.uuid().safeParse(req.params.id);
      if (!id.success) throw zohoFailure("zoho_confirmation_required", 400);
      return GetZohoCampaignReviewQueueResponse.parse(await reviewService().queue(actor, id.data));
    }),
  );
  router.get(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/review",
    handle(async (req, actor) => {
      const params = z.object({ id: z.uuid(), recipientId: z.uuid() }).safeParse(req.params);
      if (!params.success) throw zohoFailure("zoho_confirmation_required", 400);
      return GetZohoCampaignApplicantReviewResponse.parse(
        await reviewService().detail(actor, params.data.id, params.data.recipientId),
      );
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/recipients/:recipientId/review",
    handle(async (req, actor) => {
      const params = z.object({ id: z.uuid(), recipientId: z.uuid() }).safeParse(req.params);
      const input = zohoReviewInput.safeParse(req.body);
      if (!params.success || !input.success) throw zohoFailure("zoho_confirmation_required", 400);
      return RecordZohoCampaignApplicantReviewResponse.parse(
        await reviewService().record(actor, params.data.id, params.data.recipientId, input.data),
      );
    }),
  );
  router.post(
    "/zoho-recruit/campaigns/:id/action",
    handle(async (req, actor) => {
      const id = z.uuid().safeParse(req.params.id);
      const input = campaignAction.safeParse(req.body);
      if (!id.success || !input.success) throw zohoFailure("zoho_confirmation_required", 400);
      return ActOnZohoInterviewCampaignResponse.parse(
        await campaignService().act(actor, id.data, input.data),
      );
    }),
  );
  router.get("/zoho-recruit/callback", async (req, res) => {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const config = deps.config();
    const browser = typeof req.cookies?.[cookieName] === "string" ? req.cookies[cookieName] : "";
    res.clearCookie(cookieName, cookieOptions);
    if (!config) return res.status(503).send("Zoho Recruit authorization is not configured.");
    const target = new URL(config.settingsUrl);
    try {
      await deps.service().finish(await deps.actor(getAuthUserId(req)), {
        state: typeof req.query.state === "string" ? req.query.state : "",
        code: typeof req.query.code === "string" ? req.query.code : "",
        denied: req.query.error !== undefined,
        location: typeof req.query.location === "string" ? req.query.location : "",
        accountsServer:
          typeof req.query["accounts-server"] === "string" ? req.query["accounts-server"] : "",
        browser,
      });
      target.searchParams.set("zoho", "review");
    } catch (error) {
      const reason = zohoCallbackReason(error);
      logger.warn({ reason }, "[zoho-recruit] Authorization callback failed");
      target.searchParams.set("zoho", "error");
      target.searchParams.set("reason", reason);
    }
    return res.redirect(303, target.toString());
  });
  return router;
}
export default zohoRecruitAccountRouter();
