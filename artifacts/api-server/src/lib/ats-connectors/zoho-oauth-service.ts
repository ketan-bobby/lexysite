import { randomBytes, randomUUID } from "node:crypto";
import { calendarStaff } from "../calendar-staff";
import { encryptSecret } from "../crypto-secrets";
import {
  zohoConsent,
  zohoDigest,
  zohoFailure,
  zohoOAuthConfig,
  zohoOAuthProvider,
  type ZohoOAuthConfig,
} from "./zoho-oauth-provider";
import { zohoOAuthStore, type ZohoActor, type ZohoStore } from "./zoho-oauth-store";

export async function zohoEmployerAdmin(userId: string | null): Promise<ZohoActor> {
  const user = await calendarStaff(userId);
  // Exact employer only; platform or agency-wide visibility is not employer approval.
  if (user.role !== "tenant_admin" || !user.tenantId)
    throw zohoFailure("zoho_employer_admin_required", 403);
  return { id: user.id, tenantId: user.tenantId };
}
const opaque = () => randomBytes(32).toString("base64url");
export function zohoOAuthService(
  store: ZohoStore = zohoOAuthStore(),
  config: ZohoOAuthConfig | null = zohoOAuthConfig(),
  actorLookup = zohoEmployerAdmin,
  providerFactory: (
    config: ZohoOAuthConfig,
  ) => Pick<ReturnType<typeof zohoOAuthProvider>, "authorize"> = zohoOAuthProvider,
  seal = encryptSecret,
) {
  function configured() {
    if (!config) throw zohoFailure("zoho_setup_required", 503);
    return config;
  }
  async function revalidate(actor: ZohoActor) {
    const current = await actorLookup(actor.id);
    if (current.id !== actor.id || current.tenantId !== actor.tenantId)
      throw zohoFailure("zoho_authority_changed", 403);
  }
  async function status(actor: ZohoActor) {
    const row = await store.get(actor);
    const usable = Boolean(
      config && row?.fingerprint === config.fingerprint && row.refreshTokenEnc,
    );
    return {
      configured: !!config,
      redirectUri: config?.redirectUri ?? null,
      region: config?.region.label ?? null,
      revision: row?.revision ?? null,
      state: usable
        ? row?.approvedAt
          ? "connected"
          : "review_required"
        : row?.refreshTokenEnc
          ? "reconnect_required"
          : "disconnected",
      companyName: usable ? (row?.companyName ?? null) : null,
      canApprove: usable && row?.userId === actor.id && !row.approvedAt,
      connectedAt: usable ? (row?.approvedAt?.toISOString() ?? null) : null,
      importsEnabled: Boolean(usable && row?.approvedAt),
    };
  }
  return {
    status,
    async begin(
      actor: ZohoActor,
      includeStageMetadata = false,
      includeInterviewNotes = false,
      includeStageWrites = false,
    ) {
      const cfg = configured();
      await revalidate(actor);
      const state = opaque(),
        browser =
          opaque() +
          (includeInterviewNotes ? ".notes" : "") +
          (includeStageWrites ? ".stages" : "");
      const ok = await store.begin(actor, {
        revision: randomUUID(),
        fingerprint: cfg.fingerprint,
        flowHash: zohoDigest(state),
        browserHash: zohoDigest(browser),
        flowExpiresAt: new Date(Date.now() + 10 * 60_000),
      });
      if (!ok) throw zohoFailure("zoho_disconnect_before_replacing", 409);
      return {
        browser,
        authorizationUrl: zohoConsent(
          cfg,
          state,
          includeStageMetadata,
          includeInterviewNotes,
          includeStageWrites,
        ),
      };
    },
    async finish(
      actor: ZohoActor,
      input: {
        state: string;
        browser: string;
        code: string;
        denied: boolean;
        location: string;
        accountsServer: string;
      },
    ) {
      const cfg = configured();
      await revalidate(actor);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
        !/^[A-Za-z0-9_-]{43}(?:\.notes)?(?:\.stages)?$/.test(input.browser)
      )
        throw zohoFailure("zoho_flow_invalid", 409);
      const flow = await store.consume(actor, {
        stateHash: zohoDigest(input.state),
        browserHash: zohoDigest(input.browser),
        fingerprint: cfg.fingerprint,
        now: new Date(),
      });
      if (!flow || input.denied || !input.code || input.code.length > 4096)
        throw zohoFailure("zoho_flow_invalid", 409);
      if (input.location !== cfg.region.location || input.accountsServer !== cfg.region.accounts)
        throw zohoFailure("zoho_region_mismatch", 409);
      const grant = await providerFactory(cfg).authorize(input.code);
      await revalidate(actor);
      const refreshTokenEnc = seal(
        JSON.stringify({
          purpose: "zoho-recruit",
          tenantId: actor.tenantId,
          userId: actor.id,
          accountRef: grant.accountRef,
          fingerprint: cfg.fingerprint,
          token: grant.refreshToken,
          interviewNotes: input.browser.split(".").includes("notes"),
          stageWrites: input.browser.split(".").includes("stages"),
        }),
      );
      if (
        !(await store.save(actor, flow.revision, {
          accountRef: grant.accountRef,
          companyName: grant.companyName,
          refreshTokenEnc,
        }))
      )
        throw zohoFailure("zoho_connection_changed", 409);
      return status(actor);
    },
    async approve(actor: ZohoActor, revision: string) {
      configured();
      await revalidate(actor);
      const view = await status(actor);
      if (
        view.revision !== revision ||
        !view.canApprove ||
        !(await store.approve(actor, revision, new Date()))
      )
        throw zohoFailure("zoho_connection_changed", 409);
      return status(actor);
    },
    async disconnect(actor: ZohoActor, revision: string) {
      await revalidate(actor);
      if (!(await store.disconnect(actor, revision, randomUUID())))
        throw zohoFailure("zoho_connection_changed", 409);
      return status(actor);
    },
  };
}
