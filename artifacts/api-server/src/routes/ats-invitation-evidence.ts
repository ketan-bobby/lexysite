import { Router } from "express";
import {
  GetCandidateAtsInvitationEvidenceParams,
  GetCandidateAtsInvitationEvidenceResponse,
  ReconcileCandidateAtsInvitationParams,
  ReconcileCandidateAtsInvitationBody,
  ReconcileCandidateAtsInvitationResponse,
} from "@workspace/api-zod";
import { gateJobAccess, candidateAllowed } from "./recruiting-workflows";
import { validate } from "../middlewares/validate";
import { WorkflowConflict } from "../lib/recruiting-workflows";
import { readAtsInvitationEvidence, reconcileAtsInvitation } from "../lib/ats-invitation-evidence";
export function createAtsInvitationEvidenceRouter() {
  const router = Router(),
    path =
      "/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview-invitation-evidence";
  router.get(path, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const gate = await gateJobAccess(req, res);
    if (!gate) return;
    const p = GetCandidateAtsInvitationEvidenceParams.safeParse(req.params);
    if (!p.success) {
      res.status(400).json({ error: "Invalid invitation evidence path." });
      return;
    }
    try {
      res.json(
        GetCandidateAtsInvitationEvidenceResponse.parse(
          await readAtsInvitationEvidence(gate.scope, p.data.workflowId, p.data.recordId, (h, id) =>
            candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (!(error instanceof WorkflowConflict)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  router.post(
    path,
    validate({ body: ReconcileCandidateAtsInvitationBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const gate = await gateJobAccess(req, res, true);
      if (!gate) return;
      const p = ReconcileCandidateAtsInvitationParams.safeParse(req.params);
      if (!p.success) {
        res.status(400).json({ error: "Invalid invitation evidence path." });
        return;
      }
      try {
        res.json(
          ReconcileCandidateAtsInvitationResponse.parse(
            await reconcileAtsInvitation(
              gate.scope,
              p.data.workflowId,
              p.data.recordId,
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (!(error instanceof WorkflowConflict)) throw error;
        res.status(error.status).json({ error: error.message });
      }
    },
  );
  return router;
}
