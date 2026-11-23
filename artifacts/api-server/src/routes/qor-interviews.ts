import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  GetQorInterviewRequestResponse,
  SubmitQorInterviewRequestBody,
  SubmitQorInterviewRequestHeader,
  SubmitQorInterviewRequestResponse,
} from "@workspace/api-zod";
import { dbAdmin } from "@workspace/db";
import { resolveUser } from "../middlewares/resolveUser";
import { checkInterviewCreationAllowed, recordCreditEvent } from "../lib/plan-enforcement";
import { interviewRoomUrl } from "../lib/interview-link-url";
import { logger } from "../lib/logger";
import { QorError, missingQorRequest, qorConflict } from "../lib/qor-interview-policy";
import {
  prepareQorInterview,
  qorBoundContext,
  qorCredential,
  qorInvitationReview,
  qorPreparation,
  qorReportReview,
  qorRequest,
  qorReviewer,
  qorStatus,
  recordQorInvitation,
  recordQorReport,
  submitQorRequest,
} from "../lib/qor-interview-requests";

const path = "/partner/v1/interview-requests";
const reviewPath = "/partner-review/v1/interview-requests/:requestId";
const requestIdentity = z.uuid();
const id = z.string().trim().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0);
const confirmed = z.literal(true);
const binding = z.strictObject({ jobId: id, candidateId: id, planId: id });
const actions = z.discriminatedUnion("action", [
  binding.extend({ action: z.literal("prepare"), reviewHash: hash, confirm: confirmed }),
  z.strictObject({ action: z.literal("release_invitation"), reviewHash: hash, confirm: confirmed }),
  z.strictObject({
    action: z.literal("record_invitation_sent"),
    reviewHash: hash,
    confirm: confirmed,
  }),
  z.strictObject({
    action: z.literal("approve_report"),
    reviewHash: hash,
    expectedVersion: version,
    confirm: confirmed,
  }),
  z.strictObject({
    action: z.literal("withdraw_report"),
    expectedVersion: version,
    confirm: confirmed,
  }),
]);
const invalid = () => new QorError(400, "invalid_request", "Invalid request data or approval.");

function endpoint<T>(handle: (req: Request, res: Response) => Promise<T>) {
  return async (req: Request, res: Response) => {
    res.set("Cache-Control", "private, no-store");
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof QorError) {
        if (err.status === 401) res.set("WWW-Authenticate", "Bearer");
        res.status(err.status).json({ code: err.code, error: err.message });
      } else {
        // Never log the request, parameters, binding, PG detail or provider text.
        logger.error({ operation: req.method }, "QOR interview request unavailable");
        res.status(503).json({ code: "unavailable", error: "QOR interview service unavailable." });
      }
    }
  };
}

function requestId(value: unknown) {
  const parsed = requestIdentity.safeParse(value);
  if (!parsed.success) throw missingQorRequest();
  return parsed.data;
}

export function createQorInterviewRouter({
  checkAllowed = async (tenantId: string) =>
    (await checkInterviewCreationAllowed(tenantId)).allowed,
  addCredit = (tenantId: string, sessionId: string) =>
    recordCreditEvent({
      tenantId,
      kind: "interview",
      refId: sessionId,
      metadata: { source: "qor-preparation" },
    }),
  roomUrl = interviewRoomUrl,
} = {}) {
  const router = Router();
  router.post(
    path,
    endpoint(async (req, res) => {
      const result = await dbAdmin.transaction(async (tx) => {
        const tenantId = await qorCredential(tx, req.get("authorization"), "create");
        const key = SubmitQorInterviewRequestHeader.safeParse({
          "Idempotency-Key": req.get("idempotency-key"),
        });
        const body = SubmitQorInterviewRequestBody.strict().safeParse(req.body);
        if (!key.success || !body.success) throw invalid();
        const input = {
          externalApplicationId: body.data.externalApplicationId.trim(),
          selectionRef: body.data.selectionRef.trim(),
          job: {
            externalId: body.data.job.externalId.trim(),
            title: body.data.job.title.trim(),
            brief: body.data.job.brief.trim(),
            revision: body.data.job.revision.trim(),
            approvalRef: body.data.job.approvalRef.trim(),
          },
          candidate: {
            externalId: body.data.candidate.externalId.trim(),
            firstName: body.data.candidate.firstName.trim(),
            lastName: body.data.candidate.lastName.trim(),
            email: body.data.candidate.email.toLowerCase(),
          },
        };
        if (
          !Object.values(input.job).every(Boolean) ||
          !Object.values(input.candidate).every(Boolean) ||
          !input.externalApplicationId ||
          !input.selectionRef
        )
          throw invalid();
        if (
          [
            input.externalApplicationId,
            input.selectionRef,
            ...Object.values(input.job),
            ...Object.values(input.candidate),
          ].some((value) => value.includes("\0"))
        )
          throw invalid();
        if (
          ["job", "candidate"].some((field) =>
            Object.keys(req.body[field]).some(
              (key) => !Object.hasOwn(input[field as "job" | "candidate"], key),
            ),
          )
        )
          throw invalid();
        return submitQorRequest(tx, tenantId, input, key.data["Idempotency-Key"]);
      });
      res
        .location(`/api${path}/${result.requestId}`)
        .status(result.replayed ? 200 : 201)
        .json(SubmitQorInterviewRequestResponse.parse(result));
    }),
  );
  router.get(
    `${path}/:requestId`,
    endpoint(async (req, res) => {
      const result = await dbAdmin.transaction(async (tx) => {
        const tenantId = await qorCredential(tx, req.get("authorization"), "read");
        const row = await qorRequest(tx, tenantId, requestId(req.params.requestId));
        return qorStatus(tx, row, await qorBoundContext(tx, row));
      });
      res.json(GetQorInterviewRequestResponse.parse(result));
    }),
  );

  // Staff review lives outside the machine credential namespace. It is never
  // callable with a partner key, and does not expose an automated mail sender.
  router.get(
    reviewPath,
    resolveUser,
    endpoint(async (req, res) => {
      const result = await dbAdmin.transaction(async (tx) => {
        const tenantId = await qorReviewer(tx, req.resolvedUser!.id);
        const row = await qorRequest(tx, tenantId, requestId(req.params.requestId));
        const bound = await qorBoundContext(tx, row);
        const selected = Object.keys(req.query).length ? binding.safeParse(req.query) : null;
        if (selected && !selected.success) throw invalid();
        const preparation = selected?.success ? await qorPreparation(tx, row, selected.data) : null;
        const invitation = bound ? await qorInvitationReview(tx, bound) : null;
        const report = bound && (await qorReportReview(tx, bound));
        return {
          request: {
            id: row.id,
            externalApplicationId: row.externalApplicationId,
            externalCandidateId: row.externalCandidateId,
            selectionRef: row.selectionRef,
            job: {
              externalId: row.externalJobId,
              title: row.jobTitle,
              brief: row.jobBrief,
              revision: row.jobRevision,
              approvalRef: row.jobApprovalRef,
            },
          },
          status: await qorStatus(tx, row, bound),
          preparation:
            preparation && !preparation.alreadyPrepared
              ? {
                  reviewHash: preparation.reviewHash,
                  planTitle: preparation.plan.title,
                  language: preparation.plan.language,
                  questions: preparation.plan.questions,
                }
              : null,
          invitation,
          reportReview: { expectedVersion: (bound?.row ?? row).reportVersion, ...report },
        };
      });
      res.json(result);
    }),
  );
  router.post(
    reviewPath,
    resolveUser,
    endpoint(async (req, res) => {
      const parsed = actions.safeParse(req.body);
      if (!parsed.success) throw invalid();
      const input = parsed.data;
      const result = await dbAdmin.transaction(async (tx) => {
        const userId = req.resolvedUser!.id;
        const tenantId = await qorReviewer(tx, userId);
        const row = await qorRequest(tx, tenantId, requestId(req.params.requestId));
        if (input.action === "prepare") {
          if (!row.sessionId && !(await checkAllowed(tenantId)))
            throw new QorError(
              409,
              "interview_limit",
              "Native interview preparation is unavailable for this employer.",
            );
          return {
            tenantId,
            ...(await prepareQorInterview(tx, row, input, input.reviewHash, userId)),
          };
        }
        const bound = await qorBoundContext(tx, row, true);
        if (!bound) throw qorConflict("Prepare a reviewed interview first.");
        if (input.action === "release_invitation" || input.action === "record_invitation_sent") {
          const sent = input.action === "record_invitation_sent";
          await recordQorInvitation(tx, bound, userId, input.reviewHash, sent);
          return sent
            ? { status: "staff_reported_sent" }
            : {
                status: "ready_to_share",
                roomUrl: roomUrl(bound.session!.id),
                recipient: bound.candidate.email,
              };
        }
        await recordQorReport(
          tx,
          bound,
          userId,
          input.expectedVersion,
          input.action === "approve_report" ? input.reviewHash : null,
        );
        return { status: input.action === "approve_report" ? "approved" : "withdrawn" };
      });
      if ("sessionId" in result && result.prepared) {
        // Same post-commit accounting boundary as native link minting.
        await addCredit(result.tenantId, result.sessionId).catch(() =>
          logger.warn("QOR interview credit receipt could not be written"),
        );
      }
      res.json("sessionId" in result ? { status: "prepared" } : result);
    }),
  );
  return router;
}
