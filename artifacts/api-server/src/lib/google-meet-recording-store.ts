import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  dbAdmin,
  staffGoogleMeetRecordingsTable as table,
  type StaffGoogleMeetRecording as Row,
} from "@workspace/db";
import type { GoogleStaffActor as Actor } from "./google-staff-store";

export const clearedMeetFlow = {
  flowHash: null,
  browserHash: null,
  verifierEnc: null,
  nonceHash: null,
  flowExpiresAt: null,
};
export const clearedMeetGrant = {
  subject: null,
  accountEmail: null,
  refreshTokenEnc: null,
  connectedAt: null,
};
export type MeetRecordingFlow = Pick<
  Row,
  | "revision"
  | "clientFingerprint"
  | "flowHash"
  | "browserHash"
  | "verifierEnc"
  | "nonceHash"
  | "flowExpiresAt"
>;
export type MeetRecordingGrant = Pick<
  Row,
  "subject" | "accountEmail" | "refreshTokenEnc" | "connectedAt"
>;
export interface MeetRecordingStore {
  get(actor: Actor): Promise<Row | undefined>;
  begin(actor: Actor, flow: MeetRecordingFlow): Promise<void>;
  consume(actor: Actor, state: string, browser: string, now: Date): Promise<Row | undefined>;
  bind(actor: Actor, revision: string, grant: MeetRecordingGrant): Promise<boolean>;
  clear(actor: Actor, revision: string, reconnect?: boolean): Promise<boolean>;
  rotate(actor: Actor, revision: string, previous: string, next: string): Promise<boolean>;
}
/** No app-role grants; every admin-pool query repeats staff AND employer scope. */
export function googleMeetRecordingStore(
  database: Pick<typeof dbAdmin, "select" | "insert" | "update" | "transaction"> = dbAdmin,
): MeetRecordingStore {
  const owned = (actor: Actor) =>
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
          ...clearedMeetGrant,
          needsReconnect: false,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: table.userId,
          set: {
            tenantId: actor.tenantId,
            ...flow,
            ...clearedMeetGrant,
            needsReconnect: false,
            updatedAt: new Date(),
          },
        });
    },
    async consume(actor, state, browser, now) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(table)
          .where(
            and(
              owned(actor),
              eq(table.flowHash, state),
              eq(table.browserHash, browser),
              gt(table.flowExpiresAt, now),
            ),
          )
          .for("update");
        if (!row) return undefined;
        await tx
          .update(table)
          .set({ ...clearedMeetFlow, updatedAt: new Date() })
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
              ...clearedMeetFlow,
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
              ...clearedMeetGrant,
              ...clearedMeetFlow,
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
  };
}
