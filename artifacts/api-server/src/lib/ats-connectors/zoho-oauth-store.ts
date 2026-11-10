import { and, eq, gt, isNull } from "drizzle-orm";
import { dbAdmin, zohoRecruitAccountsTable as table } from "@workspace/db";

export type ZohoActor = { id: string; tenantId: string };
export type ZohoRow = typeof table.$inferSelect;
export type ZohoFlow = Pick<
  ZohoRow,
  "revision" | "fingerprint" | "flowHash" | "browserHash" | "flowExpiresAt"
>;
export type ZohoGrant = Pick<ZohoRow, "accountRef" | "companyName" | "refreshTokenEnc">;
export interface ZohoStore {
  get(actor: ZohoActor): Promise<ZohoRow | undefined>;
  begin(actor: ZohoActor, flow: ZohoFlow): Promise<boolean>;
  consume(
    actor: ZohoActor,
    flow: {
      stateHash: string;
      browserHash: string;
      fingerprint: string;
      now: Date;
    },
  ): Promise<ZohoRow | undefined>;
  save(actor: ZohoActor, revision: string, grant: ZohoGrant): Promise<boolean>;
  approve(actor: ZohoActor, revision: string, now: Date): Promise<boolean>;
  disconnect(actor: ZohoActor, revision: string, nextRevision: string): Promise<boolean>;
}
/** No generic tenant proxy: OAuth tokens are denied to request-role SQL entirely. */
export function zohoOAuthStore(): ZohoStore {
  const tenant = (actor: ZohoActor) => eq(table.tenantId, actor.tenantId);
  const owned = (actor: ZohoActor) => and(tenant(actor), eq(table.userId, actor.id));
  return {
    async get(actor) {
      return (await dbAdmin.select().from(table).where(tenant(actor)).limit(1))[0];
    },
    async begin(actor, flow) {
      const rows = await dbAdmin
        .insert(table)
        .values({ tenantId: actor.tenantId, userId: actor.id, ...flow })
        .onConflictDoUpdate({
          target: table.tenantId,
          set: { userId: actor.id, ...flow, updatedAt: new Date() },
          setWhere: isNull(table.refreshTokenEnc),
        })
        .returning({ revision: table.revision });
      return rows.length === 1;
    },
    async consume(actor, input) {
      return (
        await dbAdmin
          .update(table)
          .set({
            flowHash: null,
            browserHash: null,
            flowExpiresAt: null,
            updatedAt: input.now,
          })
          .where(
            and(
              owned(actor),
              eq(table.fingerprint, input.fingerprint),
              eq(table.flowHash, input.stateHash),
              eq(table.browserHash, input.browserHash),
              gt(table.flowExpiresAt, input.now),
              isNull(table.refreshTokenEnc),
            ),
          )
          .returning()
      )[0];
    },
    async save(actor, revision, grant) {
      return (
        (
          await dbAdmin
            .update(table)
            .set({ ...grant, approvedAt: null, updatedAt: new Date() })
            .where(
              and(
                owned(actor),
                eq(table.revision, revision),
                isNull(table.flowHash),
                isNull(table.refreshTokenEnc),
              ),
            )
            .returning({ revision: table.revision })
        ).length === 1
      );
    },
    async approve(actor, revision, now) {
      return (
        (
          await dbAdmin
            .update(table)
            .set({ approvedAt: now, updatedAt: now })
            .where(and(owned(actor), eq(table.revision, revision), isNull(table.approvedAt)))
            .returning({ revision: table.revision })
        ).length === 1
      );
    },
    async disconnect(actor, revision, nextRevision) {
      return (
        (
          await dbAdmin
            .update(table)
            .set({
              revision: nextRevision,
              flowHash: null,
              browserHash: null,
              flowExpiresAt: null,
              accountRef: null,
              companyName: null,
              refreshTokenEnc: null,
              approvedAt: null,
              updatedAt: new Date(),
            })
            .where(and(tenant(actor), eq(table.revision, revision)))
            .returning({ revision: table.revision })
        ).length === 1
      );
    },
  };
}
