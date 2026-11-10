import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  dbAdmin,
  googlePanelConsentsTable as consents,
  staffGoogleCalendarsTable as grants,
  usersTable as users,
  calendarWorkingHoursTable as hours,
  interviewSchedulesTable,
  applicationsTable,
  jobsTable,
  candidatesTable,
  interviewSchedulePanelsTable as panels,
} from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import { visibleSchedule } from "../routes/outlook-calendar";
import {
  storage,
  memberAllowed,
  unavailable,
  type PanelCaller,
  type PanelTx,
  type PanelSchedule,
} from "./calendar-panel-access";
import { scheduleVersion, scheduleSnapshotPredicate } from "./coordinator-schedule-version";
import { lockPanelSchedule, assertPanelCoordinator } from "./interview-schedule-panel";
import { savedPanelView, readSchedulePanel } from "./saved-panel-view";
import {
  googlePanelBinding,
  assertGooglePanelBindings,
  savedPanelProvider,
} from "./saved-panel-members";
import { isJobApproved } from "./job-approval-gate";
import { CalendarError } from "./outlook-calendar-core";
import { workingHoursPolicy } from "./calendar-working-hours";
import { googleStaffConfig, googleStaffFailure } from "./google-staff-config";
import { googleStaffProvider } from "./google-staff-provider";
import { openGoogleCredential, sealGoogleCredential } from "./google-staff-service";
import { googleStaffStore } from "./google-staff-store";
import { readGooglePanelCalendar } from "./google-panel-freebusy";
import {
  googlePanelShared,
  googlePanelConsentView,
  googlePanelUnknown,
  searchGooglePanelTimes,
  type GooglePanelPerson,
  type GooglePanelInput,
  type GooglePanelSnapshot,
} from "./google-panel-times";

function config() {
  const cfg = googleStaffConfig();
  if (!cfg) throw googleStaffFailure("google_setup_required", 503);
  return cfg;
}
export interface GooglePanelSaveInput {
  expectedVersion: string;
  userIds: string[];
  scheduledAt: string;
  bufferMinutes: number;
}
function assertGoogleProvider(members: unknown) {
  if (savedPanelProvider(members) === "outlook")
    throw new CalendarError(
      409,
      "panel_provider_conflict",
      "Remove the saved Outlook panel with its own controls before saving a Google panel.",
    );
}
async function ready(tx: PanelTx) {
  await storage(tx, "google_panel_consents");
  await storage(tx, "staff_google_calendars");
}
async function currentCaller(caller: PanelCaller) {
  const current = await calendarStaff(caller.id);
  if (
    current.accountErasedAt ||
    current.tenantId !== caller.tenantId ||
    current.role !== caller.role
  )
    throw unavailable();
  return current;
}
function ownView(
  caller: PanelCaller,
  grant: GooglePanelPerson["connection"] | undefined,
  consent: GooglePanelPerson["consent"] | undefined,
) {
  return googlePanelConsentView(
    { ...caller, name: caller.name || "Staff member" },
    grant,
    consent,
    googleStaffConfig()?.fingerprint ?? null,
  );
}
export function googlePanelRepository() {
  async function own(
    caller: PanelCaller,
    change?: { enabled: boolean; expectedRevision: string; confirmShare?: boolean },
  ) {
    return dbAdmin.transaction(async (tx) => {
      await ready(tx);
      await tx.select({ id: users.id }).from(users).where(eq(users.id, caller.id)).for("share");
      await currentCaller(caller);
      const [grant] = await tx
        .select()
        .from(grants)
        .where(and(eq(grants.userId, caller.id), eq(grants.tenantId, caller.tenantId ?? "")))
        .for("update");
      const [consent] = await tx
        .select()
        .from(consents)
        .where(and(eq(consents.userId, caller.id), eq(consents.tenantId, caller.tenantId ?? "")))
        .for("update");
      if (!change) return ownView(caller, grant, consent);
      if (!grant || grant.revision !== change.expectedRevision) throw unavailable();
      if (!change.enabled) {
        await tx
          .delete(consents)
          .where(and(eq(consents.userId, caller.id), eq(consents.tenantId, caller.tenantId ?? "")));
        return ownView(caller, grant, undefined);
      }
      if (change.confirmShare !== true)
        throw new CalendarError(
          400,
          "sharing_acknowledgement_required",
          "Explicitly confirm sharing common availability.",
        );
      if (!ownView(caller, grant, consent).canEnable || !caller.tenantId) throw unavailable();
      const [saved] = await tx
        .insert(consents)
        .values({
          userId: caller.id,
          tenantId: caller.tenantId,
          connectionRevision: grant.revision,
          grantedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: consents.userId,
          set: {
            tenantId: caller.tenantId,
            connectionRevision: grant.revision,
            grantedAt: new Date(),
          },
        })
        .returning();
      return ownView(caller, grant, saved);
    });
  }
  async function withPanel<T>(
    caller: PanelCaller,
    scheduleId: string,
    selected: string[] | undefined,
    expectedVersion: string | undefined,
    work: (snapshot: GooglePanelSnapshot, tx: PanelTx, row: PanelSchedule) => Promise<T>,
    options: { tx?: PanelTx; write?: boolean; lockPeople?: boolean } = {},
  ) {
    const run = async (tx: PanelTx) => {
      const cfg = config();
      if (caller.role === "interviewer")
        throw new CalendarError(
          403,
          "coordinator_required",
          "Coordinating staff access is required.",
        );
      // Internal confirmation already has an owner-scoped administrative tx.
      // Its ambient request is a candidate, so do not read staff schedules
      // through the candidate's narrow request-role database connection.
      const readCurrent = async () => {
        const actor = await currentCaller(caller);
        if (!options.tx) return visibleSchedule(actor, scheduleId);
        const row = await lockPanelSchedule(tx, scheduleId);
        await assertPanelCoordinator(actor, row, tx);
        return row;
      };
      const first = await readCurrent();
      // Lock the native scope before reading any staff grant.
      await tx
        .select({ id: interviewSchedulesTable.id })
        .from(interviewSchedulesTable)
        .where(eq(interviewSchedulesTable.id, first.schedule.id))
        .for(options.write ? "update" : "share");
      await tx
        .select({ id: applicationsTable.id })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, first.application.id))
        .for("share");
      await tx
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(eq(jobsTable.id, first.job.id))
        .for("share");
      await tx
        .select({ id: candidatesTable.id })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, first.candidate.id))
        .for("share");
      await tx.select({ id: users.id }).from(users).where(eq(users.id, caller.id)).for("share");
      const row = await readCurrent();
      if (
        !isJobApproved(row.job.status) ||
        row.schedule.type === "ai_interview" ||
        !["pending", "scheduled", "rescheduled", "confirmed"].includes(row.schedule.status) ||
        row.schedule.scheduledAt.getTime() <= Date.now()
      )
        throw new CalendarError(
          404,
          "schedule_not_found",
          "An upcoming authorised human interview is required.",
        );
      const version = scheduleVersion(row.schedule);
      if (expectedVersion && version !== expectedVersion) throw unavailable();
      await ready(tx);
      const tenants = [
        ...new Set([caller.tenantId, row.job.tenantId].filter((s): s is string => !!s)),
      ];
      if (selected && options.lockPeople !== false) {
        // Same lock order as own-consent changes: users -> grants -> consents.
        // Do not depend on the planner's row-mark order for a multi-table join.
        await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, selected), inArray(users.tenantId, tenants)))
          .orderBy(users.id)
          .for("share");
        await tx
          .select({ id: grants.userId })
          .from(grants)
          .where(and(inArray(grants.userId, selected), inArray(grants.tenantId, tenants)))
          .orderBy(grants.userId)
          .for("share");
        await tx
          .select({ id: consents.userId })
          .from(consents)
          .where(and(inArray(consents.userId, selected), inArray(consents.tenantId, tenants)))
          .orderBy(consents.userId)
          .for("share");
      }
      const rows = await tx
        .select({
          member: {
            id: users.id,
            tenantId: users.tenantId,
            role: users.role,
            status: users.status,
            accountErasedAt: users.accountErasedAt,
            name: users.name,
          },
          connection: grants,
          consent: consents,
        })
        .from(users)
        .innerJoin(grants, and(eq(grants.userId, users.id), eq(grants.tenantId, users.tenantId)))
        .innerJoin(
          consents,
          and(eq(consents.userId, users.id), eq(consents.tenantId, users.tenantId)),
        )
        .where(
          and(
            inArray(users.tenantId, tenants),
            eq(users.status, "active"),
            isNull(users.accountErasedAt),
            selected ? inArray(users.id, selected) : undefined,
          ),
        )
        .orderBy(users.id)
        .limit(101);
      if (rows.length > 100)
        throw new CalendarError(
          409,
          "panel_directory_large",
          "Narrow the panel directory with your administrator.",
        );
      const people: GooglePanelPerson[] = [];
      for (const person of rows)
        if (
          googlePanelShared(person, cfg.fingerprint) &&
          (await memberAllowed(person.member, row, tx))
        )
          people.push(person);
      let allows = (_a: number, _b: number) => false;
      if (selected && people.length) {
        await storage(tx, "calendar_working_hours");
        const preferences = await tx
          .select()
          .from(hours)
          .where(
            inArray(
              hours.userId,
              people.map((p) => p.member.id),
            ),
          )
          .for("share");
        const policies = people.map((p) => {
          const pref = preferences.find(
            (h) => h.userId === p.member.id && h.tenantId === p.member.tenantId,
          );
          return pref
            ? workingHoursPolicy(pref.timeZone, pref.windows)
            : workingHoursPolicy(null, []);
        });
        allows = (a, b) => policies.every((p) => p.allows(a, b));
      }
      const result = await work(
        {
          scheduleId,
          version,
          durationMinutes: row.schedule.durationMinutes,
          people,
          allows,
        },
        tx,
        row,
      );
      const latest = await readCurrent();
      if (scheduleVersion(latest.schedule) !== version || config().fingerprint !== cfg.fingerprint)
        throw unavailable();
      for (const person of people)
        if (!(await memberAllowed(person.member, latest, tx))) throw unavailable();
      return result;
    };
    return options.tx ? run(options.tx) : dbAdmin.transaction(run);
  }
  async function runTimes(
    caller: PanelCaller,
    id: string,
    input: GooglePanelInput,
    options: {
      tx?: PanelTx;
      bindings?: unknown;
      save?: GooglePanelSaveInput;
      duration?: number;
    } = {},
  ) {
    const cfg = config();
    let nativeResult: Awaited<ReturnType<typeof savedPanelView>> | undefined;
    const checkedSnapshot = async (s: GooglePanelSnapshot, tx: PanelTx, row: PanelSchedule) => {
      if (options.bindings) assertGooglePanelBindings(options.bindings, s.people);
      if (options.save) {
        const saved = await readSchedulePanel(tx, row);
        assertGoogleProvider(saved?.members ?? []);
      }
      if (
        (options.save || options.bindings) &&
        row.schedule.interviewerId &&
        !input.userIds.includes(row.schedule.interviewerId)
      )
        throw new CalendarError(
          409,
          "assigned_interviewer_required",
          "Include the assigned interviewer in the panel.",
        );
      return { ...s, durationMinutes: options.duration ?? s.durationMinutes };
    };
    const times = await searchGooglePanelTimes(input, {
      fingerprint: cfg.fingerprint,
      minimumNoticeMinutes: options.bindings ? 0 : 15,
      snapshot: () =>
        withPanel(caller, id, input.userIds, input.expectedVersion, checkedSnapshot, {
          tx: options.tx,
          lockPeople: false,
        }),
      locked: (work) =>
        withPanel(
          caller,
          id,
          input.userIds,
          input.expectedVersion,
          async (s, tx, row) => {
            const current = await checkedSnapshot(s, tx, row);
            const result = await work({
              ...current,
              allows: (a, b) =>
                s.allows(a - input.bufferMinutes * 60000, b + input.bufferMinutes * 60000),
            });
            if (!options.save) return result;
            if (
              !result.slots.some((slot) => Date.parse(slot.start) === Date.parse(input.start)) ||
              Date.parse(input.start) <= Date.now()
            )
              throw new CalendarError(
                409,
                "panel_conflict",
                "This time is no longer available for the panel.",
              );
            nativeResult = await persistGooglePanel(tx, row, caller, options.save, s.people);
            return result;
          },
          { tx: options.tx, write: !!options.save },
        ),
      async refresh(p) {
        const actor = { id: p.member.id, tenantId: p.member.tenantId! };
        const encrypted = p.connection.refreshTokenEnc!;
        const token = await googleStaffProvider(cfg).refresh(
          openGoogleCredential(actor, "refresh", encrypted),
        );
        if (
          token.refreshToken &&
          !(await googleStaffStore().rotate(
            actor,
            p.connection.revision,
            encrypted,
            sealGoogleCredential(actor, "refresh", token.refreshToken),
          ))
        )
          throw googlePanelUnknown();
        return token.accessToken;
      },
      read: readGooglePanelCalendar,
    });
    return { times, saved: nativeResult };
  }
  async function persistGooglePanel(
    tx: PanelTx,
    row: PanelSchedule,
    caller: PanelCaller,
    input: GooglePanelSaveInput,
    people: GooglePanelPerson[],
  ) {
    const revision = randomUUID();
    const [schedule] = await tx
      .update(interviewSchedulesTable)
      .set({
        scheduledAt: new Date(input.scheduledAt),
        status: "pending",
        panelRevision: revision,
      })
      .where(scheduleSnapshotPredicate(row.schedule))
      .returning();
    if (!schedule) throw unavailable();
    const values = {
      scheduleId: schedule.id,
      revision,
      coordinatorId: caller.id,
      bufferMinutes: input.bufferMinutes,
      members: people.map(googlePanelBinding),
      savedAt: new Date(),
    };
    await tx
      .insert(panels)
      .values(values)
      .onConflictDoUpdate({ target: panels.scheduleId, set: values });
    return savedPanelView(tx, { ...row, schedule }, caller.tenantId);
  }
  return {
    consent: own,
    members: (caller: PanelCaller, id: string) =>
      withPanel(caller, id, undefined, undefined, async (s) => ({
        scheduleId: s.scheduleId,
        version: s.version,
        members: s.people.map((p) => ({ id: p.member.id, name: p.member.name || "Staff member" })),
      })),
    times: async (caller: PanelCaller, id: string, input: GooglePanelInput) =>
      (await runTimes(caller, id, input)).times,
    async saved(caller: PanelCaller, id: string) {
      await visibleSchedule(await currentCaller(caller), id);
      return dbAdmin.transaction(async (tx) => {
        const row = await lockPanelSchedule(tx, id);
        await tx.select({ id: users.id }).from(users).where(eq(users.id, caller.id)).for("share");
        await assertPanelCoordinator(await currentCaller(caller), row);
        return savedPanelView(tx, row, caller.tenantId);
      });
    },
    async save(caller: PanelCaller, id: string, input: GooglePanelSaveInput) {
      const visible = await visibleSchedule(await currentCaller(caller), id);
      if (!input.userIds.length) {
        // Deliberate withdrawal must not require a working Google connection.
        return dbAdmin.transaction(async (tx) => {
          const row = await lockPanelSchedule(tx, visible.schedule.id);
          await tx.select({ id: users.id }).from(users).where(eq(users.id, caller.id)).for("share");
          await assertPanelCoordinator(await currentCaller(caller), row);
          if (scheduleVersion(row.schedule) !== input.expectedVersion) throw unavailable();
          const saved = await readSchedulePanel(tx, row);
          assertGoogleProvider(saved?.members ?? []);
          if (
            Date.parse(input.scheduledAt) !== row.schedule.scheduledAt.getTime() ||
            input.bufferMinutes !== 0 ||
            row.schedule.scheduledAt.getTime() <= Date.now()
          )
            throw new CalendarError(
              400,
              "invalid_removal",
              "Remove the panel without changing the saved future time, with zero buffer.",
            );
          return persistGooglePanel(tx, row, caller, input, []);
        });
      }
      const start = input.scheduledAt;
      const result = await runTimes(
        caller,
        id,
        {
          expectedVersion: input.expectedVersion,
          userIds: input.userIds,
          start,
          end: new Date(Date.parse(start) + visible.schedule.durationMinutes * 60000).toISOString(),
          bufferMinutes: input.bufferMinutes,
        },
        { save: input },
      );
      if (!result.saved) throw googlePanelUnknown();
      return result.saved;
    },
    async assertSaved(
      tx: PanelTx,
      row: PanelSchedule,
      caller: PanelCaller,
      saved: typeof panels.$inferSelect,
      start: string,
      duration: number,
    ) {
      const { times: result } = await runTimes(
        caller,
        row.schedule.id,
        {
          expectedVersion: scheduleVersion(row.schedule),
          userIds: saved.members.map((m) => m.userId),
          start,
          end: new Date(Date.parse(start) + duration * 60000).toISOString(),
          bufferMinutes: saved.bufferMinutes,
        },
        { tx, bindings: saved.members, duration },
      );
      if (
        !result.slots.some((slot) => Date.parse(slot.start) === Date.parse(start)) ||
        Date.parse(start) <= Date.now()
      )
        throw new CalendarError(409, "panel_conflict", "The panel time must be reviewed again.");
    },
  };
}
