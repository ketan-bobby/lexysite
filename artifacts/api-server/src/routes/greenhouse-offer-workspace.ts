import { Router } from "express";
import { z } from "zod/v4";
import {
  GetGreenhouseOfferWorkspaceResponse,
  ControlGreenhouseOfferWorkspaceBody,
  ControlGreenhouseOfferWorkspaceResponse,
} from "@workspace/api-zod";
import { gateJobAccess, candidateAllowed } from "./recruiting-workflows";
import { greenhouseOfferWorkspace } from "../lib/greenhouse-offer-workspace";
import { WorkflowConflict } from "../lib/recruiting-workflows";
import { CalendarError } from "../lib/outlook-calendar-core";

/** Default service has neither evidence nor a transport: no provider calls are possible. */
export function createGreenhouseOfferWorkspaceRouter(workspace = greenhouseOfferWorkspace()) {
  const router = Router();
  const path = "/jobs/:jobId/candidate-workflows/:workflowId/greenhouse-offer";
  for (const method of ["get", "post"] as const) {
    router[method](path, async (req, res): Promise<void> => {
      res.set("Cache-Control", "private, no-store");
      const gate = await gateJobAccess(req, res, method === "post");
      if (!gate) return;
      const id = z.uuid().safeParse(req.params.workflowId);
      if (!id.success) {
        res.status(400).json({ error: "Invalid financial workspace." });
        return;
      }
      try {
        const visible: Parameters<typeof workspace.read>[2] = (handle, candidateId) =>
          candidateAllowed(handle, gate, candidateId);
        if (method === "get") {
          res.json(
            GetGreenhouseOfferWorkspaceResponse.parse(
              await workspace.read(gate.scope, id.data, visible),
            ),
          );
        } else {
          const input = ControlGreenhouseOfferWorkspaceBody.strict().safeParse(req.body);
          if (!input.success || input.data.confirm !== true) {
            res.status(400).json({ error: "Invalid human-confirmed financial action." });
            return;
          }
          res.json(
            ControlGreenhouseOfferWorkspaceResponse.parse(
              await workspace.control(gate.scope, id.data, input.data, visible),
            ),
          );
        }
      } catch (error) {
        if (error instanceof WorkflowConflict || error instanceof CalendarError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        if (error instanceof z.ZodError) {
          res
            .status(400)
            .json({ error: "Check the financial field types, dates and selected staff." });
          return;
        }
        throw error;
      }
    });
  }
  return router;
}
