/**
 * routes/fee-ledger.ts — Per-hire fee ledger (staff review + external invoicing)
 *
 * The platform NEVER charges anyone. Line items are created automatically on
 * offer-acceptance for fee-eligible hires (see lib/fee-ledger.ts) and flow
 * through a manual staff review before being exported as CSV for EXTERNAL
 * invoicing. Payments are recorded back by hand.
 *
 * ── Route map ────────────────────────────────────────────────────────────────
 *   STAFF (platform_admin ONLY — fees are L3XY revenue, not tenant data):
 *     GET  /fee-ledger                      review queue (filter by ?status=)
 *     PUT  /fee-ledger/:id/status           approve / waive / invoiced / paid
 *     GET  /fee-ledger/export.csv           CSV of approved items for invoicing
 *     POST /fee-ledger/corrections          staff origin correction (audited)
 *   TENANT (tenant_admin / recruiter_admin — own subtree only):
 *     GET  /fee-ledger/mine                 tenant's own fee line items
 *     POST /fee-ledger/:id/dispute          "Dispute this fee" (pending/approved → disputed)
 *
 * ── Authorization notes ─────────────────────────────────────────────────────
 *   • Staff routes: explicit platform_admin allowlist (memory:
 *     staff-only-route-role-gate — tenant scoping alone is NOT a staff gate).
 *   • Tenant routes: explicit tenant predicate via getDataScopeTenantIds
 *     (fee_line_items is Class-B — app code is the tenant seal).
 *   • Status transitions are guarded INSIDE the UPDATE predicate (TOCTOU).
 *   • Origin corrections run in a transaction that sets the transaction-local
 *     GUC app.allow_origin_correction='on' (the immutability trigger's only
 *     escape hatch) and ALWAYS write an origin_corrections audit row.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import {
  feeLineItemsTable,
  originCorrectionsTable,
  applicationsTable,
  candidatesTable,
  jobsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { validate } from "../middlewares/validate";
import { createFeeLineItemIfEligible, isFeeEligible } from "../lib/fee-ledger";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/* ── Caller resolution ────────────────────────────────────────────────────── */
async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

function isPlatformAdmin(user: any): boolean {
  return user?.role === "platform_admin";
}

/* Tenant-side roles allowed to see / dispute their own fees. */
const TENANT_FEE_ROLES = new Set(["platform_admin", "tenant_admin", "recruiter_admin"]);

/* ── Shared enrichment: names for candidate / job / tenant ────────────────── */
async function enrich(items: Array<typeof feeLineItemsTable.$inferSelect>) {
  if (items.length === 0) return [];
  const candidateIds = [...new Set(items.map((i) => i.candidateId))];
  const jobIds = [...new Set(items.map((i) => i.jobId))];
  const tenantIds = [...new Set(items.map((i) => i.tenantId))];
  const [cands, jobs, tenants] = await Promise.all([
    db
      .select({
        id: candidatesTable.id,
        firstName: candidatesTable.firstName,
        lastName: candidatesTable.lastName,
      })
      .from(candidatesTable)
      .where(inArray(candidatesTable.id, candidateIds)),
    db
      .select({ id: jobsTable.id, title: jobsTable.title })
      .from(jobsTable)
      .where(inArray(jobsTable.id, jobIds)),
    db
      .select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds)),
  ]);
  const cMap = new Map(cands.map((c) => [c.id, `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()]));
  const jMap = new Map(jobs.map((j) => [j.id, j.title]));
  const tMap = new Map(tenants.map((t) => [t.id, t.name]));
  return items.map((i) => ({
    ...i,
    candidateName: cMap.get(i.candidateId) ?? "Unknown",
    jobTitle: jMap.get(i.jobId) ?? "Unknown",
    tenantName: tMap.get(i.tenantId) ?? i.tenantId,
  }));
}

const STATUSES = [
  "pending_review",
  "approved",
  "waived",
  "disputed",
  "invoiced_externally",
  "paid",
] as const;

/* ═══ STAFF ROUTES (platform_admin only) ══════════════════════════════════ */

/* ── GET /fee-ledger ──────────────────────────────────────────────────────── */
router.get("/fee-ledger", async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isPlatformAdmin(user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const status = typeof req.query.status === "string" ? req.query.status : null;
    const conds =
      status && (STATUSES as readonly string[]).includes(status)
        ? [eq(feeLineItemsTable.status, status as any)]
        : [];

    const items = await db
      .select()
      .from(feeLineItemsTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(feeLineItemsTable.createdAt))
      .limit(500);

    res.json({ items: await enrich(items) });
  } catch (err) {
    logger.error({ err }, "Failed to list fee ledger");
    res.status(500).json({ error: "Failed to list fee ledger" });
  }
});

/* ── PUT /fee-ledger/:id/status ───────────────────────────────────────────── */
const StatusBody = z.object({
  status: z.enum(["approved", "waived", "invoiced_externally", "paid"]),
  reason: z.string().max(2000).optional(),
  externalInvoiceRef: z.string().max(200).optional(),
});

/* Allowed transitions (staff). disputed items must be resolved explicitly —
 * approve (fee stands) or waive (fee dropped). */
const ALLOWED_FROM: Record<string, string[]> = {
  approved: ["pending_review", "disputed"],
  waived: ["pending_review", "approved", "disputed"],
  invoiced_externally: ["approved"],
  paid: ["invoiced_externally"],
};

router.put("/fee-ledger/:id/status", validate({ body: StatusBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isPlatformAdmin(user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { status, reason, externalInvoiceRef } = req.body;
    const from = ALLOWED_FROM[status];

    /* Transition guard INSIDE the UPDATE predicate — no read-then-write race. */
    const [updated] = await db
      .update(feeLineItemsTable)
      .set({
        status,
        reviewedBy: user.id,
        reviewedAt: new Date(),
        reviewReason: reason ?? null,
        ...(status === "invoiced_externally"
          ? { externalInvoiceRef: externalInvoiceRef ?? null, externalInvoiceDate: new Date() }
          : {}),
        ...(status === "paid" ? { paidAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(feeLineItemsTable.id, req.params.id),
          inArray(feeLineItemsTable.status, from as any),
        ),
      )
      .returning();

    if (!updated) {
      res.status(409).json({ error: `Item not found or not in a valid state for '${status}'` });
      return;
    }
    logger.info({ feeLineItemId: updated.id, status, by: user.id }, "Fee line item status changed");
    res.json({ ok: true, item: updated });
  } catch (err) {
    logger.error({ err }, "Failed to update fee line item");
    res.status(500).json({ error: "Failed to update fee line item" });
  }
});

/* ── GET /fee-ledger/export.csv ───────────────────────────────────────────── */
function csvEscape(v: unknown): string {
  let s = v == null ? "" : String(v);
  /* Neutralize spreadsheet formula injection: Excel/Sheets execute cells
     starting with = + - @ (or tab/CR). Prefix with ' so they render as text. */
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/fee-ledger/export.csv", async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isPlatformAdmin(user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const status =
      typeof req.query.status === "string" &&
      (STATUSES as readonly string[]).includes(req.query.status)
        ? req.query.status
        : "approved";

    const items = await enrich(
      await db
        .select()
        .from(feeLineItemsTable)
        .where(eq(feeLineItemsTable.status, status as any))
        .orderBy(desc(feeLineItemsTable.createdAt))
        .limit(5000),
    );

    const header = [
      "line_item_id",
      "status",
      "client",
      "candidate",
      "job_title",
      "origin_channel",
      "amount",
      "currency",
      "plan_code",
      "hire_accepted_at",
      "external_invoice_ref",
    ];
    const rows = items.map((i) =>
      [
        i.id,
        i.status,
        i.tenantName,
        i.candidateName,
        i.jobTitle,
        i.originChannel,
        i.amount,
        i.currency,
        i.planCode ?? "",
        i.createdAt?.toISOString?.() ?? "",
        i.externalInvoiceRef ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="fee-ledger-${status}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send([header.join(","), ...rows].join("\n"));
  } catch (err) {
    logger.error({ err }, "Failed to export fee ledger CSV");
    res.status(500).json({ error: "Failed to export fee ledger" });
  }
});

/* ── POST /fee-ledger/corrections — staff origin correction (audited) ─────── */
const CorrectionBody = z.object({
  applicationId: z.string().min(1),
  entryType: z.enum(["sourced", "applied", "manual"]).optional(),
  originEvidence: z.record(z.string(), z.unknown()).nullable().optional(),
  reason: z.string().min(5).max(2000),
});

router.post("/fee-ledger/corrections", validate({ body: CorrectionBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isPlatformAdmin(user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { applicationId, entryType, originEvidence, reason } = req.body;
    if (entryType === undefined && originEvidence === undefined) {
      res
        .status(400)
        .json({ error: "Nothing to correct — provide entryType and/or originEvidence" });
      return;
    }

    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applicationId))
      .limit(1);
    if (!app) {
      res.status(404).json({ error: "Application not found" });
      return;
    }

    const oldValue = {
      entryType: app.entryType,
      originEvidence: (app as any).originEvidence ?? null,
    };
    const newValue = {
      entryType: entryType ?? app.entryType,
      originEvidence:
        originEvidence === undefined ? ((app as any).originEvidence ?? null) : originEvidence,
    };

    /* LOCKED RULE: pre-launch rows (sourced with NULL evidence — origin
       attribution didn't exist yet) can NEVER be made fee-eligible, not even
       by staff correction. Every post-launch insert site stamps evidence, so
       NULL evidence is the definitive pre-launch marker. Corrections that
       REMOVE eligibility remain allowed. */
    const wasPreLaunch = oldValue.entryType === "sourced" && oldValue.originEvidence == null;
    if (wasPreLaunch && isFeeEligible(newValue.entryType, newValue.originEvidence)) {
      res.status(422).json({
        error:
          "Pre-launch entries (no origin evidence) can never be made fee-eligible. " +
          "Retroactive billing is not permitted.",
      });
      return;
    }

    /* Transaction: escape hatch GUC is transaction-local, so the immutability
       trigger re-arms the moment this commits. Audit row is in the same txn —
       a correction can never land without its audit trail. */
    const updatedApp = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_origin_correction', 'on', true)`);
      const [u] = await tx
        .update(applicationsTable)
        .set({
          entryType: newValue.entryType as any,
          originEvidence: newValue.originEvidence as any,
          originSetAt: new Date(),
          originSetBy: user.id,
        })
        .where(eq(applicationsTable.id, applicationId))
        .returning();
      await tx.insert(originCorrectionsTable).values({
        tenantId: app.tenantId ?? "",
        applicationId,
        oldValue,
        newValue,
        changedBy: user.id,
        reason,
      });
      return u;
    });

    /* Reconcile the fee ledger with the corrected origin:
       — no longer eligible → waive any un-invoiced line item (never delete);
       — newly eligible + offer already accepted/hired → create the line item. */
    const stillEligible = isFeeEligible(updatedApp.entryType, newValue.originEvidence);

    let ledgerAction: string | null = null;
    if (!stillEligible) {
      const [waived] = await db
        .update(feeLineItemsTable)
        .set({
          status: "waived",
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewReason: `Origin corrected: ${reason}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(feeLineItemsTable.applicationId, applicationId),
            inArray(feeLineItemsTable.status, ["pending_review", "approved", "disputed"] as any),
          ),
        )
        .returning({ id: feeLineItemsTable.id });
      if (waived) ledgerAction = "waived";
    } else if (["offer_accepted", "hired", "started"].includes(updatedApp.stage)) {
      /* A previously-waived item blocks re-creation (unique on application_id)
         — re-open it to pending_review instead so the ledger reflects the
         corrected eligible origin. Invoiced/paid items are left untouched. */
      const [reopened] = await db
        .update(feeLineItemsTable)
        .set({
          status: "pending_review",
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewReason: `Origin corrected (re-opened): ${reason}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(feeLineItemsTable.applicationId, applicationId),
            eq(feeLineItemsTable.status, "waived" as any),
          ),
        )
        .returning({ id: feeLineItemsTable.id });
      if (reopened) {
        ledgerAction = "reopened";
      } else {
        const created = await createFeeLineItemIfEligible({
          id: updatedApp.id,
          tenantId: updatedApp.tenantId,
          candidateId: updatedApp.candidateId,
          jobId: updatedApp.jobId,
          entryType: updatedApp.entryType,
          originEvidence: (updatedApp as any).originEvidence,
        });
        if (created) ledgerAction = "created";
      }
    }

    logger.info({ applicationId, by: user.id, ledgerAction }, "Sourcing origin corrected");
    res.json({ ok: true, application: updatedApp, ledgerAction });
  } catch (err) {
    logger.error({ err }, "Failed to correct sourcing origin");
    res.status(500).json({ error: "Failed to correct sourcing origin" });
  }
});

/* ═══ TENANT ROUTES ═══════════════════════════════════════════════════════ */

/* ── GET /fee-ledger/mine ─────────────────────────────────────────────────── */
router.get("/fee-ledger/mine", async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!TENANT_FEE_ROLES.has(user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    /* Class-B explicit tenant predicate: caller's subtree only. */
    const allowed = await getDataScopeTenantIds(user);
    const conds = allowed
      ? [inArray(feeLineItemsTable.tenantId, allowed.length ? allowed : ["__none__"])]
      : [];

    const items = await db
      .select()
      .from(feeLineItemsTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(feeLineItemsTable.createdAt))
      .limit(500);

    res.json({ items: await enrich(items) });
  } catch (err) {
    logger.error({ err }, "Failed to list tenant fee items");
    res.status(500).json({ error: "Failed to list fee items" });
  }
});

/* ── POST /fee-ledger/:id/dispute ─────────────────────────────────────────── */
const DisputeBody = z.object({
  reason: z.string().min(5).max(2000),
});

router.post("/fee-ledger/:id/dispute", validate({ body: DisputeBody }), async (req, res) => {
  try {
    const user = await getCallerUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!TENANT_FEE_ROLES.has(user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    /* Tenant + status guards INSIDE the UPDATE predicate. Only un-invoiced
       items are disputable — after external invoicing it's a support matter. */
    const allowed = await getDataScopeTenantIds(user);
    const [updated] = await db
      .update(feeLineItemsTable)
      .set({
        status: "disputed",
        disputedBy: user.id,
        disputedAt: new Date(),
        disputeReason: req.body.reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(feeLineItemsTable.id, req.params.id),
          inArray(feeLineItemsTable.status, ["pending_review", "approved"] as any),
          ...(allowed
            ? [inArray(feeLineItemsTable.tenantId, allowed.length ? allowed : ["__none__"])]
            : []),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Fee item not found or no longer disputable" });
      return;
    }
    logger.info({ feeLineItemId: updated.id, by: user.id }, "Fee line item disputed by tenant");
    res.json({ ok: true, item: updated });
  } catch (err) {
    logger.error({ err }, "Failed to dispute fee item");
    res.status(500).json({ error: "Failed to dispute fee item" });
  }
});

export default router;
