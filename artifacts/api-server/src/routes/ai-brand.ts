/**
 * routes/ai-brand.ts — Tenant Brand Profile CRUD (T003)
 *
 * GET/PUT /tenants/:tenantId/ai-brand-profile — 1:1 upsert of a tenant's brand
 * voice that AI message generation draws from. Includes the `aiMessagingEnabled`
 * kill switch. Restricted to platform_admin / tenant_admin, and every access is
 * tenant-scoped via getAllowedTenantIds (a tenant_admin can only touch their own
 * tenant + descendants).
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tenantAiBrandProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getAllowedTenantIds } from "../lib/tenantUtils";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

const aiToneValues = ["formal", "warm", "direct", "premium", "technical", "conversational"] as const;

const BrandProfileBody = z.object({
  companyName: z.string().max(200).nullish(),
  website: z.string().max(500).nullish(),
  industry: z.string().max(200).nullish(),
  companyOverview: z.string().max(8000).nullish(),
  employerBrandStatement: z.string().max(8000).nullish(),
  mission: z.string().max(8000).nullish(),
  values: z.string().max(8000).nullish(),
  cultureNotes: z.string().max(8000).nullish(),
  deiStatement: z.string().max(8000).nullish(),
  candidateValueProp: z.string().max(8000).nullish(),
  toneOfVoice: z.enum(aiToneValues).nullish(),
  wordsToUse: z.string().max(4000).nullish(),
  wordsToAvoid: z.string().max(4000).nullish(),
  approvedBoilerplate: z.string().max(8000).nullish(),
  benefitsSummary: z.string().max(8000).nullish(),
  careersUrl: z.string().max(500).nullish(),
  brandGuideUrl: z.string().max(500).nullish(),
  aiMessagingEnabled: z.boolean().optional(),
});

async function canAccessTenant(
  user: { role: string; tenantId: string | null },
  tenantId: string,
): Promise<boolean> {
  const allowed = await getAllowedTenantIds(user);
  return allowed === null || allowed.includes(tenantId);
}

// ── GET — read a tenant's brand profile (null when none has been saved yet) ───
router.get(
  "/tenants/:tenantId/ai-brand-profile",
  resolveUser,
  requireRole("platform_admin", "tenant_admin"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const { tenantId } = req.params;
    if (!(await canAccessTenant(user, tenantId))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const [profile] = await db
      .select()
      .from(tenantAiBrandProfilesTable)
      .where(eq(tenantAiBrandProfilesTable.tenantId, tenantId))
      .limit(1);
    return res.json({ profile: profile ?? null });
  },
);

// ── PUT — upsert (1:1 on tenantId) the brand profile, audited on every save ───
router.put(
  "/tenants/:tenantId/ai-brand-profile",
  resolveUser,
  requireRole("platform_admin", "tenant_admin"),
  validate({ body: BrandProfileBody }),
  async (req, res) => {
    const user = req.resolvedUser!;
    const { tenantId } = req.params;
    if (!(await canAccessTenant(user, tenantId))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const body = req.body as z.infer<typeof BrandProfileBody>;
    // Drop undefined keys so they don't clobber existing values on update or
    // override column defaults on insert.
    const patch = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const now = new Date();
    const [saved] = await db
      .insert(tenantAiBrandProfilesTable)
      .values({ ...patch, tenantId, updatedById: user.id, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantAiBrandProfilesTable.tenantId,
        set: { ...patch, updatedById: user.id, updatedAt: now },
      })
      .returning();
    await recordAudit({
      tenantId,
      actorType: "user",
      actorId: user.id,
      channel: "system",
      direction: "internal",
      action: "ai_brand_profile.upsert",
      title: "AI brand profile saved",
      metadata: { aiMessagingEnabled: saved?.aiMessagingEnabled },
    });
    return res.json({ profile: saved });
  },
);

export default router;
