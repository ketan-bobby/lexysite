import { Router, type Request, type Response } from "express";
import { and, eq, sql, desc, or, lt } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  jobsTable,
  tenantsTable,
  recruitingWorkflowsTable as workflows,
  recruitingJourneysTable as journeys,
} from "@workspace/db";
import type { OfferInboxEntry, OfferInboxItem } from "@workspace/api-zod";
import { GetEmployerOfferInboxQueryParams } from "@workspace/api-zod";
import { validate } from "../middlewares/validate";
import { getAuthUserId } from "../lib/auth-token";
import { WorkflowConflict, readBrief, approvedJob } from "../lib/recruiting-workflows";
import { offerAuthority, readOfferRouting } from "../lib/offer-routing";
import { readControlledOffer } from "../lib/controlled-offers";
import { offerView } from "../lib/controlled-offer-view";
import {
  resolveWorkflowJobAccess,
  eligibleCandidates,
  candidateAllowed,
} from "./recruiting-workflows";

const router = Router();
const staff = ["tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];
type User = typeof usersTable.$inferSelect;
type Row = typeof workflows.$inferSelect;
type Gate = Awaited<ReturnType<typeof resolveWorkflowJobAccess>>;
type Authority = Awaited<ReturnType<typeof offerAuthority>>;
type Context = {
  gate: Gate;
  employerName: string;
  candidates: Awaited<ReturnType<typeof eligibleCandidates>>;
  brief: Awaited<ReturnType<typeof readBrief>>;
  available?: Authority["available"];
};

async function caller(req: Request) {
  const id = getAuthUserId(req);
  if (!id) throw new WorkflowConflict("Unauthorized", 401);
  const [user] = await dbAdmin.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user || user.status !== "active") throw new WorkflowConflict("Unauthorized", 401);
  if (!staff.includes(user.role))
    throw new WorkflowConflict("Offer inbox is restricted to assigned employer staff.", 403);
  return user;
}

/** Assigned IDs are server-owned JSON; membership alone never includes an offer. */
function assigned(user: User) {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflows.steps}) step
    WHERE step->>'key'='hiring_decision'
    AND ((step->'offerRouting'->>'ownerUserId')=${user.id}
      OR (step->'offerRouting'->>'approverUserId')=${user.id}
      OR (step->'offerRouting'->>'senderUserId')=${user.id}))`;
}

async function context(user: User, jobId: string) {
  const gate = await resolveWorkflowJobAccess(user, jobId);
  const candidates = await eligibleCandidates(dbAdmin, gate);
  const [employer] = await dbAdmin
    .select({ name: tenantsTable.name })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, gate.scope.tenantId));
  return {
    gate,
    employerName: employer?.name || "Employer",
    candidates,
    brief: await readBrief(dbAdmin, gate.scope),
  } satisfies Context;
}

async function entry(row: Row, ctx: Context): Promise<OfferInboxEntry | null> {
  const candidate = ctx.candidates.find((c) => c.id === row.candidateId);
  if (!candidate) return null; // Current DNC/erasure/privacy and application-link seals.
  const authority = await offerAuthority(dbAdmin, ctx.gate.scope, row, ctx.available);
  ctx.available = authority.available;
  const config = authority.config;
  if (!config || !authority.available.some((user) => user.id === ctx.gate.user.id)) return null;
  const roles: OfferInboxEntry["roles"] = [];
  if (config.mode === "external") {
    if (config.ownerUserId === ctx.gate.user.id) roles.push("contact");
  } else {
    if (authority.canManageTerms) roles.push("owner");
    if (authority.canApprove) roles.push("approver");
    if (authority.canSend) roles.push("sender");
  }
  if (!roles.length) return null;
  const step = row.steps.find((s) => s.key === "hiring_decision")!;
  const [journey] = await dbAdmin
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, row.journeyId),
        eq(journeys.tenantId, row.tenantId),
        eq(journeys.jobId, row.jobId),
      ),
    );
  const ready =
    approvedJob(ctx.brief.job.status) &&
    row.status === "completed" &&
    step.humanDecision?.outcome === "hire" &&
    journey?.status === "approved" &&
    journey.version === row.journeyVersion &&
    journey.briefHash === ctx.brief.hash;
  const testOnly = step.humanDecision?.testOnly === true;
  const warnings: string[] = [];
  if (testOnly)
    warnings.push(
      "TEST ONLY — synthetic workflow evidence is not real qualification, identity clearance or an employment decision.",
    );
  if (!ready)
    warnings.push(
      "A current approved work order and completed structured human Hire decision are required. Review the work order before proceeding.",
    );
  if (candidate.verificationStatus !== "verified")
    warnings.push(
      "Candidate identity verification is not confirmed. An offer response does not clear identity or confirm employment.",
    );
  for (const s of row.steps) {
    if (s.status !== "completed") warnings.push(`${s.label}: ${s.status}.`);
    // Retain actual evidence notes in detail; do not invent clearance from a green step.
  }
  const offer = step.controlledOffer ? offerView(step.controlledOffer) : null;
  const expiredPendingOffer = Boolean(
    offer &&
    ["draft", "review_required", "approved"].includes(offer.status) &&
    Date.parse(offer.terms.expiresAt) <= Date.now(),
  );
  let status = offer?.status ?? "not_started";
  let nextAction: OfferInboxEntry["nextAction"] = "monitor";
  if (config.mode === "external") {
    status = ready
      ? "awaiting_employer"
      : step.humanDecision?.outcome === "hold" || step.humanDecision?.outcome === "decline"
        ? "paused"
        : "awaiting_hiring_decision";
    nextAction = ready ? "external_handoff" : "blocked";
    warnings.push("Manual external handoff only: this is not a connected or synchronized ATS.");
  } else if (!ready) nextAction = "blocked";
  else if (offer?.status === "expired" || expiredPendingOffer) {
    nextAction = authority.canManageTerms ? "prepare" : "blocked";
    warnings.push(
      "This unsent offer has expired. Do not send it; review or withdraw it before preparing a fresh version.",
    );
  } else if (offer?.status === "sending" || offer?.status === "send_uncertain") {
    nextAction = "blocked";
    warnings.push("Delivery is in progress or uncertain. Do not retry sending or assume delivery.");
  } else if (offer?.status === "review_required" && authority.canApprove) nextAction = "review";
  else if (offer?.status === "approved" && authority.canSend) nextAction = "send";
  else if (
    (!offer || ["draft", "withdrawn", "expired"].includes(offer.status)) &&
    authority.canManageTerms
  )
    nextAction = "prepare";
  if (
    offer?.providerDelivery &&
    ["delayed", "bounced", "rejected", "complained"].includes(offer.providerDelivery.status)
  ) {
    warnings.push(
      `AWS reported offer email ${offer.providerDelivery.status}. Review the delivery issue; this does not authorize a resend, change the recipient response or confirm employment.`,
    );
  }
  return {
    workflowId: row.id,
    jobId: row.jobId,
    candidateId: row.candidateId,
    candidateName: `${candidate.firstName} ${candidate.lastName}`.trim(),
    jobTitle: ctx.gate.job.title,
    employerName: ctx.employerName,
    updatedAt: row.updatedAt.toISOString(),
    mode: config.mode,
    roles,
    status,
    nextAction,
    testOnly,
    workflowRevision: row.revision,
    warnings,
  };
}

function fail(res: Response, error: unknown) {
  if (error instanceof WorkflowConflict) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
}

router.get(
  "/offer-inbox",
  validate({ query: GetEmployerOfferInboxQueryParams }),
  async (req, res) => {
    try {
      const user = await caller(req);
      const query: ReturnType<typeof GetEmployerOfferInboxQueryParams.parse> =
        res.locals.validated.query;
      const limit = query.limit;
      let cursor: { updatedAt: string; id: string } | null = null;
      if (query.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
          if (
            typeof parsed.id !== "string" ||
            !parsed.id ||
            parsed.id.length > 300 ||
            typeof parsed.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(parsed.updatedAt))
          )
            throw new Error("cursor");
          cursor = parsed;
        } catch {
          throw new WorkflowConflict("Invalid inbox cursor.", 400);
        }
      }
      const rows = await dbAdmin
        .select({ row: workflows })
        .from(workflows)
        .innerJoin(
          jobsTable,
          and(eq(jobsTable.id, workflows.jobId), eq(jobsTable.tenantId, workflows.tenantId)),
        )
        .where(
          and(
            eq(workflows.tenantId, user.tenantId),
            assigned(user),
            cursor
              ? or(
                  lt(workflows.updatedAt, new Date(cursor.updatedAt)),
                  and(
                    eq(workflows.updatedAt, new Date(cursor.updatedAt)),
                    lt(workflows.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(workflows.updatedAt), desc(workflows.id))
        .limit(limit + 1);
      const contexts = new Map<string, Context | null>();
      const items: OfferInboxEntry[] = [];
      for (const { row } of rows.slice(0, limit)) {
        if (!contexts.has(row.jobId)) {
          try {
            contexts.set(row.jobId, await context(user, row.jobId));
          } catch (error) {
            if (!(error instanceof WorkflowConflict) || ![403, 404].includes(error.status))
              throw error;
            contexts.set(row.jobId, null);
          }
        }
        const ctx = contexts.get(row.jobId);
        if (!ctx) continue;
        const item = await entry(row, ctx);
        if (item) items.push(item);
      }
      const last = rows.slice(0, limit).at(-1)?.row;
      res.json({
        items,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ updatedAt: last.updatedAt.toISOString(), id: last.id }),
              ).toString("base64url")
            : null,
      });
    } catch (error) {
      fail(res, error);
    }
  },
);

router.get("/offer-inbox/:workflowId", async (req, res) => {
  try {
    const user = await caller(req);
    const [found] = await dbAdmin
      .select({ row: workflows })
      .from(workflows)
      .innerJoin(
        jobsTable,
        and(eq(jobsTable.id, workflows.jobId), eq(jobsTable.tenantId, workflows.tenantId)),
      )
      .where(
        and(
          eq(workflows.id, String(req.params.workflowId)),
          eq(workflows.tenantId, user.tenantId),
          assigned(user),
        ),
      );
    if (!found) throw new WorkflowConflict("Not found", 404);
    const ctx = await context(user, found.row.jobId);
    const item = await entry(found.row, ctx);
    if (!item) throw new WorkflowConflict("Not found", 404);
    const visible = (handle: Parameters<typeof candidateAllowed>[0], id: string) =>
      candidateAllowed(handle, ctx.gate, id);
    const routing = await readOfferRouting(ctx.gate.scope, found.row.id, visible);
    // Recheck assignment against the freshly read routing; a concurrent reassignment must not reveal terms.
    const config = routing.configuration;
    if (
      !config ||
      ![config.ownerUserId, config.approverUserId, config.senderUserId].includes(user.id)
    )
      throw new WorkflowConflict("Not found", 404);
    const offer =
      config.mode === "native"
        ? await readControlledOffer(ctx.gate.scope, found.row.id, visible)
        : null;
    if (offer && !offer.canEdit && !offer.canApprove && !offer.canSend)
      throw new WorkflowConflict("Not found", 404);
    if (offer && offer.workflowRevision !== routing.workflowRevision)
      throw new WorkflowConflict(
        "Offer changed while loading. Refresh to review its current version.",
        409,
      );
    const result: OfferInboxItem = { entry: item, routing, offer };
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

export default router;
