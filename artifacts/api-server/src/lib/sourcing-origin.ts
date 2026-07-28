/**
 * lib/sourcing-origin.ts — Sourcing-origin attribution for pipeline entries
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * Every applications-row INSERT site calls one of these helpers to stamp
 * origin metadata (entry_type + origin_evidence + origin_set_at/by) at the
 * moment the pipeline link is created. Origin is FIRST-IN and immutable
 * afterwards (DB trigger `applications_origin_immutable`); corrections go
 * through the staff-only workflow in routes/fee-ledger.ts.
 *
 * ─── Channels ────────────────────────────────────────────────────────────────
 *   ai_sourcing — the AI sourcing agent surfaced the candidate  → entry 'sourced'
 *   linx        — candidate was pushed to this client via LINX / talent-pool
 *                 submission BEFORE the link was made           → entry 'sourced'
 *   inbound     — candidate applied themselves (public form,
 *                 portal express-interest)                      → entry 'applied'
 *   customer    — the customer's own recruiter added/imported
 *                 the candidate (manual link, CSV/CV import,
 *                 API create)                                   → entry 'manual'
 *
 * FEE ELIGIBILITY = entry_type='sourced' AND origin_evidence IS NOT NULL
 * (see lib/fee-ledger.ts). Ambiguity resolves AGAINST charging: if the LINX
 * lookup fails, the entry is attributed to the customer (no fee).
 */
import { db, talentPoolSubmissionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export type OriginChannel = "ai_sourcing" | "linx" | "inbound" | "customer";

export interface OriginFields {
  entryType: "sourced" | "applied" | "manual";
  originSetAt: Date;
  originSetBy: string;
  originEvidence: Record<string, unknown>;
}

const ENTRY_TYPE_FOR_CHANNEL: Record<OriginChannel, OriginFields["entryType"]> = {
  ai_sourcing: "sourced",
  linx: "sourced",
  inbound: "applied",
  customer: "manual",
};

/** Build the origin column set for a new applications row. */
export function originFields(
  channel: OriginChannel,
  evidence: Record<string, unknown>,
  setBy: string,
): OriginFields {
  return {
    entryType: ENTRY_TYPE_FOR_CHANNEL[channel],
    originSetAt: new Date(),
    originSetBy: setBy,
    originEvidence: { channel, ...evidence, recordedAt: new Date().toISOString() },
  };
}

/**
 * LINX attribution check for recruiter-initiated links: was this candidate
 * pushed to this client tenant via a talent-pool submission BEFORE the link?
 * Returns the evidence payload, or null when there is no push on record.
 * Fail-closed: any lookup error attributes the entry to the customer (no fee).
 */
export async function findLinxPush(
  candidateId: string,
  clientTenantId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!clientTenantId) return null;
  try {
    const [sub] = await db
      .select({
        id: talentPoolSubmissionsTable.id,
        pushedAt: talentPoolSubmissionsTable.pushedAt,
        pushedByUserId: talentPoolSubmissionsTable.pushedByUserId,
        jobPostingId: talentPoolSubmissionsTable.jobPostingId,
      })
      .from(talentPoolSubmissionsTable)
      .where(
        and(
          eq(talentPoolSubmissionsTable.candidateId, candidateId),
          eq(talentPoolSubmissionsTable.clientTenantId, clientTenantId),
        ),
      )
      .limit(1);
    if (!sub) return null;
    return {
      submissionId: sub.id,
      pushedAt: sub.pushedAt ? new Date(sub.pushedAt as any).toISOString() : null,
      pushedByUserId: sub.pushedByUserId ?? null,
      jobPostingId: sub.jobPostingId ?? null,
    };
  } catch (err) {
    logger.warn(
      { err, candidateId, clientTenantId },
      "LINX origin lookup failed — attributing to customer (no fee)",
    );
    return null;
  }
}

/**
 * Origin for a recruiter/customer-initiated link (manual link, CV import,
 * API create): LINX push wins if one exists, otherwise it's the customer's
 * own candidate.
 */
export async function recruiterLinkOrigin(params: {
  candidateId: string;
  tenantId: string | null | undefined;
  via: string;
  actorId?: string | null;
}): Promise<OriginFields> {
  const linx = await findLinxPush(params.candidateId, params.tenantId);
  if (linx) {
    return originFields("linx", { ...linx, linkedVia: params.via }, params.actorId ?? "system");
  }
  return originFields("customer", { via: params.via }, params.actorId ?? "system");
}
