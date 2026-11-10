import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import {
  dbAdmin,
  staffZoomAccountsTable as accounts,
  interviewZoomMeetingsTable as meetings,
} from "@workspace/db";
import { encryptSecret, decryptSecret } from "./crypto-secrets";
import { calendarStaff } from "./calendar-staff";
import { zoomAppConfig, zoomProvider, zoomProviderError } from "./zoom-provider";

export type ZoomActor = { id: string; tenantId: string };
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const fingerprint = (clientId: string, redirectUri: string) => digest(`${clientId}|${redirectUri}`);
const owned = (actor: ZoomActor) =>
  and(eq(accounts.userId, actor.id), eq(accounts.tenantId, actor.tenantId));
export async function zoomStaffActor(id: string | null): Promise<ZoomActor> {
  const staff = await calendarStaff(id);
  if (!staff.tenantId) throw zoomProviderError("zoom_employer_required", 403);
  return { id: staff.id, tenantId: staff.tenantId };
}
function seal(actor: ZoomActor, token: string) {
  return encryptSecret(
    JSON.stringify({ purpose: "zoom-staff", userId: actor.id, tenantId: actor.tenantId, token }),
  );
}
function open(actor: ZoomActor, ciphertext: string) {
  try {
    const value = JSON.parse(decryptSecret(ciphertext));
    if (
      value.purpose !== "zoom-staff" ||
      value.userId !== actor.id ||
      value.tenantId !== actor.tenantId ||
      typeof value.token !== "string" ||
      !value.token
    )
      throw new Error("context mismatch");
    return value.token as string;
  } catch {
    throw zoomProviderError("zoom_reconnect_required", 409);
  }
}
export function zoomStaffAccountService(
  database: Pick<typeof dbAdmin, "select" | "update" | "insert" | "transaction"> = dbAdmin,
  providerFactory = zoomProvider,
) {
  const config = zoomAppConfig();
  const configured = () => {
    if (!config) throw zoomProviderError("zoom_setup_required", 503);
    return config;
  };
  async function revalidate(actor: ZoomActor) {
    const current = await zoomStaffActor(actor.id);
    if (current.tenantId !== actor.tenantId) throw zoomProviderError("zoom_account_changed", 403);
  }
  async function get(actor: ZoomActor) {
    return (await database.select().from(accounts).where(owned(actor)).limit(1))[0];
  }
  async function status(actor: ZoomActor) {
    const row = await get(actor);
    const connected = Boolean(
      config &&
      row?.refreshTokenEnc &&
      row?.zoomUserId &&
      row.clientFingerprint === fingerprint(config.clientId, config.redirectUri) &&
      !row.needsReconnect,
    );
    return {
      configured: !!config,
      connected,
      revision: row?.revision ?? null,
      email: connected ? (row?.email ?? null) : null,
      needsReconnect: Boolean(row?.needsReconnect),
    };
  }
  return {
    get,
    status,
    async begin(actor: ZoomActor) {
      const cfg = configured();
      await revalidate(actor);
      const state = opaque(),
        browser = opaque(),
        revision = randomUUID();
      const flow = {
        revision,
        clientFingerprint: fingerprint(cfg.clientId, cfg.redirectUri),
        flowHash: digest(state),
        browserHash: digest(browser),
        flowExpiresAt: new Date(Date.now() + 10 * 60_000),
        updatedAt: new Date(),
      };
      await database
        .insert(accounts)
        .values({ userId: actor.id, tenantId: actor.tenantId, ...flow })
        .onConflictDoUpdate({
          target: accounts.userId,
          set: { tenantId: actor.tenantId, ...flow },
        });
      return {
        browser,
        authorizationUrl: providerFactory(cfg).authorizeUrl(state),
        expiresAt: flow.flowExpiresAt.toISOString(),
      };
    },
    async finish(
      actor: ZoomActor,
      input: { state: string; browser: string; code: string; denied: boolean },
    ) {
      const cfg = configured();
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !/^[A-Za-z0-9_-]{43}$/.test(input.browser))
        throw zoomProviderError("zoom_authorization_expired", 409);
      await revalidate(actor);
      // A single UPDATE RETURNING consumes this flow before any token exchange.
      const [flow] = await database
        .update(accounts)
        .set({ flowHash: null, browserHash: null, flowExpiresAt: null, updatedAt: new Date() })
        .where(
          and(
            owned(actor),
            eq(accounts.flowHash, digest(input.state)),
            eq(accounts.browserHash, digest(input.browser)),
            gt(accounts.flowExpiresAt, new Date()),
          ),
        )
        .returning();
      if (!flow || flow.clientFingerprint !== fingerprint(cfg.clientId, cfg.redirectUri))
        throw zoomProviderError("zoom_authorization_expired", 409);
      if (input.denied || !input.code || input.code.length > 4096)
        throw zoomProviderError("zoom_authorization_incomplete", 409);
      const grant = await providerFactory(cfg).authorize(input.code);
      await revalidate(actor);
      await database.transaction(async (tx) => {
        const [current] = await tx.select().from(accounts).where(owned(actor)).for("update");
        if (!current || current.revision !== flow.revision || current.flowHash !== null)
          throw zoomProviderError("zoom_account_changed", 409);
        const [otherHost] = await tx
          .select({ scheduleId: meetings.scheduleId })
          .from(meetings)
          .where(
            and(
              eq(meetings.hostUserId, actor.id),
              inArray(meetings.status, ["pending", "confirmed", "uncertain"]),
              ne(meetings.hostZoomId, grant.zoomUserId),
            ),
          )
          .limit(1);
        if (otherHost) throw zoomProviderError("zoom_existing_host_required", 409);
        const [bound] = await tx
          .update(accounts)
          .set({
            zoomUserId: grant.zoomUserId,
            email: grant.email,
            refreshTokenEnc: seal(actor, grant.refreshToken),
            connectedAt: new Date(),
            needsReconnect: false,
            revision: randomUUID(),
            updatedAt: new Date(),
          })
          .where(and(owned(actor), eq(accounts.revision, flow.revision), isNull(accounts.flowHash)))
          .returning({ userId: accounts.userId });
        if (!bound) throw zoomProviderError("zoom_account_changed", 409);
      });
      return status(actor);
    },
    async access(actor: ZoomActor, expectedRevision: string) {
      const cfg = configured();
      await revalidate(actor);
      const row = await get(actor);
      if (
        !row ||
        row.revision !== expectedRevision ||
        !row.refreshTokenEnc ||
        !row.zoomUserId ||
        row.needsReconnect ||
        row.clientFingerprint !== fingerprint(cfg.clientId, cfg.redirectUri)
      )
        throw zoomProviderError("zoom_reconnect_required", 409);
      let grant: Awaited<ReturnType<ReturnType<typeof zoomProvider>["refresh"]>>;
      try {
        grant = await providerFactory(cfg).refresh(open(actor, row.refreshTokenEnc));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "zoom_reconnect_required")
          await database
            .update(accounts)
            .set({ needsReconnect: true })
            .where(and(owned(actor), eq(accounts.revision, row.revision)));
        throw error;
      }
      const [rotated] = await database
        .update(accounts)
        .set({ refreshTokenEnc: seal(actor, grant.refresh_token), updatedAt: new Date() })
        .where(
          and(
            owned(actor),
            eq(accounts.revision, row.revision),
            eq(accounts.refreshTokenEnc, row.refreshTokenEnc),
          ),
        )
        .returning({ userId: accounts.userId });
      if (!rotated) throw zoomProviderError("zoom_account_changed", 409);
      await revalidate(actor);
      return { accessToken: grant.access_token, zoomUserId: row.zoomUserId };
    },
    async disconnect(actor: ZoomActor, revision: string) {
      await revalidate(actor);
      await database.transaction(async (tx) => {
        const [account] = await tx.select().from(accounts).where(owned(actor)).for("update");
        if (!account || account.revision !== revision)
          throw zoomProviderError("zoom_account_changed", 409);
        const [active] = await tx
          .select({ scheduleId: meetings.scheduleId })
          .from(meetings)
          .where(
            and(
              eq(meetings.hostUserId, actor.id),
              inArray(meetings.status, ["pending", "confirmed", "uncertain"]),
            ),
          )
          .limit(1);
        if (active) throw zoomProviderError("zoom_meetings_active", 409);
        await tx
          .update(accounts)
          .set({
            refreshTokenEnc: null,
            zoomUserId: null,
            email: null,
            connectedAt: null,
            flowHash: null,
            browserHash: null,
            flowExpiresAt: null,
            revision: randomUUID(),
            updatedAt: new Date(),
          })
          .where(owned(actor));
      });
      return status(actor);
    },
  };
}
