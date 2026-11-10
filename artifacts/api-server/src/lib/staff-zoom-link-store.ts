import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  dbAdmin,
  interviewZoomLinksTable as links,
  interviewSchedulesTable as schedules,
  applicationsTable as applications,
  candidatesTable as candidates,
  jobsTable as jobs,
  usersTable as users,
  interviewCalendarInvitationAttemptsTable as attempts,
  interviewZoomMeetingsTable as managedMeetings,
} from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import {
  storage,
  type PanelCaller,
  type PanelSchedule,
  type PanelTx,
} from "./calendar-panel-access";
import { visibleSchedule } from "../routes/outlook-calendar";
import { lockCurrent, requireAttemptStorage } from "../routes/outlook-candidate-invitations";
import { scheduleVersion } from "./coordinator-schedule-version";
import { compliantCandidatePredicate } from "./compliance-scope";
import type { CandidateSession } from "./portal-auth";
import type { StaffZoomLinkView, CandidateZoomLinkView } from "@workspace/api-zod";
import {
  zoomJoinUrl,
  zoomSnapshot,
  zoomLinkReason,
  zoomChanged,
  zoomReviewToken,
  assertZoomApproval,
  zoomDraft,
  zoomApproval,
  zoomRemoval,
} from "./staff-zoom-link";
import { CalendarError } from "./outlook-calendar-core";
import { retireZoomLinkAlerts } from "./zoom-link-alerts";

type Saved = typeof links.$inferSelect;
type Draft = ReturnType<typeof zoomDraft.parse>;
type Approval = ReturnType<typeof zoomApproval.parse>;
type Removal = ReturnType<typeof zoomRemoval.parse>;
async function state(tx: PanelTx, row: PanelSchedule) {
  await storage(tx, "interview_zoom_links");
  await requireAttemptStorage(tx);
  const [saved] = await tx.select().from(links).where(eq(links.scheduleId, row.schedule.id));
  const [attempt] = await tx
    .select({ id: attempts.scheduleId })
    .from(attempts)
    .where(eq(attempts.scheduleId, row.schedule.id));
  return { saved, hasInvitation: !!attempt };
}
function currentLink(row: PanelSchedule, saved: Saved | undefined, hasInvitation: boolean) {
  if (
    !saved?.joinUrl ||
    zoomLinkReason(row, hasInvitation) ||
    saved.applicationId !== row.application.id ||
    saved.candidateId !== row.candidate.id ||
    saved.snapshotHash !== zoomSnapshot(row)
  )
    return null;
  try {
    return zoomJoinUrl(saved.joinUrl);
  } catch {
    return null;
  }
}
function view(
  row: PanelSchedule,
  saved: Saved | undefined,
  hasInvitation: boolean,
): StaffZoomLinkView {
  const current = currentLink(row, saved, hasInvitation);
  return {
    scheduleId: row.schedule.id,
    version: scheduleVersion(row.schedule),
    publicationId: saved?.publicationId ?? null,
    scheduledAt: row.schedule.scheduledAt,
    durationMinutes: row.schedule.durationMinutes,
    jobTitle: row.job.title,
    state: saved?.joinUrl ? (current ? "published" : "stale") : "none",
    reason: zoomLinkReason(row, hasInvitation),
    canPublish: !zoomLinkReason(row, hasInvitation),
    joinUrl: saved?.joinUrl ? zoomJoinUrl(saved.joinUrl) : null,
    approvedAt: saved?.approvedAt ?? null,
    approvalToken: null,
    reviewExpiresAt: null,
    providerVerified: false,
  };
}
function compare(row: PanelSchedule, saved: Saved | undefined, input: Draft | Removal) {
  if (
    input.expectedVersion !== scheduleVersion(row.schedule) ||
    input.expectedPublicationId !== (saved?.publicationId ?? null)
  )
    throw zoomChanged();
}
function key() {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!secret) throw new CalendarError(503, "zoom_setup_required", "Link approval is unavailable.");
  return secret;
}
export function staffZoomLinkStore(database: Pick<typeof dbAdmin, "transaction"> = dbAdmin) {
  async function authorized(caller: PanelCaller, id: string, cleanup = false) {
    const actor = await calendarStaff(caller.id);
    if (actor.accountErasedAt || actor.tenantId !== caller.tenantId || actor.role !== caller.role)
      throw zoomChanged();
    // Cleanup reads retain tenant/ownership checks but work for cancelled/completed appointments.
    const row = await visibleSchedule(actor, id, true);
    if (!cleanup && (row.candidate.dataErasedAt || row.candidate.doNotContact))
      throw new CalendarError(404, "schedule_not_found", "Appointment not found.");
    return row;
  }
  return {
    async read(caller: PanelCaller, id: string) {
      const row = await authorized(caller, id);
      return database.transaction(async (tx) => {
        const { saved, hasInvitation } = await state(tx, row);
        return view(row, saved, hasInvitation);
      });
    },
    async review(caller: PanelCaller, id: string, input: Draft) {
      const url = zoomJoinUrl(input.joinUrl),
        row = await authorized(caller, id);
      return database.transaction(async (tx) => {
        const { saved, hasInvitation } = await state(tx, row);
        compare(row, saved, input);
        if (zoomLinkReason(row, hasInvitation)) throw zoomChanged();
        const [managed] = await tx
          .select({ status: managedMeetings.status })
          .from(managedMeetings)
          .where(eq(managedMeetings.scheduleId, id))
          .limit(1);
        if (managed && managed.status !== "cancelled") throw zoomChanged();
        const expires = new Date(Date.now() + 10 * 60_000).toISOString();
        return {
          ...view(row, saved, hasInvitation),
          joinUrl: url,
          reviewExpiresAt: expires,
          approvalToken: zoomReviewToken(
            key(),
            caller.id,
            zoomSnapshot(row),
            scheduleVersion(row.schedule),
            saved?.publicationId ?? null,
            url,
            expires,
          ),
        };
      });
    },
    async publish(caller: PanelCaller, id: string, input: Approval) {
      const url = zoomJoinUrl(input.joinUrl),
        original = await authorized(caller, id);
      return database.transaction(async (tx) => {
        // Serializes with native edits and both existing calendar invitation senders.
        const row = await lockCurrent(tx, caller, original);
        await authorized(caller, id);
        const { saved, hasInvitation } = await state(tx, row);
        compare(row, saved, input);
        if (zoomLinkReason(row, hasInvitation)) throw zoomChanged();
        const [managed] = await tx
          .select({ status: managedMeetings.status })
          .from(managedMeetings)
          .where(eq(managedMeetings.scheduleId, id))
          .limit(1);
        if (managed && managed.status !== "cancelled") throw zoomChanged();
        const token = zoomReviewToken(
          key(),
          caller.id,
          zoomSnapshot(row),
          scheduleVersion(row.schedule),
          saved?.publicationId ?? null,
          url,
          input.reviewExpiresAt,
        );
        assertZoomApproval(token, input.approvalToken, input.reviewExpiresAt, Date.now());
        const values = {
          publicationId: randomUUID(),
          publisherId: caller.id,
          applicationId: row.application.id,
          candidateId: row.candidate.id,
          snapshotHash: zoomSnapshot(row),
          joinUrl: url,
          approvedAt: new Date(),
        };
        const [next] = await tx
          .insert(links)
          .values({ scheduleId: id, ...values })
          .onConflictDoUpdate({ target: links.scheduleId, set: values })
          .returning();
        await retireZoomLinkAlerts(tx, id);
        return view(row, next, false);
      });
    },
    async remove(caller: PanelCaller, id: string, input: Removal) {
      const original = await authorized(caller, id, true);
      return database.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(schedules)
          .where(eq(schedules.id, id))
          .for("update");
        if (!locked || scheduleVersion(locked) !== scheduleVersion(original.schedule))
          throw zoomChanged();
        const row = await authorized(caller, id, true);
        const { saved, hasInvitation } = await state(tx, row);
        compare(row, saved, input);
        if (!saved) throw zoomChanged();
        const [next] = await tx
          .update(links)
          .set({
            joinUrl: null,
            approvedAt: null,
            publicationId: randomUUID(),
            publisherId: caller.id,
          })
          .where(and(eq(links.scheduleId, id), eq(links.publicationId, saved.publicationId)))
          .returning();
        if (!next) throw zoomChanged();
        await retireZoomLinkAlerts(tx, id);
        return view(row, next, hasInvitation);
      });
    },
  };
}

export async function candidateZoomLink(
  self: CandidateSession,
  id: string,
): Promise<CandidateZoomLinkView | null> {
  return dbAdmin.transaction(async (tx) => {
    await storage(tx, "interview_zoom_links");
    const [row] = await tx
      .select({
        schedule: schedules,
        application: applications,
        candidate: candidates,
        job: jobs,
        saved: links,
        publisher: users,
        managed: managedMeetings,
      })
      .from(schedules)
      .innerJoin(applications, eq(applications.id, schedules.applicationId))
      .innerJoin(candidates, eq(candidates.id, applications.candidateId))
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .leftJoin(links, eq(links.scheduleId, schedules.id))
      .leftJoin(managedMeetings, eq(managedMeetings.scheduleId, schedules.id))
      .leftJoin(users, eq(users.id, links.publisherId))
      .where(
        and(
          eq(schedules.id, id),
          eq(applications.candidateId, self.candidateId),
          eq(candidates.userId, self.userId),
          isNull(candidates.dataErasedAt),
          compliantCandidatePredicate(),
          or(eq(schedules.tenantId, applications.tenantId), eq(schedules.tenantId, jobs.tenantId)),
        ),
      )
      .limit(1)
      .for("share", { of: [schedules, applications, candidates, jobs] });
    if (!row) return null;
    const managed = row.managed;
    if (
      managed?.status === "confirmed" &&
      managed.joinUrl &&
      managed.candidateId === self.candidateId &&
      managed.tenantId === row.schedule.tenantId &&
      managed.snapshotHash === zoomSnapshot(row) &&
      !zoomLinkReason(row, false)
    ) {
      const [host] = await tx.select().from(users).where(eq(users.id, managed.hostUserId)).limit(1);
      if (host?.status === "active" && !host.accountErasedAt) {
        const { assertPanelCoordinator } = await import("./interview-schedule-panel");
        try {
          await assertPanelCoordinator(host, row, tx);
          return {
            scheduleId: id,
            status: "available",
            joinUrl: zoomJoinUrl(managed.joinUrl),
            providerVerified: true,
            source: "zoom_api",
          };
        } catch {
          // Former coordinators' meeting links are not candidate-visible.
        }
      }
    }
    if (managed && managed.status !== "cancelled") {
      return {
        scheduleId: id,
        status: "unavailable",
        joinUrl: null,
        providerVerified: false,
        source: "staff_provided",
      };
    }
    const { hasInvitation } = await state(tx, row);
    let url = currentLink(row, row.saved ?? undefined, hasInvitation);
    // Publication belongs to a currently active, authorized coordinating staff member.
    if (
      !row.publisher ||
      row.publisher.accountErasedAt ||
      row.publisher.status !== "active" ||
      ![
        "platform_admin",
        "tenant_admin",
        "recruiter_admin",
        "recruiter",
        "hiring_manager",
        "interviewer",
      ].includes(row.publisher.role)
    )
      url = null;
    if (url && row.publisher) {
      const { assertPanelCoordinator } = await import("./interview-schedule-panel");
      try {
        await assertPanelCoordinator(row.publisher, row, tx);
      } catch {
        url = null;
      }
    }
    return {
      scheduleId: id,
      status: url ? "available" : "unavailable",
      joinUrl: url,
      providerVerified: false,
      source: "staff_provided",
    };
  });
}
