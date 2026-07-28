/**
 * routes/index.ts — Central API Router
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Aggregates all sub-routers and mounts them under the single Express router
 * that app.ts registers at /api. Every new route file must be imported and
 * mounted here to be reachable.
 *
 * ─── Mount order notes ───────────────────────────────────────────────────────
 * • publicRouter is mounted at /public so its routes become /api/public/*.
 *   This namespace is deliberately separate from the authenticated routes and
 *   requires no Bearer token.
 * • All other routers are mounted at "/" — their individual routes carry their
 *   own prefix (e.g. "/jobs", "/candidates") and Express matches by specificity.
 * • The three additive modules (connection-engine, candidate-connection-engine,
 *   candidate-import) are labelled in comments to clarify they don't touch any
 *   existing routes — they only add new endpoints.
 *
 * ─── Adding a new route file ─────────────────────────────────────────────────
 *   1. Create artifacts/api-server/src/routes/<name>.ts
 *   2. Export a default express Router
 *   3. Import it here and call router.use(newRouter) or router.use("/prefix", newRouter)
 */
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import authRouter from "./auth";
import authMicrosoftRouter from "./auth-microsoft";
import authMicrosoftGraphRouter from "./auth-microsoft-graph";
import tenantsRouter from "./tenants";
import subscriptionPricesRouter from "./subscription-prices";
import usersRouter from "./users";
import jobsRouter from "./jobs";
import icpRouter from "./icp";
import candidatesRouter from "./candidates";
import applicationsRouter from "./applications";
import interviewsRouter from "./interviews";
import prepRouter from "./prep";
import outreachRouter from "./outreach";
import communicationRouter from "./communication";
import verifyRouter from "./verify";
import talentMatchRouter from "./talent_match";
import sourcingRouter from "./sourcing";
import analyticsRouter from "./analytics";
import recruiterPerformanceRouter from "./recruiter-performance";
import agentsRouter from "./agents";
import intelligenceRouter from "./intelligence";
import pipelineRouter from "./pipeline";
import publicRouter from "./public";
import learningRouter from "./learning";
import evaluationsRouter from "./evaluations";
import marketIntelligenceRouter from "./market-intelligence";
import invitesRouter from "./invites";
import careerProfileRouter from "./career-profile";
import antiGhostRouter from "./anti-ghost";
import dncRouter from "./dnc";
import guideRouter from "./guide";
import newsletterRouter from "./newsletter";
import staffInvitesRouter from "./staff-invites";
import notificationsRouter from "./notifications";
import webhooksRouter from "./webhooks";
import auditRouter from "./audit";
import digestsRouter from "./digests";
import conversationDraftsRouter from "./conversation-drafts";
import outreachReplyRouter from "./outreach-reply";
// ── Connection Engine — employer side (additive module) ───────────────────────
import connectionEngineRouter from "./connection-engine";
// ── Candidate Connection Engine — candidate side (additive module) ────────────
import candidateConnectionEngineRouter from "./candidate-connection-engine";
// ── Resume Import — additive, does not touch existing candidate flows ─────────
import candidateImportRouter from "./candidate-import";
// ── JD upload parser — extracts text from PDF/DOCX so ICP gets real content ──
import jdParseRouter from "./jd-parse";
// ── Subscription packages — public catalog + demo provisioning ────────────────
import plansRouter from "./plans";
// ── Credits ledger — metered usage tracking + reporting ──────────────────────
import creditsRouter from "./credits";
// ── Stripe billing scaffolding (checkout, portal, webhook) ───────────────────
import billingRouter from "./billing";
// ── Partner program (rev-share affiliates + payouts) ─────────────────────────
import partnersRouter from "./partners";
// ── System errors (platform-admin diagnostic dashboard) ──────────────────────
import systemErrorsRouter from "./system-errors";
import clientErrorsRouter from "./client-errors";
// ── Recruiter Help Bot (guide-grounded Q&A + support escalation) ─────────────
import helpRouter from "./help";
// ── Right-to-erasure admin fulfilment (IL AIVI / GDPR Art 17 / CCPA) ────────
import adminDeletionRouter from "./admin-deletion";

const router: IRouter = Router();

router.use("/public", publicRouter);
router.use(healthRouter);
router.use(storageRouter);
router.use(authRouter);
router.use(authMicrosoftRouter);
router.use(authMicrosoftGraphRouter);
router.use(tenantsRouter);
router.use(subscriptionPricesRouter);
router.use(plansRouter);
router.use(creditsRouter);
router.use(billingRouter);
router.use(partnersRouter);
router.use(systemErrorsRouter);
router.use(clientErrorsRouter);
router.use(helpRouter);
router.use(usersRouter);
router.use(jobsRouter);
router.use(icpRouter);
router.use(candidatesRouter);
router.use(applicationsRouter);
router.use(interviewsRouter);
router.use(prepRouter);
router.use(outreachRouter);
router.use(communicationRouter);
router.use(verifyRouter);
router.use(talentMatchRouter);
router.use(sourcingRouter);
router.use(analyticsRouter);
router.use(recruiterPerformanceRouter);
router.use(agentsRouter);
router.use(pipelineRouter);
router.use("/intelligence", intelligenceRouter);
router.use("/learning", learningRouter);
router.use("/evaluations", evaluationsRouter);
router.use(marketIntelligenceRouter);
router.use(invitesRouter);
router.use(careerProfileRouter);
router.use(antiGhostRouter);
router.use(dncRouter);
router.use(guideRouter);
router.use(newsletterRouter);
router.use(staffInvitesRouter);
router.use(notificationsRouter);
router.use(webhooksRouter);
router.use(auditRouter);
router.use(digestsRouter);
router.use(conversationDraftsRouter);
router.use(outreachReplyRouter);
// ── Connection Engine (employer side) ────────────────────────────────────────
router.use(connectionEngineRouter);
// ── Candidate Connection Engine (candidate side) ──────────────────────────────
router.use(candidateConnectionEngineRouter);
// ── Resume Import (additive — .NET API integration) ───────────────────────────
router.use(candidateImportRouter);
router.use(jdParseRouter);
router.use(adminDeletionRouter);
// ── AI Governance Layer (decision split, jurisdiction policy, appeals) ────────
import governanceRouter from "./governance";
router.use(governanceRouter);

// ── Candidate-facing AI disclosures (T011) ───────────────────────────────────
import disclosuresRouter from "./disclosures";
router.use(disclosuresRouter);

// ── Admin impersonation (T011 — SOC2 CC6.6 audit) ────────────────────────────
import impersonationRouter from "./impersonation";
router.use(impersonationRouter);

// ── Brand & Workorder AI Intelligence (tenant brand voice + per-role context) ─
import aiBrandRouter from "./ai-brand";
import aiWorkorderRouter from "./ai-workorder";
import aiMessagesRouter from "./ai-messages";
import aiDocumentsRouter from "./ai-documents";
router.use(aiBrandRouter);
router.use(aiWorkorderRouter);
router.use(aiMessagesRouter);
router.use(aiDocumentsRouter);

// ── Outcome Tracking Phase 1 — offer funnel + candidate events ───────────────
import outcomesRouter from "./outcomes";
router.use(outcomesRouter);

// ── Per-hire fee ledger — staff review + external invoicing ──────────────────
import feeLedgerRouter from "./fee-ledger";
router.use(feeLedgerRouter);

// ── Candidate Event Full Logging ──────────────────────────────────────────────
import candidateEventsRouter from "./candidate-events";
router.use(candidateEventsRouter);

// ── AI job queue admin dashboard (post-interview async processing) ────────────
import aiJobsRouter from "./ai-jobs";
router.use(aiJobsRouter);

// ── Recruiter intro avatar (HeyGen) — Phase 1 backend ─────────────────────────
import recruiterAvatarRouter from "./recruiter-avatar";
router.use(recruiterAvatarRouter);

// ── Recruiter Admin ↔ Client (sub-tenant) management (Task #43) ──────────────
import recruiterAdminsRouter from "./recruiter-admins";
router.use(recruiterAdminsRouter);

// ── Hiring-Manager Share Packages (no-login branded candidate review) ────────
import hmShareRouter, { hmSharePublicRouter } from "./hm-share";
router.use(hmShareRouter);
router.use("/public/hm-share", hmSharePublicRouter);

// ── Agent Run event model (sourcing runs + live event stream, audit log) ──────
import agentRunsRouter from "./agent-runs";
router.use(agentRunsRouter);

// ── LINX engagement requests (cross-tenant handoff, client entry points) ──────
import linxRequestsRouter from "./linx-requests";
router.use(linxRequestsRouter);

export default router;
