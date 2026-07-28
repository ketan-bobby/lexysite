/**
 * lib/plan-enforcement.ts — Subscription Limit Gates + Credit Ledger
 *
 * Helpers that check the current usage of a tenant against the limits defined
 * by its subscription plan (see lib/plans.ts) and that record metered actions
 * to the credit_usage_events ledger so usage can be aggregated for both
 * enforcement and the in-app meter UI.
 *
 * Used by:
 *   - routes/jobs.ts                  (gates POST /jobs)
 *   - routes/interviews.ts            (gates session creation + records credits)
 *   - routes/credits.ts               (read aggregated usage)
 *   - routes/plans.ts                 (usage payload exposed to Subscription UI)
 *
 * Convention: limit value of -1 in lib/plans.ts means "unlimited"; this module
 * always returns allowed=true for unlimited limits without hitting the DB.
 *
 * Plan-expiry math is anchored to tenants.planActivatedAt (NOT createdAt) so
 * a customer who later moves between plans gets a fresh window from the move-in
 * date instead of being silently expired the moment they switch.
 */
import { db } from "@workspace/db";
import { logger } from "./logger";
import {
  tenantsTable,
  jobsTable,
  interviewSessionsTable,
  creditUsageEventsTable,
  usersTable,
  staffInviteTokensTable,
  planLimitNotificationsTable,
} from "@workspace/db";
import { and, eq, gt, gte, isNull, sql, inArray } from "drizzle-orm";
import { getPlan, type PlanCode, type PlanPackage } from "./plans.js";
import { getSubtreeTenantIds } from "./tenantUtils.js";
import { sendEmail, plainToHtml } from "./email.js";

export type CreditKind = "interview" | "candidate_db_search" | "ai_generation" | "outreach_message";

/** Grace window (days) after paid_through_at lapses before a tenant is hard
 *  blocked. During grace the tenant is `past_due` but still allowed to work.
 *  Override with SUBSCRIPTION_GRACE_DAYS. */
export const GRACE_PERIOD_DAYS: number = (() => {
  const n = Number(process.env.SUBSCRIPTION_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();
export const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/** Effective grace days for a tenant: per-tenant override (tenants.
 *  grace_period_days, set via POST /tenants/:id/grace-period for negotiated
 *  Enterprise terms) falls back to the global default. */
export function graceDaysFor(gracePeriodDays: number | null | undefined): number {
  return typeof gracePeriodDays === "number" && gracePeriodDays >= 0
    ? gracePeriodDays
    : GRACE_PERIOD_DAYS;
}

/** Identifier for a gated limit. Used as the `kind` column in
 *  plan_limit_notifications so adding a new limit doesn't need a migration. */
export type LimitKind =
  | "open_jobs"
  | "interviews"
  | "staff_seats"
  | "sub_clients"
  | CreditKind;

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  limit: number;
  current: number;
  plan: PlanPackage;
  /** True if the plan itself has expired (demo past expiresAfterDays). */
  planExpired: boolean;
}

async function loadTenantWithPlan(tenantId: string): Promise<{
  plan: PlanPackage;
  planExpired: boolean;
  planActivatedAt: Date;
}> {
  const [t] = await db.select({
    plan: tenantsTable.plan,
    planActivatedAt: tenantsTable.planActivatedAt,
    createdAt: tenantsTable.createdAt,
    status: tenantsTable.status,
    paidThroughAt: tenantsTable.paidThroughAt,
    gracePeriodDays: tenantsTable.gracePeriodDays,
  }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);

  const plan = getPlan(t?.plan);
  const planActivatedAt = (t?.planActivatedAt ?? t?.createdAt ?? new Date()) as Date;
  let planExpired = false;
  // Manual-billing override: when sales has set paid_through_at, that date
  // wins over the demo-trial expiresAfterDays math in both directions —
  // a future paid_through_at keeps the tenant live past the trial window,
  // and a past one eventually suspends them even on a non-expiring plan.
  //
  // Grace window: a lapsed paid_through_at does NOT block immediately. The
  // tenant enters `past_due` (still allowed to work) for GRACE_DAYS, and only
  // becomes hard-expired once now > paid_through_at + grace. This mirrors the
  // status the subscription-lifecycle-scheduler sets (active → past_due →
  // suspended) so enforcement and the displayed status stay consistent.
  if (t?.paidThroughAt) {
    const graceCutoff =
      new Date(t.paidThroughAt).getTime() + graceDaysFor(t.gracePeriodDays) * 24 * 60 * 60 * 1000;
    planExpired = graceCutoff < Date.now();
  } else if (plan.expiresAfterDays > 0) {
    const ageDays = (Date.now() - new Date(planActivatedAt).getTime()) / (1000 * 60 * 60 * 24);
    planExpired = ageDays > plan.expiresAfterDays;
  }
  // `suspended` is the hard block (set by the scheduler past grace, or
  // manually). `past_due` is the soft grace state and intentionally does NOT
  // force expiry here — the paid_through + grace math above governs that.
  if (t?.status === "suspended") planExpired = true;
  return { plan, planExpired, planActivatedAt: new Date(planActivatedAt) };
}

/**
 * Gate for POST /jobs. Counts currently-open jobs (not archived / closed)
 * against the plan's maxOpenJobs limit.
 */
export async function checkJobCreationAllowed(tenantId: string): Promise<LimitCheckResult> {
  const { plan, planExpired } = await loadTenantWithPlan(tenantId);
  const limit = plan.limits.maxOpenJobs;

  if (planExpired) {
    return { allowed: false, reason: `${plan.name} plan has expired — please upgrade to continue posting jobs.`, limit, current: 0, plan, planExpired: true };
  }
  if (limit === -1) {
    return { allowed: true, limit, current: 0, plan, planExpired: false };
  }

  const openStatuses = ["draft", "active", "paused", "pending_approval"] as const;
  const [{ value: openCount }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(jobsTable)
    .where(and(
      eq(jobsTable.tenantId, tenantId),
      inArray(jobsTable.status, openStatuses as unknown as any),
    ));

  if (openCount >= limit) {
    void maybeNotifyLimitReached(tenantId, "open_jobs", plan, limit, openCount);
    return {
      allowed: false,
      reason: `Your ${plan.name} plan allows ${limit} open job${limit === 1 ? "" : "s"} at a time. Close or archive an existing job, or upgrade your plan.`,
      limit,
      current: openCount,
      plan,
      planExpired: false,
    };
  }
  return { allowed: true, limit, current: openCount, plan, planExpired: false };
}

/**
 * Gate for interview session creation. Counts sessions created this calendar
 * month against the plan's maxInterviewsPerMonth limit (lifetime for demo).
 */
export async function checkInterviewCreationAllowed(tenantId: string): Promise<LimitCheckResult> {
  const { plan, planExpired } = await loadTenantWithPlan(tenantId);
  const limit = plan.limits.maxInterviewsPerMonth;

  if (planExpired) {
    return { allowed: false, reason: `${plan.name} plan has expired — please upgrade to continue running interviews.`, limit, current: 0, plan, planExpired: true };
  }
  if (limit === -1) {
    return { allowed: true, limit, current: 0, plan, planExpired: false };
  }

  let whereClause;
  if (plan.code === "demo") {
    whereClause = eq(interviewSessionsTable.tenantId, tenantId);
  } else {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    whereClause = and(
      eq(interviewSessionsTable.tenantId, tenantId),
      gte(interviewSessionsTable.createdAt, monthStart),
    );
  }

  const [{ value: count }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(interviewSessionsTable)
    .where(whereClause);

  if (count >= limit) {
    const periodLabel = plan.code === "demo" ? "in total" : "this month";
    void maybeNotifyLimitReached(tenantId, "interviews", plan, limit, count);
    return {
      allowed: false,
      reason: `Your ${plan.name} plan allows ${limit} interview session${limit === 1 ? "" : "s"} ${periodLabel}. Upgrade your plan to run more interviews.`,
      limit,
      current: count,
      plan,
      planExpired: false,
    };
  }
  return { allowed: true, limit, current: count, plan, planExpired: false };
}

/**
 * Generic credit gate. Looks up the limit for a credit kind from the plan and
 * counts ledger rows in the relevant period (lifetime for demo, calendar
 * month for paid plans).
 */
export async function checkCreditAllowed(tenantId: string, kind: CreditKind): Promise<LimitCheckResult> {
  const { plan, planExpired } = await loadTenantWithPlan(tenantId);
  const limit = limitForKind(plan, kind);

  if (planExpired) {
    return { allowed: false, reason: `${plan.name} plan has expired — please upgrade to continue.`, limit, current: 0, plan, planExpired: true };
  }
  if (limit === -1) return { allowed: true, limit, current: 0, plan, planExpired: false };

  const since = periodStartFor(plan.code);
  const whereClause = since
    ? and(eq(creditUsageEventsTable.tenantId, tenantId), eq(creditUsageEventsTable.kind, kind), gte(creditUsageEventsTable.occurredAt, since))
    : and(eq(creditUsageEventsTable.tenantId, tenantId), eq(creditUsageEventsTable.kind, kind));

  const [{ value }] = await db
    .select({ value: sql<number>`coalesce(sum(units), 0)::int` })
    .from(creditUsageEventsTable)
    .where(whereClause);

  if (value >= limit) {
    void maybeNotifyLimitReached(tenantId, kind, plan, limit, value);
    return {
      allowed: false,
      reason: `Your ${plan.name} plan allows ${limit} ${kindLabel(kind)} ${plan.code === "demo" ? "in total" : "this month"}. Upgrade your plan for more.`,
      limit,
      current: value,
      plan,
      planExpired: false,
    };
  }
  return { allowed: true, limit, current: value, plan, planExpired: false };
}

/**
 * Append a single credit-usage event. Fire-and-forget at the call site is fine —
 * we never want a logging failure to block the user from completing the action,
 * so callers should `void recordCreditEvent(...)` rather than await it on the
 * critical path. Errors are logged but swallowed.
 */
export async function recordCreditEvent(args: {
  tenantId: string;
  userId?: string | null;
  kind: CreditKind;
  units?: number;
  refId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(creditUsageEventsTable).values({
      tenantId: args.tenantId,
      userId: args.userId ?? null,
      kind: args.kind,
      units: args.units ?? 1,
      refId: args.refId,
      metadata: args.metadata ?? null,
    });
  } catch (err) {
    // Non-fatal — credit tracking is best-effort.
    logger.error({ err }, "[recordCreditEvent] failed");
  }
}

/**
 * Aggregate credit usage for a tenant across all kinds in the plan's current
 * billing period. Drives the Subscription page meter UI.
 */
export async function getCreditUsage(tenantId: string): Promise<{
  plan: PlanPackage;
  planExpired: boolean;
  planActivatedAt: string;
  expiresAt: string | null;
  byKind: Record<CreditKind, { current: number; limit: number; periodLabel: string }>;
}> {
  const { plan, planExpired, planActivatedAt } = await loadTenantWithPlan(tenantId);
  const since = periodStartFor(plan.code);
  const periodLabel = plan.code === "demo" ? "lifetime" : "this month";

  const rows = await db
    .select({
      kind: creditUsageEventsTable.kind,
      units: sql<number>`coalesce(sum(units), 0)::int`,
    })
    .from(creditUsageEventsTable)
    .where(since
      ? and(eq(creditUsageEventsTable.tenantId, tenantId), gte(creditUsageEventsTable.occurredAt, since))
      : eq(creditUsageEventsTable.tenantId, tenantId))
    .groupBy(creditUsageEventsTable.kind);

  const totals = new Map<string, number>(rows.map((r) => [r.kind as string, Number(r.units)]));
  const allKinds: CreditKind[] = ["interview", "candidate_db_search", "ai_generation", "outreach_message"];
  const byKind = Object.fromEntries(
    allKinds.map((k) => [k, {
      current: totals.get(k) ?? 0,
      limit:   limitForKind(plan, k),
      periodLabel,
    }]),
  ) as Record<CreditKind, { current: number; limit: number; periodLabel: string }>;

  return {
    plan,
    planExpired,
    planActivatedAt: planActivatedAt.toISOString(),
    expiresAt: plan.expiresAfterDays > 0
      ? new Date(planActivatedAt.getTime() + plan.expiresAfterDays * 86_400_000).toISOString()
      : null,
    byKind,
  };
}

/**
 * Resolve a tenant's root (top-most ancestor with no parentId) by walking the
 * parentId chain. Returns the input tenantId if it has no parent. Plan and
 * subscription limits are always evaluated against the root tenant — that's
 * the contracting entity. Sub-clients inherit the plan from their root
 * (see routes/tenants.ts) and do not have their own seats / sub-clients.
 *
 * A `visited` set guards against accidental cycles in the parentId graph.
 */
export async function resolveRootTenantId(tenantId: string): Promise<string> {
  let cursor: string | null = tenantId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const [row] = await db
      .select({ parentId: tenantsTable.parentId })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, cursor))
      .limit(1);
    if (!row) return tenantId; // unknown tenant — fall through to original
    if (!row.parentId) return cursor;
    cursor = row.parentId;
  }
  return tenantId;
}

/**
 * Gate for POST /staff-invites. Counts active users in the root tenant plus
 * unexpired, unused staff-invite tokens against the root plan's
 * maxStaffSeats. Sub-clients do not have teams (the /team page only exists
 * for the root tenant), so we always evaluate seats at the root.
 *
 * Pending invites count toward the limit to prevent the obvious bypass of
 * generating N invites before any are accepted. Expired or already-accepted
 * tokens are excluded.
 */
export async function checkSeatInviteAllowed(targetTenantId: string): Promise<LimitCheckResult> {
  const rootId = await resolveRootTenantId(targetTenantId);
  const { plan, planExpired } = await loadTenantWithPlan(rootId);
  const limit = plan.limits.maxStaffSeats;

  if (planExpired) {
    return { allowed: false, reason: `${plan.name} plan has expired — please upgrade to invite more team members.`, limit, current: 0, plan, planExpired: true };
  }
  if (limit === -1) {
    return { allowed: true, limit, current: 0, plan, planExpired: false };
  }

  // Count seats across the full root subtree so users / pending invites
  // attached to a descendant tenant still count against the root cap.
  const subtreeIds = await getSubtreeTenantIds(rootId);
  const now = new Date();
  const [seatRow, inviteRow] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(inArray(usersTable.tenantId, subtreeIds)),
    db.select({ value: sql<number>`count(*)::int` })
      .from(staffInviteTokensTable)
      .where(and(
        inArray(staffInviteTokensTable.tenantId, subtreeIds),
        isNull(staffInviteTokensTable.usedAt),
        gt(staffInviteTokensTable.expiresAt, now),
      )),
  ]);
  const current = (seatRow[0]?.value ?? 0) + (inviteRow[0]?.value ?? 0);

  if (current >= limit) {
    void maybeNotifyLimitReached(rootId, "staff_seats", plan, limit, current);
    return {
      allowed: false,
      reason: `Your ${plan.name} plan includes ${limit} team seat${limit === 1 ? "" : "s"} (active members + pending invites). Contact sales@l3xy.io to add more seats.`,
      limit,
      current,
      plan,
      planExpired: false,
    };
  }
  return { allowed: true, limit, current, plan, planExpired: false };
}

/**
 * Gate for sub_client creation via POST /tenants. Counts existing
 * clientType='sub_client' tenants under the root vs the root plan's
 * maxSubClients. Sub-clients are leaves by convention (no further nesting),
 * so a flat count of children under the root is sufficient.
 */
export async function checkSubClientCreationAllowed(parentTenantId: string): Promise<LimitCheckResult> {
  const rootId = await resolveRootTenantId(parentTenantId);
  const { plan, planExpired } = await loadTenantWithPlan(rootId);
  const limit = plan.limits.maxSubClients;

  if (planExpired) {
    return { allowed: false, reason: `${plan.name} plan has expired — please upgrade to add more clients.`, limit, current: 0, plan, planExpired: true };
  }
  if (limit === -1) {
    return { allowed: true, limit, current: 0, plan, planExpired: false };
  }
  if (limit === 0) {
    return {
      allowed: false,
      reason: `Your ${plan.name} plan doesn't include sub-clients. Contact sales@l3xy.io to upgrade.`,
      limit,
      current: 0,
      plan,
      planExpired: false,
    };
  }

  const [{ value: count }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(tenantsTable)
    .where(and(
      eq(tenantsTable.parentId, rootId),
      eq(tenantsTable.clientType, "sub_client"),
    ));

  if (count >= limit) {
    void maybeNotifyLimitReached(rootId, "sub_clients", plan, limit, count);
    return {
      allowed: false,
      reason: `Your ${plan.name} plan includes ${limit} sub-client${limit === 1 ? "" : "s"}. Contact sales@l3xy.io to add more.`,
      limit,
      current: count,
      plan,
      planExpired: false,
    };
  }
  return { allowed: true, limit, current: count, plan, planExpired: false };
}

export function buildLimitExceededBody(result: LimitCheckResult) {
  return {
    error: "PLAN_LIMIT_EXCEEDED",
    message: result.reason,
    plan: { code: result.plan.code, name: result.plan.name },
    limit: result.limit,
    current: result.current,
    planExpired: result.planExpired,
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/* The credit window for every paid plan is the current UTC calendar
 * month — 00:00 UTC on the 1st through to the next 1st. This is
 * INTENTIONALLY independent of:
 *   - tenant.billingTerm ('monthly' vs 'annual'): annual contracts get a
 *     fresh monthly quota of interviews / DB searches / AI generations /
 *     outreach messages on the 1st of every UTC month — i.e. 12 quota
 *     refreshes across the annual term, NOT one lump sum at signup.
 *     Without this, an annual subscriber would burn through their whole
 *     year's quota in month one and then be gated for 11 months. If you
 *     ever want annual subscribers to pool their quota across the year,
 *     thread billingTerm in here AND update credits.ts periodLabel; do
 *     not silently change the window — usage counts would jump.
 *   - Stripe billing anchor (`billing_subscriptions.current_period_start`):
 *     intentionally not synced. A customer whose Stripe cycle starts on
 *     the 15th still resets quota on the 1st. Keeping quota on calendar
 *     month makes "this month's usage" meaningful in the UI and removes
 *     a class of edge cases around proration, mid-cycle upgrades, and
 *     subscription gaps.
 *   - planActivatedAt: that's only used for plan EXPIRY math (demo's
 *     14-day window), never for quota windowing.
 *
 * Demo plan is the only exception — it returns null so usage is counted
 * lifetime-to-date, which matches its "evaluate the platform, no refresh"
 * semantics. */
function periodStartFor(planCode: PlanCode): Date | null {
  if (planCode === "demo") return null;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  return monthStart;
}

function limitForKind(plan: PlanPackage, kind: CreditKind): number {
  switch (kind) {
    case "interview":           return plan.limits.maxInterviewsPerMonth;
    case "candidate_db_search": return plan.limits.maxCandidateDbSearchesPerMonth;
    case "ai_generation":       return plan.limits.maxAiGenerationsPerMonth ?? -1;
    case "outreach_message":    return plan.limits.maxOutreachMessagesPerMonth ?? -1;
  }
}

function kindLabel(kind: CreditKind): string {
  switch (kind) {
    case "interview":           return "interview sessions";
    case "candidate_db_search": return "candidate-database searches";
    case "ai_generation":       return "AI generations";
    case "outreach_message":    return "outreach messages";
  }
}

/* ── Plan-limit-hit email notifications ────────────────────────────────────
 *
 * Sends a single "you've hit your plan limit" email to the tenant admin the
 * first time a given (tenant, kind) trips a hard gate in a given period.
 * Idempotency is enforced by a unique index on plan_limit_notifications
 * (tenant_id, kind, period_key) — the INSERT ON CONFLICT DO NOTHING is the
 * atomic claim. Whoever inserts the row owns the send; everyone else no-ops.
 *
 * Period semantics:
 *   - Monthly meters (interviews, credit kinds): periodKey = "YYYY-MM" (UTC).
 *     One email per kind per calendar month. After month rollover the email
 *     can fire again — which is desirable: the limit is fresh and the
 *     reminder is timely.
 *   - One-shot caps (open_jobs, staff_seats, sub_clients): periodKey =
 *     "lifetime". One email per kind for the lifetime of the tenant.
 *     Otherwise we'd spam recruiters every time they bounce off the seat
 *     cap. They can reset by upgrading and rolling the kind+lifetime row
 *     via a manual DELETE if sales needs a re-send.
 *
 * Fire-and-forget at call sites — every caller wraps with `void` so a DB
 * blip or email outage never blocks the user's request. */
/* Kinds that get a fresh notification each calendar month. open_jobs is
 * here even though it isn't a metered/monthly quota — it's a stock cap
 * that can be hit, released (close a job), and hit again, so a "lifetime"
 * period would mean the tenant gets exactly one email ever, even after a
 * cap-and-recover loop a year later. Monthly cadence keeps reminders
 * timely without spamming. staff_seats and sub_clients stay lifetime —
 * those are sticky growth moments, not recurring operational events. */
const MONTHLY_KINDS: ReadonlySet<LimitKind> = new Set<LimitKind>([
  "open_jobs",
  "interviews",
  "interview",
  "candidate_db_search",
  "ai_generation",
  "outreach_message",
]);

function periodKeyFor(kind: LimitKind): string {
  if (MONTHLY_KINDS.has(kind)) {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return "lifetime";
}

function humanLimitLabel(kind: LimitKind): string {
  switch (kind) {
    case "open_jobs":           return "open jobs";
    case "interviews":          return "interview sessions";
    case "staff_seats":         return "team seats";
    case "sub_clients":         return "sub-clients";
    case "interview":           return "interview sessions";
    case "candidate_db_search": return "candidate-database searches";
    case "ai_generation":       return "AI generations";
    case "outreach_message":    return "outreach messages";
  }
}

async function maybeNotifyLimitReached(
  tenantId: string,
  kind: LimitKind,
  plan: PlanPackage,
  limit: number,
  current: number,
): Promise<void> {
  try {
    const periodKey = periodKeyFor(kind);

    // Atomic claim: ON CONFLICT DO NOTHING + check RETURNING. If no row is
    // returned, another worker (or an earlier call this period) already
    // sent the email — bail out without doing any work.
    const inserted = await db
      .insert(planLimitNotificationsTable)
      .values({ tenantId, kind, periodKey })
      .onConflictDoNothing({ target: [
        planLimitNotificationsTable.tenantId,
        planLimitNotificationsTable.kind,
        planLimitNotificationsTable.periodKey,
      ] })
      .returning({ id: planLimitNotificationsTable.id });
    if (inserted.length === 0) return;

    // We won the claim — best-effort send. Failure leaves the row in place
    // (under-emailing > spam-emailing); a platform admin can DELETE the row
    // to retry.
    const [admin] = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "tenant_admin")))
      .limit(1);

    const [tenant] = await db
      .select({ name: tenantsTable.name, contactEmail: tenantsTable.contactEmail })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);
    if (!tenant) return;

    const recipient = admin?.email ?? tenant.contactEmail;
    if (!recipient) {
      logger.warn({ tenantId, kind }, "[plan-limit-notify] no recipient — claim consumed without send");
      return;
    }

    const label = humanLimitLabel(kind);
    const periodPhrase = periodKey === "lifetime" ? "" : ` this month (${periodKey})`;
    const upgradeUrl = (
      process.env.PUBLIC_APP_URL ||
      process.env.APP_PUBLIC_URL ||
      (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
      "https://www.l3xy.ai"
    ).replace(/\/$/, "") + "/subscription";

    const subject = `You've hit your ${plan.name} plan limit for ${label}`;
    const text =
`Hi ${admin?.name ?? "there"},

${tenant.name} has reached the ${plan.name} plan limit for ${label}${periodPhrase}: ${current} of ${limit} used.

New requests for this resource will be blocked until ${periodKey === "lifetime" ? "you upgrade your plan or contact sales" : "the next billing period starts"}.

View usage and upgrade options:
${upgradeUrl}

Reply to this email and our team will help you pick the right plan.

— The L3xy team`;

    await sendEmail({
      to: recipient,
      subject,
      text,
      html: plainToHtml(text),
      audit: {
        tenantId,
        actorLabel: "Plan Limit Notifier",
        subjectType: "external",
        subjectLabel: recipient,
        action: `plan_limit.${kind}.notified`,
        metadata: { plan: plan.code, limit, current, periodKey },
      },
    });
  } catch (err) {
    // Non-fatal: notification is best-effort and must not block the gate.
    logger.error({ err, tenantId, kind }, "[plan-limit-notify] failed");
  }
}
