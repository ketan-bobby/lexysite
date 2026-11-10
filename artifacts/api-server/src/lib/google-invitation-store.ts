import { and, eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  staffGoogleCalendarsTable as calendars,
  interviewCalendarInvitationAttemptsTable as attempts,
  usersTable,
  type StaffGoogleCalendar,
  type GoogleInvitationOperation,
} from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import { googleStaffStore } from "./google-staff-store";
import { googleStaffFailure } from "./google-staff-config";
import { googleCandidateInvitationSnapshot } from "./google-invitation-identity";
import { visibleSchedule } from "../routes/outlook-calendar";
import { lockCurrent, requireAttemptStorage } from "../routes/outlook-candidate-invitations";
import { readGoogleInvitationPanel, type GoogleInvitationPanel } from "./google-invitation-panel";
import {
  prepareGooglePanelOperation,
  type PreparedGooglePanelOperation,
} from "./google-panel-operation-availability";

export type GoogleInvitationCaller = Awaited<ReturnType<typeof calendarStaff>>;
export type GoogleInvitationContext = Awaited<ReturnType<typeof visibleSchedule>>;
export type GoogleInvitationAttempt = typeof attempts.$inferSelect;
export type GoogleInvitationReview = {
  context: GoogleInvitationContext;
  connection: StaffGoogleCalendar | undefined;
  attempt: GoogleInvitationAttempt | undefined;
  hoursAllowed: boolean;
  panel?: GoogleInvitationPanel;
};
export type GoogleInvitationActions = {
  insert: (attempt: typeof attempts.$inferInsert) => Promise<GoogleInvitationAttempt>;
  save: (
    attempt: GoogleInvitationAttempt,
    receipt: {
      id: string;
      meetUrl: string | null;
      conferenceStatus: "pending" | "ready" | "failed";
    },
  ) => Promise<void>;
  rotate: (previous: string, next: string) => Promise<void>;
  appendOperation?: (operation: GoogleInvitationOperation) => Promise<void>;
  finishOperation?: (
    id: string,
    receipt?: { meetUrl: string | null; conferenceStatus: "pending" | "ready" | "failed" },
  ) => Promise<void>;
};
export interface GoogleInvitationStore {
  preparePanelAvailability?: (
    caller: GoogleInvitationCaller,
    original: GoogleInvitationReview,
  ) => Promise<PreparedGooglePanelOperation>;
  reconnect: (caller: GoogleInvitationCaller, revision: string) => Promise<void>;
  read: (caller: GoogleInvitationCaller, scheduleId: string) => Promise<GoogleInvitationReview>;
  run: <T>(
    caller: GoogleInvitationCaller,
    original: GoogleInvitationReview,
    fn: (review: GoogleInvitationReview, actions: GoogleInvitationActions) => Promise<T>,
    allowCancelled?: boolean,
  ) => Promise<T>;
}
type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
export function googleInvitationStore(
  database: Pick<typeof dbAdmin, "transaction"> = dbAdmin,
): GoogleInvitationStore {
  async function proof(tx: Tx) {
    await requireAttemptStorage(tx);
    const r = await tx.execute(sql`SELECT count(*)::int AS columns FROM pg_attribute
      WHERE attrelid=to_regclass('staff_google_calendars') AND NOT attisdropped
      AND attname IN ('invitation_consent','flow_invitations') AND atttypid='bool'::regtype AND attnotnull`);
    if (r.rows[0]?.columns !== 2) throw googleStaffFailure();
  }
  async function load(
    tx: Tx,
    caller: GoogleInvitationCaller,
    context: GoogleInvitationContext,
    lock = false,
  ): Promise<GoogleInvitationReview> {
    const panel = await readGoogleInvitationPanel(tx, caller, context, lock);
    const where = and(
      eq(calendars.userId, caller.id),
      eq(calendars.tenantId, caller.tenantId ?? ""),
    );
    const q = tx.select().from(calendars).where(where);
    const [connection] = await (lock ? q.for("update") : q);
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.scheduleId, context.schedule.id));
    const start = context.schedule.scheduledAt.getTime();
    const buffer = panel?.bufferMinutes ?? 0;
    let hoursAllowed = await googleStaffStore(tx).allows(
      { id: caller.id, tenantId: caller.tenantId ?? "" },
      start - buffer * 60_000,
      start + (context.schedule.durationMinutes + buffer) * 60_000,
    );
    if (panel) {
      const members = await tx
        .select({ id: usersTable.id, tenantId: usersTable.tenantId })
        .from(usersTable)
        .where(
          inArray(
            usersTable.id,
            panel.recipients.map((p) => p.userId),
          ),
        );
      if (members.length !== panel.recipients.length) hoursAllowed = false;
      for (const member of members) {
        if (
          !member.tenantId ||
          !(await googleStaffStore(tx).allows(
            { id: member.id, tenantId: member.tenantId },
            start - buffer * 60_000,
            start + (context.schedule.durationMinutes + buffer) * 60_000,
          ))
        )
          hoursAllowed = false;
      }
    }
    return { context, connection, attempt, hoursAllowed, ...(panel ? { panel } : {}) };
  }
  return {
    preparePanelAvailability: (caller, original) =>
      prepareGooglePanelOperation(caller, original, database),
    async reconnect(caller, revision) {
      await database.transaction(async (tx) => {
        await googleStaffStore(tx).clear(
          { id: caller.id, tenantId: caller.tenantId ?? "" },
          revision,
          true,
        );
      });
    },
    async read(caller, scheduleId) {
      // Explicit staff+tenant/assignment authorization precedes private reads.
      const current = await calendarStaff(caller.id);
      if (current.role !== caller.role || current.tenantId !== caller.tenantId)
        throw googleStaffFailure("google_account_changed", 403);
      const context = await visibleSchedule(caller, scheduleId);
      return database.transaction(async (tx) => {
        await proof(tx);
        return load(tx, caller, context);
      });
    },
    async run(caller, original, fn, allowCancelled = false) {
      return database.transaction(async (tx) => {
        await proof(tx);
        const context = await lockCurrent(tx, caller, original.context, allowCancelled);
        await tx.select().from(usersTable).where(eq(usersTable.id, caller.id)).for("share");
        const current = await calendarStaff(caller.id);
        if (current.role !== caller.role || current.tenantId !== caller.tenantId)
          throw googleStaffFailure("google_account_changed", 409);
        const review = await load(tx, caller, context, true);
        return fn(review, {
          async insert(value) {
            const [saved] = await tx.insert(attempts).values(value).returning();
            if (!saved) throw googleStaffFailure();
            return saved;
          },
          async save(attempt, receipt) {
            if (attempt.provider !== "google" || !attempt.googleSnapshot)
              throw googleStaffFailure();
            const [saved] = await tx
              .update(attempts)
              .set({
                status: "accepted",
                eventId: receipt.id,
                acceptedAt: attempt.acceptedAt ?? new Date(),
                googleSnapshot: {
                  ...attempt.googleSnapshot,
                  candidateSnapshotHash: googleCandidateInvitationSnapshot(review, caller),
                  meetUrl: receipt.meetUrl,
                  conferenceStatus: receipt.conferenceStatus,
                },
              })
              .where(
                and(
                  eq(attempts.scheduleId, attempt.scheduleId),
                  eq(attempts.transactionId, attempt.transactionId),
                  eq(attempts.provider, "google"),
                ),
              )
              .returning();
            if (!saved) throw googleStaffFailure();
            review.attempt = saved;
          },
          async rotate(previous, next) {
            if (
              !review.connection ||
              !(await googleStaffStore(tx).rotate(
                { id: caller.id, tenantId: caller.tenantId ?? "" },
                review.connection.revision,
                previous,
                next,
              ))
            )
              throw googleStaffFailure("google_connection_changed", 409);
            review.connection.refreshTokenEnc = next;
          },
          async appendOperation(operation) {
            const a = review.attempt,
              g = a?.googleSnapshot;
            if (!a || a.provider !== "google" || !g || g.operations?.some((o) => !o.acceptedAt))
              throw googleStaffFailure("google_operation_changed", 409);
            const [saved] = await tx
              .update(attempts)
              .set({ googleSnapshot: { ...g, operations: [...(g.operations ?? []), operation] } })
              .where(
                and(
                  eq(attempts.scheduleId, a.scheduleId),
                  eq(attempts.transactionId, a.transactionId),
                  eq(attempts.provider, "google"),
                ),
              )
              .returning();
            if (!saved) throw googleStaffFailure();
            review.attempt = saved;
          },
          async finishOperation(id, receipt) {
            const a = review.attempt,
              g = a?.googleSnapshot,
              latest = g?.operations?.at(-1);
            if (!a || a.provider !== "google" || !g || latest?.id !== id || latest.acceptedAt)
              throw googleStaffFailure("google_operation_changed", 409);
            const [saved] = await tx
              .update(attempts)
              .set({
                googleSnapshot: {
                  ...g,
                  ...(receipt
                    ? { meetUrl: receipt.meetUrl, conferenceStatus: receipt.conferenceStatus }
                    : {}),
                  candidateSnapshotHash: googleCandidateInvitationSnapshot(review, caller),
                  operations: g.operations!.map((o) =>
                    o.id === id ? { ...o, acceptedAt: new Date().toISOString() } : o,
                  ),
                },
              })
              .where(
                and(
                  eq(attempts.scheduleId, a.scheduleId),
                  eq(attempts.transactionId, a.transactionId),
                  eq(attempts.provider, "google"),
                ),
              )
              .returning();
            if (!saved) throw googleStaffFailure();
            review.attempt = saved;
          },
        });
      });
    },
  };
}
