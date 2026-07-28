/**
 * viewer-privacy.ts — the retroactive privacy seal for every candidate-facing
 * "who viewed you" surface.
 *
 * The candidate's CURRENT privacy settings govern what they (and their
 * notifications/badges) see about being seen — not just their future
 * visibility to employers:
 *
 *   • discoveryPaused — while paused no new views can occur, so every stored
 *     view predates the pause → the whole seen-surface goes quiet (zero
 *     counts, no identified companies, no view-triggered emails). Unpausing
 *     restores history (minus blocked companies).
 *   • blockedCompanyDomains / hideFromCurrentEmployer — view events from
 *     matching tenants are removed from BOTH identified lists AND anonymous
 *     counts, even when the view predates the block, so a count always equals
 *     what its list would show.
 *
 * Domain matching mirrors applyCandidatePrivacyFilter (routes/candidates.ts):
 * strict same-or-subdomain on the tenant's website/contact-email domains,
 * never display-name matching. Fail-CLOSED: when the candidate has active
 * hidden domains and a viewer tenant's domain cannot be resolved, that tenant
 * is excluded rather than risked being shown.
 *
 * EVERY reader of eventType='recruiter_view' rows must use this seal:
 *   - routes/career-profile.ts  GET /portal/engagement (counts, top viewers,
 *     tiers, target matches) and the weekly-stats recruiterViewsThisWeek
 *   - lib/weekly-digest-scheduler.ts   "N recruiters viewed you" digest line
 *   - lib/achievement-engine.ts        view-count-driven badges
 *   - lib/market-event-emitter.ts      target-company-view + view-burst emails
 * If you add a new reader, apply the seal there too.
 */
import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { db, candidatesTable, candidateActionEventsTable, tenantsTable } from "@workspace/db";

export interface ViewerPrivacySeal {
  /** discoveryPaused is ON — suppress the entire seen-surface. */
  viewsPaused: boolean;
  /** viewer tenant ids whose views must be hidden (blocked / current employer / unresolvable). */
  excludedViewerTenantIds: string[];
  /** SQL predicate for count queries: keeps anonymous NULL-tenant events, drops hidden tenants. */
  viewNotHidden: SQL;
  /** In-memory check for already-fetched event rows. */
  isTenantExcluded: (tenantId: string | null | undefined) => boolean;
}

const normDom = (raw: any): string =>
  String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
const sameOrSub = (a: string, b: string) =>
  !!a && !!b && (a === b || a.endsWith("." + b) || b.endsWith("." + a));

/**
 * Resolve the candidate's current viewer-privacy seal. Scans the candidate's
 * DISTINCT viewer tenants (all-time — achievement counts are all-time) and
 * matches their domains against the candidate's hidden domains.
 */
export async function getViewerPrivacySeal(candidateId: string): Promise<ViewerPrivacySeal> {
  const [privacyRow] = await db.select({
    discoveryPaused:         (candidatesTable as any).discoveryPaused,
    hideFromCurrentEmployer: (candidatesTable as any).hideFromCurrentEmployer,
    currentEmployerDomain:   (candidatesTable as any).currentEmployerDomain,
    blockedCompanyDomains:   (candidatesTable as any).blockedCompanyDomains,
  }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);

  const viewsPaused = privacyRow?.discoveryPaused === true;
  const hiddenDomains: string[] = [
    ...(Array.isArray(privacyRow?.blockedCompanyDomains) ? (privacyRow!.blockedCompanyDomains as any[]) : []),
    ...(privacyRow?.hideFromCurrentEmployer === true && privacyRow?.currentEmployerDomain
      ? [privacyRow.currentEmployerDomain] : []),
  ].map(normDom).filter(Boolean);

  const excludedViewerTenantIds: string[] = [];
  if (!viewsPaused && hiddenDomains.length > 0) {
    const distinctViewerTenants = await db
      .selectDistinct({
        tenantId: candidateActionEventsTable.viewerTenantId,
        website:  tenantsTable.website,
        email:    tenantsTable.contactEmail,
      })
      .from(candidateActionEventsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, candidateActionEventsTable.viewerTenantId))
      .where(and(
        eq(candidateActionEventsTable.candidateId, candidateId),
        eq(candidateActionEventsTable.eventType, "recruiter_view"),
        sql`${candidateActionEventsTable.viewerTenantId} IS NOT NULL`,
      ));
    for (const t of distinctViewerTenants) {
      if (!t.tenantId) continue;
      const tenantDoms: string[] = [];
      if (t.website) {
        try {
          const u = new URL(String(t.website).startsWith("http") ? String(t.website) : `https://${t.website}`);
          const host = u.hostname.replace(/^www\./, "").toLowerCase().trim();
          if (host) tenantDoms.push(host);
        } catch { /* malformed website — skip */ }
      }
      if (t.email && String(t.email).includes("@")) {
        const dom = String(t.email).split("@")[1]?.toLowerCase().trim();
        if (dom) tenantDoms.push(dom);
      }
      /* Fail-CLOSED: unresolvable domain while hidden domains are active →
         exclude rather than risk showing a blocked company. */
      if (tenantDoms.length === 0 ||
          tenantDoms.some(td => hiddenDomains.some(hd => sameOrSub(td, hd)))) {
        excludedViewerTenantIds.push(t.tenantId);
      }
    }
  }

  const excludedSet = new Set(excludedViewerTenantIds);
  const viewNotHidden: SQL = excludedViewerTenantIds.length > 0
    ? sql`(${candidateActionEventsTable.viewerTenantId} IS NULL OR ${candidateActionEventsTable.viewerTenantId} NOT IN (${sql.join(excludedViewerTenantIds.map(id => sql`${id}`), sql`, `)}))`
    : sql`TRUE`;

  return {
    viewsPaused,
    excludedViewerTenantIds,
    viewNotHidden,
    isTenantExcluded: (tenantId) => !!tenantId && excludedSet.has(tenantId),
  };
}

/** Sealed COUNT of the candidate's recruiter_view events since `since`. */
export async function countSealedRecruiterViews(
  candidateId: string,
  since: Date | null,
  seal: ViewerPrivacySeal,
): Promise<number> {
  if (seal.viewsPaused) return 0;
  const conds = [
    eq(candidateActionEventsTable.candidateId, candidateId),
    eq(candidateActionEventsTable.eventType, "recruiter_view"),
    seal.viewNotHidden,
  ];
  if (since) conds.push(gte(candidateActionEventsTable.createdAt, since));
  const [{ count: n = 0 } = {}] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(candidateActionEventsTable)
    .where(and(...conds));
  return Number(n);
}
