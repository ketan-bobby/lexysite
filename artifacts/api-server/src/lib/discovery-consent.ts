/**
 * discovery-consent.ts — the ONLY place allowed to write candidates.pool = 'platform'
 *
 * Ruling (July 2026): portal access and platform-pool discovery are decoupled.
 * No intake path (apply-to-job, recruiter-invite, self-register) auto-promotes
 * a candidate into the shared platform pool. Promotion happens exclusively
 * here, in the same transaction as an append-only consent row in
 * candidate_discovery_consent (who / when / which disclosure version).
 *
 * Withdrawal keeps the row (audit trail), stamps revokedAt, and restores the
 * candidate to the pool they were in before opting in (previousPool):
 * "tenant" for applied/invited candidates, "pending_profile" for
 * self-registered candidates who withdrew mid-onboarding.
 *
 * CI guard: scripts/check-platform-pool-write.mjs fails the build on any
 * other code path assigning pool "platform".
 */
import { db, candidatesTable, candidateDiscoveryConsentTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

export const CURRENT_DISCOVERY_CONSENT_VERSION = "platform-discovery-2026-07";

export interface DiscoveryDisclosure {
  version: string;
  generatedAt: string;
  headline: string;
  whatItMeans: string[];
  whatStaysPrivate: string[];
  withdrawal: string;
}

/** The exact language shown to the candidate; snapshotted onto the consent row. */
export function getDiscoveryDisclosure(): DiscoveryDisclosure {
  return {
    version: CURRENT_DISCOVERY_CONSENT_VERSION,
    generatedAt: new Date().toISOString(),
    headline: "Make my profile discoverable to other companies",
    whatItMeans: [
      "Your profile (name, title, skills, experience, and career profile) becomes visible to recruiters at companies on Lexy that hold a candidate-database licence — not just the company you applied to or that invited you.",
      "Those companies may contact you about roles that match your profile.",
      "Lexy's matching may recommend you for open roles across the platform.",
    ],
    whatStaysPrivate: [
      "Your interview recordings, scores, and evaluations are never shared across companies.",
      "Companies you block, and your current employer if you enable that shield, cannot see you.",
      "You can pause discovery or limit visibility to matched roles only, at any time, without withdrawing.",
    ],
    withdrawal:
      "You can turn discovery off at any time in your portal settings. Your profile immediately stops being visible to other companies; the company you applied to or that invited you keeps its own records.",
  };
}

export interface GrantContext {
  ua?: string | null;
  ip?: string | null;
  /** Where the opt-in was captured: portal onboarding vs. settings page. */
  surface: "onboarding" | "settings";
}

/**
 * Grant discovery opt-in: insert the consent row and promote the candidate to
 * the platform pool ATOMICALLY. Idempotent — if the candidate is already in
 * the platform pool with an active consent for the current version, returns
 * the existing row.
 */
export async function grantDiscoveryOptIn(candidateId: string, ctx: GrantContext) {
  try {
    return await grantDiscoveryOptInTx(candidateId, ctx);
  } catch (e: any) {
    /* Partial unique index (one active row per candidate+version) makes
     * concurrent double-POSTs safe: the losing transaction aborts with
     * 23505 and we recover HERE, outside the aborted tx (a post-error
     * re-select inside it would fail with 25P02). The winning transaction
     * already set pool='platform', so returning its row is complete. */
    if (e?.cause?.code === "23505" || e?.code === "23505") {
      const [existing] = await db
        .select()
        .from(candidateDiscoveryConsentTable)
        .where(
          and(
            eq(candidateDiscoveryConsentTable.candidateId, candidateId),
            eq(candidateDiscoveryConsentTable.consentVersion, CURRENT_DISCOVERY_CONSENT_VERSION),
            isNull(candidateDiscoveryConsentTable.revokedAt),
          ),
        )
        .limit(1);
      return existing ?? null;
    }
    throw e;
  }
}

async function grantDiscoveryOptInTx(candidateId: string, ctx: GrantContext) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: candidatesTable.id, pool: candidatesTable.pool })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);
    if (!candidate) return null;

    const [active] = await tx
      .select()
      .from(candidateDiscoveryConsentTable)
      .where(
        and(
          eq(candidateDiscoveryConsentTable.candidateId, candidateId),
          eq(candidateDiscoveryConsentTable.consentVersion, CURRENT_DISCOVERY_CONSENT_VERSION),
          isNull(candidateDiscoveryConsentTable.revokedAt),
        ),
      )
      .orderBy(desc(candidateDiscoveryConsentTable.consentedAt))
      .limit(1);
    if (active && (candidate as any).pool === "platform") return active;

    /* Record the ACTUAL prior pool — including 'platform' for legacy
     * already-promoted candidates. The revoke path maps 'platform' →
     * 'tenant' (withdrawal must always exit discovery), but the audit
     * row stays truthful about the state at grant time. */
    const previousPool = (candidate as any).pool ?? "tenant";

    /* A 23505 here (concurrent double-grant) aborts this transaction and is
     * recovered by the outer catch in grantDiscoveryOptIn. */
    const [row] = await tx
      .insert(candidateDiscoveryConsentTable)
      .values({
        candidateId,
        consentVersion: CURRENT_DISCOVERY_CONSENT_VERSION,
        disclosureSnapshot: getDiscoveryDisclosure(),
        previousPool,
        captureContext: {
          ua: ctx.ua?.slice(0, 300) ?? null,
          ip: ctx.ip ?? null,
          surface: ctx.surface,
        },
      })
      .returning();

    if ((candidate as any).pool !== "platform") {
      await tx
        .update(candidatesTable)
        .set({ pool: "platform", updatedAt: new Date() } as any)
        .where(eq(candidatesTable.id, candidateId));
    }
    return row;
  });
}

/**
 * Withdraw discovery opt-in: stamp revokedAt on every active consent row and
 * restore the candidate to the pool captured at grant time. The consent rows
 * remain (audit trail).
 */
export async function revokeDiscoveryOptIn(candidateId: string) {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select()
      .from(candidateDiscoveryConsentTable)
      .where(
        and(
          eq(candidateDiscoveryConsentTable.candidateId, candidateId),
          isNull(candidateDiscoveryConsentTable.revokedAt),
        ),
      )
      .orderBy(desc(candidateDiscoveryConsentTable.consentedAt))
      .limit(1);
    if (!latest) return false;

    await tx
      .update(candidateDiscoveryConsentTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(candidateDiscoveryConsentTable.candidateId, candidateId),
          isNull(candidateDiscoveryConsentTable.revokedAt),
        ),
      );

    /* previousPool is the truthful state at grant time. Restore it exactly,
     * EXCEPT 'platform' (legacy already-promoted candidates): withdrawal
     * must always exit discovery, so those restore to 'tenant'. */
    const restore =
      latest.previousPool === "pending_profile" ? "pending_profile" : "tenant";
    /* No pool predicate here: the id filter is sufficient, and adding
     * eq(pool,'platform') would read as a platform-pool row-read to the
     * privacy-seal scanner. Restoring is idempotent — `restore` is never
     * 'platform'. */
    await tx
      .update(candidatesTable)
      .set({ pool: restore, updatedAt: new Date() } as any) // platform-pool-write-exempt: restore on withdrawal never writes 'platform'
      .where(eq(candidatesTable.id, candidateId));
    return true;
  });
}

/** True if an un-revoked opt-in row exists for the current version. */
export async function hasActiveDiscoveryOptIn(candidateId: string | null | undefined): Promise<boolean> {
  if (!candidateId) return false;
  const [row] = await db
    .select({ id: candidateDiscoveryConsentTable.id })
    .from(candidateDiscoveryConsentTable)
    .where(
      and(
        eq(candidateDiscoveryConsentTable.candidateId, candidateId),
        eq(candidateDiscoveryConsentTable.consentVersion, CURRENT_DISCOVERY_CONSENT_VERSION),
        isNull(candidateDiscoveryConsentTable.revokedAt),
      ),
    )
    .orderBy(desc(candidateDiscoveryConsentTable.consentedAt))
    .limit(1);
  return !!row;
}
