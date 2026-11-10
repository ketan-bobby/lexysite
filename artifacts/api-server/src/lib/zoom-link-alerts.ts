import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, like, notInArray, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  interviewZoomLinksTable as links,
  interviewSchedulesTable as schedules,
  applicationsTable as applications,
  candidatesTable as candidates,
  jobsTable as jobs,
  jobRecruitersTable as recruiters,
  usersTable as users,
  userNotificationsTable as notifications,
  interviewCalendarInvitationAttemptsTable as attempts,
} from "@workspace/db";
import { storage, type PanelSchedule, type PanelTx } from "./calendar-panel-access";
import { assertPanelCoordinator } from "./interview-schedule-panel";
import { requireAttemptStorage } from "../routes/outlook-candidate-invitations";
import { compliantCandidatePredicate } from "./compliance-scope";
import { isJobApproved } from "./job-approval-gate";
import { zoomJoinUrl, zoomSnapshot } from "./staff-zoom-link";
import { CalendarError } from "./outlook-calendar-core";
import { logger } from "./logger";

const TYPE = "zoom_link_stale";
const staffRoles = [
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const prefix = (id: string) => `zoom-stale:${hash(id)}:`;

/** Read receipts double as dedupe receipts: never delete them to resolve an alert. */
export async function retireZoomLinkAlerts(tx: PanelTx, id: string, keep: string[] = []) {
  await tx
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(
        eq(notifications.type, TYPE),
        like(notifications.id, `${prefix(id)}%`),
        ...(keep.length ? [notInArray(notifications.id, keep)] : []),
        eq(notifications.isRead, false),
      ),
    );
}

/** No elapsed-time/private-feedback churn, names, URLs or passcodes in the dedupe evidence. */
export function zoomAlertEvidence(
  row: PanelSchedule,
  saved: typeof links.$inferSelect,
  hasInvitation: boolean,
  publisherAllowed: boolean,
) {
  if (
    !saved.joinUrl ||
    row.schedule.type === "ai_interview" ||
    ["completed", "no_show"].includes(row.schedule.status)
  )
    return null;
  let valid = true;
  try {
    zoomJoinUrl(saved.joinUrl);
  } catch {
    valid = false;
  }
  const snapshot = zoomSnapshot(row);
  if (snapshot === saved.snapshotHash && !hasInvitation && publisherAllowed && valid) return null;
  return hash(
    JSON.stringify([saved.publicationId, snapshot, hasInvitation, publisherAllowed, valid]),
  );
}

/** Shares the native appointment lock with edits/publish/remove; no external side effects. */
export async function reconcileZoomLinkAlerts(tx: PanelTx, id: string) {
  await storage(tx, "interview_zoom_links");
  await requireAttemptStorage(tx);
  await tx.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, id)).for("update");
  const [row] = await tx
    .select({
      schedule: schedules,
      application: applications,
      candidate: candidates,
      job: jobs,
      saved: links,
    })
    .from(schedules)
    .innerJoin(applications, eq(applications.id, schedules.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(links, eq(links.scheduleId, schedules.id))
    .where(
      and(
        eq(schedules.id, id),
        isNull(candidates.dataErasedAt),
        compliantCandidatePredicate(),
        or(eq(schedules.tenantId, applications.tenantId), eq(schedules.tenantId, jobs.tenantId)),
      ),
    )
    .for("share", { of: [applications, candidates, jobs] });
  if (!row || !isJobApproved(row.job.status) || !row.saved.joinUrl) {
    await retireZoomLinkAlerts(tx, id);
    return 0;
  }
  const roster = await tx
    .select({ id: recruiters.recruiterUserId })
    .from(recruiters)
    .where(and(eq(recruiters.jobId, row.job.id), eq(recruiters.tenantId, row.job.tenantId)));
  const ids = [
    ...new Set(
      [
        row.saved.publisherId,
        row.schedule.interviewerId,
        row.job.assignedRecruiterId,
        ...roster.map((person) => person.id),
      ].filter((value): value is string => !!value),
    ),
  ];
  const people = await tx
    .select()
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        eq(users.status, "active"),
        isNull(users.accountErasedAt),
        inArray(users.role, staffRoles as Array<typeof users.$inferSelect.role>),
      ),
    )
    .for("share");
  const allowed: typeof people = [];
  for (const person of people) {
    try {
      await assertPanelCoordinator(person, row, tx);
      allowed.push(person);
    } catch (error) {
      // Expected authorization denial is safe to suppress; database failures retry next sweep.
      if (!(error instanceof CalendarError)) throw error;
    }
  }
  const [attempt] = await tx
    .select({ id: attempts.scheduleId })
    .from(attempts)
    .where(eq(attempts.scheduleId, id));
  const evidence = zoomAlertEvidence(
    row,
    row.saved,
    !!attempt,
    allowed.some((person) => person.id === row.saved.publisherId),
  );
  const pending = evidence
    ? allowed.map((person) => ({
        id: `${prefix(id)}${hash(`${evidence}:${person.id}`)}`,
        userId: person.id,
        tenantId: person.tenantId,
        type: TYPE,
        title: "Staff-provided Zoom link needs review",
        message:
          "A published staff-provided meeting link no longer matches the current appointment or meeting setup. Open Scheduling to review it. Lexy has not changed or cancelled the meeting in Zoom.",
        actionUrl: "/coordinator",
      }))
    : [];
  await retireZoomLinkAlerts(
    tx,
    id,
    pending.map((item) => item.id),
  );
  if (!pending.length) return 0;
  const inserted = await tx
    .insert(notifications)
    .values(pending)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return inserted.length;
}

/** Bounded keyset pages eventually cover every publication without starving later records. */
export async function sweepZoomLinkAlerts(
  database: Pick<typeof dbAdmin, "transaction"> = dbAdmin,
  cursor = "",
) {
  const batch = await database.transaction(async (tx) => {
    await storage(tx, "interview_zoom_links");
    return tx
      .select({ id: links.scheduleId })
      .from(links)
      .where(and(isNotNull(links.joinUrl), gt(links.scheduleId, cursor)))
      .orderBy(links.scheduleId)
      .limit(100);
  });
  let failed = 0;
  for (const row of batch) {
    try {
      await database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
        await reconcileZoomLinkAlerts(tx, row.id);
      });
    } catch {
      failed++;
    }
  }
  if (failed)
    logger.warn({ failed }, "Zoom link alert reconciliation will retry; private payloads omitted");
  return batch.length === 100 ? batch[batch.length - 1]!.id : "";
}

export function startZoomLinkAlertScheduler() {
  let running = false,
    cursor = "";
  const run = async () => {
    if (running) return;
    running = true;
    try {
      cursor = await sweepZoomLinkAlerts(dbAdmin, cursor);
    } catch {
      logger.warn("Zoom link alert scan unavailable; will retry without external side effects");
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), 60_000).unref();
}
