import { Router, type Response } from "express";
import {
  GetCandidateAtsCampaignsParams,
  GetCandidateAtsCampaignsResponse,
  PrepareCandidateAtsCampaignParams,
  PrepareCandidateAtsCampaignBody,
  PrepareCandidateAtsCampaignResponse,
  GetCandidateAtsCampaignParams,
  GetCandidateAtsCampaignResponse,
  ControlCandidateAtsCampaignParams,
  ControlCandidateAtsCampaignBody,
  ControlCandidateAtsCampaignResponse,
  DispatchCandidateAtsCampaignMemberParams,
  DispatchCandidateAtsCampaignMemberBody,
  DispatchCandidateAtsCampaignMemberResponse,
} from "@workspace/api-zod";
import { validate } from "../middlewares/validate";
import { gateJobAccess, candidateAllowed } from "./recruiting-workflows";
import { WorkflowConflict } from "../lib/recruiting-workflows";
import { greenhouseInterviewCampaigns } from "../lib/ats-interview-campaigns";
import type { GreenhouseGateway } from "../lib/ats-connectors/greenhouse-gateway";
import type { SendEmailInput, SendEmailResult } from "../lib/email";

function failure(res: Response, error: unknown) {
  if (!(error instanceof WorkflowConflict)) throw error;
  res.status(error.status).json({ error: error.message });
}
export function createAtsCampaignRouter(
  gateway?: GreenhouseGateway,
  deliver?: (input: SendEmailInput) => Promise<SendEmailResult>,
) {
  const router = Router();
  const path = "/jobs/:jobId/candidate-workflows/:workflowId/ats-interview-campaigns";
  const service = greenhouseInterviewCampaigns(gateway, deliver);
  router.get(path, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const gate = await gateJobAccess(req, res);
    if (!gate) return;
    const p = GetCandidateAtsCampaignsParams.safeParse(req.params);
    if (!p.success) {
      res.status(400).json({ error: "Invalid campaign path." });
      return;
    }
    try {
      res.json(
        GetCandidateAtsCampaignsResponse.parse(
          await service.index(gate.scope, p.data.workflowId, (h, id) =>
            candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.post(
    path,
    validate({ body: PrepareCandidateAtsCampaignBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const gate = await gateJobAccess(req, res, true);
      if (!gate) return;
      const p = PrepareCandidateAtsCampaignParams.safeParse(req.params);
      if (!p.success) {
        res.status(400).json({ error: "Invalid campaign path." });
        return;
      }
      try {
        res.json(
          PrepareCandidateAtsCampaignResponse.parse(
            await service.prepare(gate.scope, p.data.workflowId, req.body, (h, id) =>
              candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        failure(res, error);
      }
    },
  );
  router.get(`${path}/:campaignId`, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const gate = await gateJobAccess(req, res);
    if (!gate) return;
    const p = GetCandidateAtsCampaignParams.safeParse(req.params);
    if (!p.success) {
      res.status(400).json({ error: "Invalid campaign path." });
      return;
    }
    try {
      res.json(
        GetCandidateAtsCampaignResponse.parse(
          await service.read(gate.scope, p.data.workflowId, p.data.campaignId, (h, id) =>
            candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.post(
    `${path}/:campaignId/control`,
    validate({ body: ControlCandidateAtsCampaignBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const gate = await gateJobAccess(req, res, true);
      if (!gate) return;
      const p = ControlCandidateAtsCampaignParams.safeParse(req.params);
      if (!p.success) {
        res.status(400).json({ error: "Invalid campaign path." });
        return;
      }
      try {
        res.json(
          ControlCandidateAtsCampaignResponse.parse(
            await service.control(
              gate.scope,
              p.data.workflowId,
              p.data.campaignId,
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        failure(res, error);
      }
    },
  );
  router.post(
    `${path}/:campaignId/members/:memberId/dispatch`,
    validate({ body: DispatchCandidateAtsCampaignMemberBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const gate = await gateJobAccess(req, res, true);
      if (!gate) return;
      const p = DispatchCandidateAtsCampaignMemberParams.safeParse(req.params);
      if (!p.success) {
        res.status(400).json({ error: "Invalid campaign path." });
        return;
      }
      try {
        res.json(
          DispatchCandidateAtsCampaignMemberResponse.parse(
            await service.dispatch(
              gate.scope,
              p.data.workflowId,
              p.data.campaignId,
              p.data.memberId,
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        failure(res, error);
      }
    },
  );
  return router;
}
