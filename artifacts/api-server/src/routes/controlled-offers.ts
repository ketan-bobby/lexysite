import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { dbAdmin, candidatesTable, jobsTable } from "@workspace/db";
import {
  ControlCandidateWorkflowOfferBody,
  RespondToControlledOfferBody,
  ConfigureCandidateOfferRoutingBody,
  ControlCandidateAtsHandoffBody,
  ControlCandidateAtsVerificationBody,
  PreviewCandidateAtsRecordsBody,
  PreviewCandidateAtsRecordsResponse,
  ImportCandidateAtsRecordsBody,
  ImportCandidateAtsRecordsResponse,
  GetCandidateAtsImportsResponse,
  RefreshCandidateAtsImportBody,
  RefreshCandidateAtsImportResponse,
  GetCandidateAtsImportHistoryResponse,
  GetCandidateAtsRefreshScheduleResponse,
  GetCandidateAtsStageOwnershipResponse,
  ControlCandidateAtsStageOwnershipBody,
  ControlCandidateAtsStageOwnershipResponse,
  ControlCandidateAtsRefreshScheduleBody,
  ControlCandidateAtsRefreshScheduleResponse,
} from "@workspace/api-zod";
import { validate } from "../middlewares/validate";
import { gateJobAccess, candidateAllowed } from "./recruiting-workflows";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "./candidates";
import { WorkflowConflict, approvedJob } from "../lib/recruiting-workflows";
import {
  readControlledOffer,
  controlControlledOffer,
  lookupPublicOffer,
  publicOfferView,
  respondControlledOffer,
} from "../lib/controlled-offers";
import type { SendEmailInput, SendEmailResult } from "../lib/email";
import { readOfferRouting, configureOfferRouting } from "../lib/offer-routing";
import { readAtsHandoff, controlAtsHandoff } from "../lib/ats-handoff";
import { readAtsVerification, controlAtsVerification } from "../lib/ats-verification";
import type { GreenhouseGateway } from "../lib/ats-connectors/greenhouse-gateway";
import {
  GetCandidateAtsInterviewResponse,
  PrepareCandidateAtsInterviewBody,
  PrepareCandidateAtsInterviewResponse,
} from "@workspace/api-zod";
import { greenhouseApplicantInterviews } from "../lib/ats-applicant-interviews";
import { greenhouseInterviewInvitations } from "../lib/ats-interview-invitations";
import { greenhouseInterviewNotes } from "../lib/ats-interview-notes";
import { greenhouseNoteRecovery } from "../lib/ats-note-recovery";
import { createAtsCampaignRouter } from "./ats-interview-campaigns";
import { createAtsInvitationEvidenceRouter } from "./ats-invitation-evidence";
import {
  GetCandidateAtsNoteRecoveryParams,
  GetCandidateAtsNoteRecoveryResponse,
  ReconcileCandidateAtsNoteBody,
  ReconcileCandidateAtsNoteParams,
  ReconcileCandidateAtsNoteResponse,
} from "@workspace/api-zod";
import {
  GetCandidateAtsInterviewNoteParams,
  GetCandidateAtsInterviewNoteResponse,
  PublishCandidateAtsInterviewNoteBody,
  PublishCandidateAtsInterviewNoteResponse,
} from "@workspace/api-zod";
import {
  GetCandidateAtsInterviewInvitationResponse,
  SendCandidateAtsInterviewInvitationBody,
  SendCandidateAtsInterviewInvitationResponse,
} from "@workspace/api-zod";
import { previewAtsRecords } from "../lib/ats-preview";
import { importAtsRecords, readAtsImports } from "../lib/ats-imports";
import {
  GetCandidateAtsProfileResponse,
  ControlCandidateAtsProfileBody,
  ControlCandidateAtsProfileResponse,
} from "@workspace/api-zod";
import { readAtsCandidateProfile, controlAtsCandidateProfile } from "../lib/ats-candidate-profiles";
import { refreshAtsImport, readAtsImportHistory } from "../lib/ats-import-refresh";
import { readAtsSchedule, controlAtsSchedule } from "../lib/ats-refresh-schedules";
import { readAtsStageOwnership, controlAtsStageOwnership } from "../lib/ats-stage-ownership";

const path = "/jobs/:jobId/candidate-workflows/:workflowId/offer";
const body = ControlCandidateWorkflowOfferBody.strict();
const responseBody = RespondToControlledOfferBody.strict();

/** Link origin must be the same host as this request, not caller-supplied terms. */
function requestOfferOrigin(req: Request) {
  const origin = req.get("origin");
  const forwarded = req.get("x-forwarded-host")?.split(",")[0].trim();
  const host = forwarded || req.get("host");
  if (!origin || !host)
    throw new WorkflowConflict("Open Lexy in its browser before sending an offer.", 400);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new WorkflowConflict("Invalid application origin.", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.host !== host ||
    url.username ||
    url.password
  )
    throw new WorkflowConflict("Offer link must use this application's origin.", 400);
  return url.origin;
}

export function createControlledOffersRouter(
  deliver?: (input: SendEmailInput) => Promise<SendEmailResult>,
  atsGateway?: GreenhouseGateway,
) {
  const router = Router();
  router.use(createAtsCampaignRouter(atsGateway, deliver));
  router.use(createAtsInvitationEvidenceRouter());
  const importsPath = "/jobs/:jobId/candidate-workflows/:workflowId/ats-imports";
  const schedulePath = "/jobs/:jobId/candidate-workflows/:workflowId/ats-refresh-schedule";
  const ownershipPath = "/jobs/:jobId/candidate-workflows/:workflowId/ats-stage-ownership";
  const profilePath = `${importsPath}/:recordId/profile`;
  const applicantInterviewPath = `${importsPath}/:recordId/interview`;
  const invitationPath = `${importsPath}/:recordId/interview-invitation`;
  const notePath = `${importsPath}/:recordId/interview-note`;
  const recoveryPath = `${importsPath}/:recordId/interview-note-recovery`;
  router.get(recoveryPath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const gate = await gateJobAccess(req, res);
    if (!gate) return;
    const params = GetCandidateAtsNoteRecoveryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid recovery path." });
      return;
    }
    try {
      res.json(
        GetCandidateAtsNoteRecoveryResponse.parse(
          await greenhouseNoteRecovery(atsGateway).read(
            gate.scope,
            params.data.workflowId,
            params.data.recordId,
            (h, id) => candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    recoveryPath,
    validate({ body: ReconcileCandidateAtsNoteBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      const gate = await gateJobAccess(req, res, true);
      if (!gate) return;
      const params = ReconcileCandidateAtsNoteParams.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ error: "Invalid recovery path." });
        return;
      }
      try {
        res.json(
          ReconcileCandidateAtsNoteResponse.parse(
            await greenhouseNoteRecovery(atsGateway).reconcile(
              gate.scope,
              params.data.workflowId,
              params.data.recordId,
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(`${notePath}/:mode`, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      const query = GetCandidateAtsInterviewNoteParams.strict().safeParse(req.params);
      if (!query.success) {
        res.status(400).json({ error: "Choose progress or assessment." });
        return;
      }
      res.json(
        GetCandidateAtsInterviewNoteResponse.parse(
          await greenhouseInterviewNotes(atsGateway).read(
            gate.scope,
            String(req.params.workflowId),
            String(req.params.recordId),
            query.data.mode,
            (h, id) => candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    notePath,
    validate({ body: PublishCandidateAtsInterviewNoteBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          PublishCandidateAtsInterviewNoteResponse.parse(
            await greenhouseInterviewNotes(atsGateway).publish(
              gate.scope,
              String(req.params.workflowId),
              String(req.params.recordId),
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(invitationPath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsInterviewInvitationResponse.parse(
          await greenhouseInterviewInvitations(atsGateway, deliver).read(
            gate.scope,
            String(req.params.workflowId),
            String(req.params.recordId),
            (h, id) => candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    invitationPath,
    validate({ body: SendCandidateAtsInterviewInvitationBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          SendCandidateAtsInterviewInvitationResponse.parse(
            await greenhouseInterviewInvitations(atsGateway, deliver).send(
              gate.scope,
              String(req.params.workflowId),
              String(req.params.recordId),
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(applicantInterviewPath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsInterviewResponse.parse(
          await greenhouseApplicantInterviews(atsGateway).read(
            gate.scope,
            String(req.params.workflowId),
            String(req.params.recordId),
            (h, id) => candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    applicantInterviewPath,
    validate({ body: PrepareCandidateAtsInterviewBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          PrepareCandidateAtsInterviewResponse.parse(
            await greenhouseApplicantInterviews(atsGateway).prepare(
              gate.scope,
              String(req.params.workflowId),
              String(req.params.recordId),
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(profilePath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsProfileResponse.parse(
          await readAtsCandidateProfile(
            gate.scope,
            String(req.params.workflowId),
            String(req.params.recordId),
            (h, id) => candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    profilePath,
    validate({ body: ControlCandidateAtsProfileBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          ControlCandidateAtsProfileResponse.parse(
            await controlAtsCandidateProfile(
              gate.scope,
              String(req.params.workflowId),
              String(req.params.recordId),
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
              atsGateway,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(ownershipPath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsStageOwnershipResponse.parse(
          await readAtsStageOwnership(dbAdmin, gate.scope, String(req.params.workflowId), (h, id) =>
            candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    ownershipPath,
    validate({ body: ControlCandidateAtsStageOwnershipBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          ControlCandidateAtsStageOwnershipResponse.parse(
            await controlAtsStageOwnership(
              gate.scope,
              String(req.params.workflowId),
              req.body,
              (h, id) => candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(schedulePath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsRefreshScheduleResponse.parse(
          await readAtsSchedule(gate.scope, String(req.params.workflowId), (h, id) =>
            candidateAllowed(h, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    schedulePath,
    validate({ body: ControlCandidateAtsRefreshScheduleBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          ControlCandidateAtsRefreshScheduleResponse.parse(
            await controlAtsSchedule(gate.scope, String(req.params.workflowId), req.body, (h, id) =>
              candidateAllowed(h, gate, id),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(`${importsPath}/:recordId/history`, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsImportHistoryResponse.parse(
          await readAtsImportHistory(
            gate.scope,
            String(req.params.workflowId),
            String(req.params.recordId),
            (handle, id) => candidateAllowed(handle, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    `${importsPath}/:recordId/refresh`,
    validate({ body: RefreshCandidateAtsImportBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          RefreshCandidateAtsImportResponse.parse(
            await refreshAtsImport(
              gate.scope,
              String(req.params.workflowId),
              String(req.params.recordId),
              req.body,
              (handle, id) => candidateAllowed(handle, gate, id),
              atsGateway,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(importsPath, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        GetCandidateAtsImportsResponse.parse(
          await readAtsImports(gate.scope, String(req.params.workflowId), (handle, id) =>
            candidateAllowed(handle, gate, id),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    importsPath,
    validate({ body: ImportCandidateAtsRecordsBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          ImportCandidateAtsRecordsResponse.parse(
            await importAtsRecords(
              gate.scope,
              String(req.params.workflowId),
              req.body,
              (handle, id) => candidateAllowed(handle, gate, id),
              atsGateway,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.post(
    "/jobs/:jobId/candidate-workflows/:workflowId/ats-preview",
    validate({ body: PreviewCandidateAtsRecordsBody.strict() }),
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          PreviewCandidateAtsRecordsResponse.parse(
            await previewAtsRecords(
              gate.scope,
              String(req.params.workflowId),
              req.body,
              (handle, id) => candidateAllowed(handle, gate, id),
              atsGateway,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  const verificationPath = "/jobs/:jobId/candidate-workflows/:workflowId/ats-verification";
  router.get(verificationPath, async (req, res) => {
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.set("Cache-Control", "private, no-store");
      res.json(
        await readAtsVerification(
          gate.scope,
          String(req.params.workflowId),
          (handle, id) => candidateAllowed(handle, gate, id),
          atsGateway,
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    verificationPath,
    validate({ body: ControlCandidateAtsVerificationBody.strict() }),
    async (req, res) => {
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.set("Cache-Control", "private, no-store");
        res.json(
          await controlAtsVerification(
            gate.scope,
            String(req.params.workflowId),
            req.body,
            (handle, id) => candidateAllowed(handle, gate, id),
            atsGateway,
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  const handoffPath = "/jobs/:jobId/candidate-workflows/:workflowId/ats-handoff";
  router.get(handoffPath, async (req, res) => {
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.set("Cache-Control", "private, no-store");
      res.json(
        await readAtsHandoff(gate.scope, String(req.params.workflowId), (handle, id) =>
          candidateAllowed(handle, gate, id),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    handoffPath,
    validate({ body: ControlCandidateAtsHandoffBody.strict() }),
    async (req, res) => {
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.set("Cache-Control", "private, no-store");
        res.json(
          await controlAtsHandoff(
            gate.scope,
            String(req.params.workflowId),
            req.body,
            (handle, id) => candidateAllowed(handle, gate, id),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  const routingPath = "/jobs/:jobId/candidate-workflows/:workflowId/offer-routing";
  router.get(routingPath, async (req, res) => {
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        await readOfferRouting(gate.scope, String(req.params.workflowId), (handle, id) =>
          candidateAllowed(handle, gate, id),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    routingPath,
    validate({ body: ConfigureCandidateOfferRoutingBody.strict() }),
    async (req, res) => {
      try {
        const gate = await gateJobAccess(req, res, true);
        if (!gate) return;
        res.json(
          await configureOfferRouting(
            gate.scope,
            String(req.params.workflowId),
            req.body,
            (handle, id) => candidateAllowed(handle, gate, id),
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  router.get(path, async (req, res) => {
    try {
      const gate = await gateJobAccess(req, res);
      if (!gate) return;
      res.json(
        await readControlledOffer(gate.scope, String(req.params.workflowId), (handle, id) =>
          candidateAllowed(handle, gate, id),
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post(path, validate({ body }), async (req, res) => {
    try {
      // Offer authority is explicitly assigned by the employer, not inferred from role.
      const gate = await gateJobAccess(req, res, true);
      if (!gate) return;
      const baseUrl = req.body.action === "send" ? requestOfferOrigin(req) : undefined;
      res.json(
        await controlControlledOffer(
          gate.scope,
          String(req.params.workflowId),
          req.body,
          (handle, id) => candidateAllowed(handle, gate, id),
          { baseUrl, send: deliver },
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  async function publicVisibility(
    handle: typeof dbAdmin,
    jobId: string,
    tenantId: string,
    candidateId: string,
  ) {
    const [job] = await handle
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
    if (!job || !approvedJob(job.status)) return false;
    const rows = await handle
      .select()
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId));
    const hard = applyCandidateHardExclusions(rows);
    return (await applyCandidatePrivacyFilter(hard, tenantId)).length === 1;
  }

  // Secret token possession + current row/privacy seal; never staff-cookie auth.
  router.get("/controlled-offers/public/:token", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const found = await lookupPublicOffer(String(req.params.token));
      if (
        !(await publicVisibility(
          dbAdmin,
          found.row.jobId,
          found.row.tenantId,
          found.row.candidateId,
        ))
      )
        throw new WorkflowConflict("Offer unavailable.", 404);
      res.set("Cache-Control", "no-store");
      res.json(publicOfferView(found.offer));
    } catch (error) {
      if (error instanceof WorkflowConflict) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.post(
    "/controlled-offers/public/:token",
    validate({ body: responseBody }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const found = await lookupPublicOffer(String(req.params.token));
        const visible = (
          handle: Parameters<Parameters<typeof controlControlledOffer>[3]>[0],
          id: string,
        ) => publicVisibility(handle as typeof dbAdmin, found.row.jobId, found.row.tenantId, id);
        // Scope comes from the validated token, never a candidate/job/tenant in req.body.
        res.set("Cache-Control", "no-store");
        res.json(
          await respondControlledOffer(
            String(req.params.token),
            req.body.decision,
            req.body.reason,
            visible,
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowConflict) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
  return router;
}
export default createControlledOffersRouter();
