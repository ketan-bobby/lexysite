/**
 * routes/market-intelligence.ts — Market Intelligence Q&A (Step 1: data tools).
 *
 * Read-only endpoints exposing the four function-calling data tools in
 * lib/market-intelligence.ts. NO AI layer yet — these return raw, honest
 * tool results ({ status: "ok" | "no_data", asOf, … }) so the frontend page
 * (and later the reasoning layer) consume the exact same contract.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET /market-intelligence/hiring-velocity   ?role&skills&location
 *   GET /market-intelligence/candidate-supply  ?role&skills&location
 *   GET /market-intelligence/comp-signal       ?role&skills&location
 *   GET /market-intelligence/internal-bench    ?role&skills
 *
 * ─── Scoping ─────────────────────────────────────────────────────────────────
 * Staff-only (explicit STAFF_ROLES allowlist — getAllowedTenantIds is NOT a
 * staff gate). Tenant scope comes from getDataScopeTenantIds(user) and is
 * passed as an explicit predicate to every tool (several source tables are
 * non-RLS, so the tools must self-scope — fail-closed on []).
 * getCompSignal is intentionally cross-tenant AGGREGATE-ONLY (k≥5 anonymized
 * statistics, never rows) — same doctrine as the learned-scoring global prior.
 */
import { Router } from "express";
import { z } from "zod";
import { controlDb, dbAdmin, usersTable, marketIntelAskEventsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { resolveUser } from "../middlewares/resolveUser";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import {
  getHiringVelocity,
  getCandidateSupply,
  getCompSignal,
  getInternalBench,
} from "../lib/market-intelligence";
import { askMarketIntelligence } from "../lib/market-intelligence-ask";

const router = Router();

const STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];

const QuerySchema = z.object({
  role: z.string().trim().min(2, "role is required"),
  skills: z.string().optional(),   // comma-separated
  location: z.string().optional(),
});

/** Resolve + staff-gate the caller; writes the 401/403 itself on failure. */
async function requireStaff(req: any, res: any) {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!STAFF_ROLES.includes(user.role)) { res.status(403).json({ error: "Forbidden" }); return null; }
  return user;
}

function parseQuery(req: any, res: any) {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    return null;
  }
  const { role, skills, location } = parsed.data;
  return {
    role,
    skills: (skills ?? "").split(",").map(s => s.trim()).filter(Boolean),
    location: location?.trim() || undefined,
  };
}

router.get("/market-intelligence/hiring-velocity", resolveUser, async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  const q = parseQuery(req, res);
  if (!q) return;
  try {
    const tenantScope = await getDataScopeTenantIds(user);
    res.json(await getHiringVelocity({ ...q, tenantScope }));
  } catch (err) {
    logger.error({ err }, "market-intel hiring-velocity failed");
    res.status(500).json({ error: "tool failed" });
  }
});

router.get("/market-intelligence/candidate-supply", resolveUser, async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  const q = parseQuery(req, res);
  if (!q) return;
  try {
    const tenantScope = await getDataScopeTenantIds(user);
    res.json(await getCandidateSupply({ ...q, tenantScope }));
  } catch (err) {
    logger.error({ err }, "market-intel candidate-supply failed");
    res.status(500).json({ error: "tool failed" });
  }
});

router.get("/market-intelligence/comp-signal", resolveUser, async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  const q = parseQuery(req, res);
  if (!q) return;
  try {
    /* Aggregate-only cross-tenant read by design (k-anonymity enforced inside
     * the tool — below MIN_COMP_SAMPLE it returns "insufficient data"). */
    res.json(await getCompSignal(q));
  } catch (err) {
    logger.error({ err }, "market-intel comp-signal failed");
    res.status(500).json({ error: "tool failed" });
  }
});

router.get("/market-intelligence/internal-bench", resolveUser, async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  const q = parseQuery(req, res);
  if (!q) return;
  try {
    const scope = await getDataScopeTenantIds(user);
    /* platform_admin (scope=null) has no "own pool" — use nothing rather than
     * everything; the tool then reports no tenant scope honestly. */
    res.json(await getInternalBench({ role: q.role, skills: q.skills, tenantIds: scope ?? [] }));
  } catch (err) {
    logger.error({ err }, "market-intel internal-bench failed");
    res.status(500).json({ error: "tool failed" });
  }
});

/* ─── Step 2: reasoning layer (function-calling Q&A) ───────────────────────
 * POST /market-intelligence/ask { question }
 * The model can ONLY use the four tools above; tenant scope is bound
 * server-side into the executor (the model never supplies tenant ids), and
 * a zero-data question deterministically yields an "insufficient data"
 * answer — see lib/market-intelligence-ask.ts for the hard guarantees. */
const AskSchema = z.object({
  question: z.string().trim().min(5, "question is required").max(2000),
});

router.post("/market-intelligence/ask", resolveUser, async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  const parsed = AskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    return;
  }
  try {
    const tenantScope = await getDataScopeTenantIds(user);
    const startedAt = Date.now();
    const result = await askMarketIntelligence({ question: parsed.data.question, tenantScope });
    const latencyMs = Date.now() - startedAt;
    // The executions audit trail is for the persisted log, not the client.
    const { executions, ...clientResult } = result;
    res.json(clientResult);

    // Grounding audit log — fire-and-forget (never slows/breaks the answer).
    // One durable row per ask: question + answer + EVERY attempted tool call,
    // so a human can spot-check groundedness during rollout.
    logger.info(
      { evt: "market_intel_ask", userId: user.id, toolsCalled: result.coverage.toolsCalled, okCount: result.coverage.okCount, sufficient: result.coverage.sufficient, latencyMs },
      "[market-intel] ask answered",
    );
    void dbAdmin
      .insert(marketIntelAskEventsTable)
      .values({
        userId: user.id,
        tenantId: user.tenantId ?? null,
        question: parsed.data.question,
        answer: result.answer,
        confidence: result.confidence,
        sources: executions,
        coverage: result.coverage,
        insufficient: !result.coverage.sufficient,
        latencyMs,
      })
      .catch((err: any) => logger.error({ err: err?.message }, "[market-intel] ask audit log insert failed"));
  } catch (err: any) {
    logger.error({ err: err?.message }, "market-intel ask failed");
    res.status(500).json({ error: "market intelligence Q&A failed" });
  }
});

/* ─── Rollout spot-check surface ────────────────────────────────────────────
 * GET /market-intelligence/ask-log?limit=10 — the persisted question/answer/
 * tool-call triples for manual groundedness review. platform_admin ONLY:
 * questions are free text and may mention candidate names, and rows span
 * tenants (Class B table — no RLS; this explicit role gate is the seal). */
router.get("/market-intelligence/ask-log", resolveUser, async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  if (user.role !== "platform_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
  try {
    const rows = await dbAdmin
      .select()
      .from(marketIntelAskEventsTable)
      .orderBy(desc(marketIntelAskEventsTable.createdAt))
      .limit(limit);
    res.json({ events: rows });
  } catch (err: any) {
    logger.error({ err: err?.message }, "market-intel ask-log read failed");
    res.status(500).json({ error: "failed to read ask log" });
  }
});

export default router;
