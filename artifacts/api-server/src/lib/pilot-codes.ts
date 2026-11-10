import crypto from "node:crypto";
import { controlDb, billingSubscriptionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getPlan, type PlanPackage } from "./plans";
import { logger } from "./logger";

let schemaWarningLogged = false;

export class PilotError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function normalizePilotCode(code: string) {
  return code.trim().toUpperCase();
}
export function complimentaryPlan(plan: PlanPackage): PlanPackage {
  return {
    ...plan,
    priceUsdPerMonth: 0,
    pricePerSeatUsdPerMonth: 0,
    perHireFeeUsd: 0,
    expiresAfterDays: 0,
    regionalPricing: undefined,
    stripePriceId: undefined,
    stripeSeatPriceId: undefined,
  };
}
export async function activePilot(tenantId: string) {
  // Account scope includes descendants, but never sibling/unrelated accounts.
  let result;
  try {
    result = await controlDb.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM tenants WHERE id=${tenantId}
      UNION
      SELECT t.id,t.parent_id FROM tenants t JOIN ancestors a ON t.id=a.parent_id
    )
    SELECT g.id,g.tenant_id AS "tenantId",c.code,c.label,
           g.created_at AS "createdAt",g.ended_at AS "endedAt"
    FROM tenant_pilot_grants g JOIN ancestors a ON a.id=g.tenant_id
    JOIN pilot_codes c ON c.id=g.code_id WHERE g.ended_at IS NULL LIMIT 1`);
  } catch (error) {
    if (((error as any)?.cause?.code ?? (error as any)?.code) !== "42P01") throw error;
    // Explicit rollout degradation: an unmigrated environment has no pilot
    // grants and must not break existing commercial subscription checks.
    if (!schemaWarningLogged) {
      logger.warn(
        "Complimentary pilot schema is missing; apply the pilot migration before enabling codes. Commercial billing remains unchanged.",
      );
      schemaWarningLogged = true;
    }
    return null;
  }
  return result.rows[0] ?? null;
}
export async function pilotPlan(tenantId: string, fallback: PlanPackage) {
  return (await activePilot(tenantId)) ? complimentaryPlan(getPlan("enterprise")) : fallback;
}

export async function redeemPilot(codeInput: string, tenantId: string, actorId: string) {
  const code = normalizePilotCode(codeInput);
  return controlDb.transaction(async (tx) => {
    // Serialize coupon capacity before account grants; never count in app memory.
    const c = (await tx.execute(sql`SELECT * FROM pilot_codes WHERE code=${code} FOR UPDATE`))
      .rows[0];
    if (!c) throw new PilotError(400, "This pilot code is unavailable.");
    const tenant = (
      await tx.execute(sql`SELECT id,parent_id,status FROM tenants WHERE id=${tenantId} FOR UPDATE`)
    ).rows[0];
    if (!tenant) throw new PilotError(404, "Account not found.");
    if (tenant.parent_id)
      throw new PilotError(409, "Redeem on the main account; its client accounts are included.");
    const existing = (
      await tx.execute(
        sql`SELECT id,code_id FROM tenant_pilot_grants WHERE tenant_id=${tenantId} AND ended_at IS NULL`,
      )
    ).rows[0];
    if (existing) {
      if (existing.code_id === c.id) return existing.id as string;
      throw new PilotError(409, "This account already has an active pilot.");
    }
    if (c.disabled || Number(c.redemption_count) >= Number(c.max_redemptions)) {
      throw new PilotError(400, "This pilot code is unavailable.");
    }
    if (tenant.status === "suspended")
      throw new PilotError(409, "A suspended account must be reviewed before enabling a pilot.");
    // Lock/snapshot all current client plans. No payment or paid-through date
    // is fabricated; the active grant is the explicit billing exception.
    const descendants = await tx.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM tenants WHERE id=${tenantId}
        UNION SELECT t.id FROM tenants t JOIN tree p ON t.parent_id=p.id
      )
      SELECT t.id,t.plan,t.plan_activated_at FROM tenants t JOIN tree ON tree.id=t.id FOR UPDATE OF t`);
    for (const t of descendants.rows) {
      const recurring = await tx.execute(sql`SELECT id FROM ${billingSubscriptionsTable}
        WHERE ${billingSubscriptionsTable.tenantId}=${t.id}
        AND ${billingSubscriptionsTable.status} IN ('active','trialing','past_due') LIMIT 1`);
      if (recurring.rows.length) {
        throw new PilotError(
          409,
          "An existing recurring payment subscription must be ended with the account team before a no-charge pilot can start.",
        );
      }
    }
    const id = crypto.randomUUID();
    await tx.execute(sql`INSERT INTO tenant_pilot_grants
      (id,tenant_id,code_id,previous_plans,redeemed_by)
      VALUES (${id},${tenantId},${c.id},${JSON.stringify(descendants.rows)}::jsonb,${actorId})`);
    await tx.execute(
      sql`UPDATE pilot_codes SET redemption_count=redemption_count+1 WHERE id=${c.id}`,
    );
    for (const t of descendants.rows) {
      await tx.execute(sql`UPDATE tenants SET plan='enterprise',plan_activated_at=now(),
        billing_notes=concat_ws(E'\\n',billing_notes,${`Complimentary Enterprise pilot started (${id}); all Lexy fees waived until explicitly ended.`}::text)
        WHERE id=${t.id}`);
    }
    return id;
  });
}

export async function endPilot(grantId: string, actorId: string) {
  return controlDb.transaction(async (tx) => {
    const g = (
      await tx.execute(sql`SELECT * FROM tenant_pilot_grants WHERE id=${grantId} FOR UPDATE`)
    ).rows[0];
    if (!g) throw new PilotError(404, "Pilot not found.");
    if (g.ended_at) return;
    const root = (await tx.execute(sql`SELECT id FROM tenants WHERE id=${g.tenant_id} FOR UPDATE`))
      .rows[0];
    if (!root) throw new PilotError(404, "Account not found.");
    const previous = g.previous_plans as Array<{
      id: string;
      plan: string;
      plan_activated_at: string | null;
    }>;
    const originalRoot = previous.find((t) => t.id === g.tenant_id)!;
    const current = await tx.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM tenants WHERE id=${g.tenant_id}
        UNION SELECT t.id FROM tenants t JOIN tree p ON t.parent_id=p.id
      ) SELECT id FROM tree`);
    for (const t of current.rows) {
      const old = previous.find((p) => p.id === t.id) ?? originalRoot;
      await tx.execute(sql`UPDATE tenants SET plan=${old.plan}::tenant_plan,
        plan_activated_at=${old.plan_activated_at}::timestamptz,
        billing_notes=concat_ws(E'\\n',billing_notes,${`Complimentary pilot ended (${grantId}); original plan and billing terms restored. No automatic charge was initiated.`}::text)
        WHERE id=${t.id}`);
    }
    await tx.execute(
      sql`UPDATE tenant_pilot_grants SET ended_at=now(),ended_by=${actorId} WHERE id=${grantId}`,
    );
  });
}
