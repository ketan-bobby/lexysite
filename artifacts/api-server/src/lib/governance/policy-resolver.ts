/**
 * governance/policy-resolver.ts — Active Policy Lookup
 *
 * Resolves the currently-active jurisdiction policy rules for a given
 * set of jurisdiction codes (and optionally a tenant id for
 * tenant_extension rules). Returns the merged policy plus the list of
 * policy_version_ids that contributed to the merge so every gated
 * decision can record exactly which policy versions were in effect.
 *
 * Active = effective_from <= now() AND (effective_to IS NULL OR
 *          effective_to > now()).
 *
 * Merge rule: more-protective wins.
 *   - gate_rejects = OR across all rules (any rule that gates wins)
 *   - require_disclosure / require_appeal / require_audit = OR
 *
 * Disclosure template lookup is a separate function because templates
 * are keyed differently (jurisdiction + language + template_key).
 */
import { db } from "@workspace/db";
import {
  jurisdictionAiPolicyRulesTable,
  jurisdictionDisclosureTemplatesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, lte, or, gt } from "drizzle-orm";
import type { JurisdictionCode } from "./jurisdictions.js";

export interface ResolvedPolicy {
  jurisdictions: JurisdictionCode[];
  gateRejects: boolean;
  gateLapsed: boolean;
  gateHolds: boolean;
  requireDisclosure: boolean;
  requireAppeal: boolean;
  requireAudit: boolean;
  /** Policy rule rows that contributed to this resolution. The first
   *  id is the "primary" version for the audit log; the full list is
   *  also stored in the decision_events payload for forensics. */
  policyVersionIds: string[];
  contributingBasis: string[];
}

/**
 * Resolve the active platform-floor + tenant-extension rules for the
 * given jurisdictions. Empty input → permissive policy (nothing gated).
 */
export async function resolveActivePolicy(
  jurisdictions: JurisdictionCode[],
  tenantId: string | null,
  asOf: Date = new Date(),
): Promise<ResolvedPolicy> {
  if (jurisdictions.length === 0) {
    return {
      jurisdictions: [],
      gateRejects: false,
      gateLapsed: false,
      gateHolds: false,
      requireDisclosure: false,
      requireAppeal: false,
      requireAudit: false,
      policyVersionIds: [],
      contributingBasis: [],
    };
  }

  /* Pull platform_floor for all jurisdictions + tenant_extension for
   * this tenant (if any). The DB query is intentionally over-fetched
   * (active rules only) so we can apply the OR-merge in memory and
   * keep the SQL simple. */
  const conds = [
    and(
      lte(jurisdictionAiPolicyRulesTable.effectiveFrom, asOf),
      or(
        isNull(jurisdictionAiPolicyRulesTable.effectiveTo),
        gt(jurisdictionAiPolicyRulesTable.effectiveTo, asOf),
      ),
      inArray(jurisdictionAiPolicyRulesTable.jurisdictionCode, jurisdictions),
    ),
  ];

  const rows = await db
    .select()
    .from(jurisdictionAiPolicyRulesTable)
    .where(and(...conds));

  /* In-memory filter: keep platform_floor rows OR tenant_extension
   * rows belonging to this tenant. Done in memory because the optional
   * tenant filter would otherwise complicate the WHERE clause. */
  const relevant = rows.filter((r) => {
    if (r.scope === "platform_floor") return true;
    if (r.scope === "tenant_extension" && tenantId && r.tenantId === tenantId) return true;
    return false;
  });

  if (relevant.length === 0) {
    /* Should be impossible for jurisdictions in PLATFORM_FLOOR_*
     * because seeds exist, but defend against schema drift. */
    return {
      jurisdictions,
      gateRejects: false,
      gateLapsed: false,
      gateHolds: false,
      requireDisclosure: false,
      requireAppeal: false,
      requireAudit: false,
      policyVersionIds: [],
      contributingBasis: [],
    };
  }

  return {
    jurisdictions,
    gateRejects: relevant.some((r) => r.gateRejects),
    gateLapsed: relevant.some((r) => r.gateLapsed),
    gateHolds: relevant.some((r) => r.gateHolds),
    requireDisclosure: relevant.some((r) => r.requireDisclosure),
    requireAppeal: relevant.some((r) => r.requireAppeal),
    requireAudit: relevant.some((r) => r.requireAudit),
    policyVersionIds: relevant.map((r) => r.id),
    contributingBasis: relevant.map((r) => r.basis ?? r.jurisdictionCode),
  };
}

/**
 * Look up the active disclosure template for a jurisdiction + key.
 * Returns null if none active — callers should fall back to a generic
 * notice and log a governance warning so legal notices the gap.
 */
export async function getActiveDisclosureTemplate(
  jurisdictionCode: string,
  templateKey: string,
  language: string = "en",
  asOf: Date = new Date(),
) {
  const rows = await db
    .select()
    .from(jurisdictionDisclosureTemplatesTable)
    .where(
      and(
        eq(jurisdictionDisclosureTemplatesTable.jurisdictionCode, jurisdictionCode),
        eq(jurisdictionDisclosureTemplatesTable.templateKey, templateKey),
        eq(jurisdictionDisclosureTemplatesTable.language, language),
        lte(jurisdictionDisclosureTemplatesTable.effectiveFrom, asOf),
        or(
          isNull(jurisdictionDisclosureTemplatesTable.effectiveTo),
          gt(jurisdictionDisclosureTemplatesTable.effectiveTo, asOf),
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
