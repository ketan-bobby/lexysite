import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  dbAdmin,
  staffGoogleCalendarsTable as table,
  calendarWorkingHoursTable as hours,
  type StaffGoogleCalendar,
} from "@workspace/db";
import { workingHoursPolicy } from "./calendar-working-hours";

export type GoogleStaffActor = { id: string; tenantId: string };
export const clearedGoogleFlow = {
  flowInvitations: false,
  flowHash: null,
  browserHash: null,
  verifierEnc: null,
  nonceHash: null,
  flowExpiresAt: null,
};
export const clearedGoogleGrant = {
  invitationConsent: false,
  subject: null,
  accountEmail: null,
  refreshTokenEnc: null,
  connectedAt: null,
};
type Flow = Pick<
  StaffGoogleCalendar,
  | "revision"
  | "clientFingerprint"
  | "flowHash"
  | "browserHash"
  | "verifierEnc"
  | "nonceHash"
  | "flowExpiresAt"
  | "flowInvitations"
>;
type Grant = Pick<
  StaffGoogleCalendar,
  "subject" | "accountEmail" | "refreshTokenEnc" | "connectedAt" | "invitationConsent"
>;
export interface GoogleStaffStore {
  get(actor: GoogleStaffActor): Promise<StaffGoogleCalendar | undefined>;
  begin(actor: GoogleStaffActor, flow: Flow): Promise<void>;
  consume(
    actor: GoogleStaffActor,
    stateHash: string,
    browserHash: string,
    now: Date,
  ): Promise<StaffGoogleCalendar | undefined>;
  bind(actor: GoogleStaffActor, revision: string, grant: Grant): Promise<boolean>;
  clear(actor: GoogleStaffActor, revision: string, reconnect?: boolean): Promise<boolean>;
  rotate(
    actor: GoogleStaffActor,
    revision: string,
    previous: string,
    next: string,
  ): Promise<boolean>;
  allows(actor: GoogleStaffActor, start: number, end: number): Promise<boolean>;
}
/** Admin-pool storage always repeats BOTH self and employer predicates. */
export function googleStaffStore(
  database: Pick<typeof dbAdmin, "select" | "insert" | "update" | "transaction"> = dbAdmin,
): GoogleStaffStore {
  const owned = (actor: GoogleStaffActor) =>
    and(eq(table.userId, actor.id), eq(table.tenantId, actor.tenantId));
  return {
    async get(actor) {
      return (await database.select().from(table).where(owned(actor)).limit(1))[0];
    },
    async begin(actor, flow) {
      await database
        .insert(table)
        .values({
          userId: actor.id,
          tenantId: actor.tenantId,
          ...flow,
          ...clearedGoogleGrant,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: table.userId,
          set: {
            tenantId: actor.tenantId,
            ...flow,
            ...clearedGoogleGrant,
            needsReconnect: false,
            updatedAt: new Date(),
          },
        });
    },
    async consume(actor, stateHash, browserHash, now) {
      // UPDATE RETURNING is the replay fence; it consumes before token exchange.
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(table)
          .where(
            and(
              owned(actor),
              eq(table.flowHash, stateHash),
              eq(table.browserHash, browserHash),
              gt(table.flowExpiresAt, now),
            ),
          )
          .for("update");
        if (!row) return undefined;
        await tx
          .update(table)
          .set({ ...clearedGoogleFlow, updatedAt: new Date() })
          .where(and(owned(actor), eq(table.revision, row.revision)));
        return row;
      });
    },
    async bind(actor, revision, grant) {
      return (
        (
          await database
            .update(table)
            .set({
              ...grant,
              ...clearedGoogleFlow,
              needsReconnect: false,
              revision: randomUUID(),
              updatedAt: new Date(),
            })
            .where(and(owned(actor), eq(table.revision, revision), isNull(table.flowHash)))
            .returning({ id: table.userId })
        ).length === 1
      );
    },
    async clear(actor, revision, reconnect = false) {
      return (
        (
          await database
            .update(table)
            .set({
              ...clearedGoogleGrant,
              ...clearedGoogleFlow,
              needsReconnect: reconnect,
              revision: randomUUID(),
              updatedAt: new Date(),
            })
            .where(and(owned(actor), eq(table.revision, revision)))
            .returning({ id: table.userId })
        ).length === 1
      );
    },
    async rotate(actor, revision, previous, next) {
      return (
        (
          await database
            .update(table)
            .set({ refreshTokenEnc: next, updatedAt: new Date() })
            .where(
              and(owned(actor), eq(table.revision, revision), eq(table.refreshTokenEnc, previous)),
            )
            .returning({ id: table.userId })
        ).length === 1
      );
    },
    async allows(actor, start, end) {
      const [row] = await database
        .select()
        .from(hours)
        .where(and(eq(hours.userId, actor.id), eq(hours.tenantId, actor.tenantId)))
        .limit(1);
      // Matches the existing working-hours module: no saved policy is not an
      // invented default workweek. Explicit empty windows remain unavailable.
      return row ? workingHoursPolicy(row.timeZone, row.windows).allows(start, end) : true;
    },
  };
}
