import { z } from "zod/v4";
import type { infer as ZodInfer } from "zod";
import { decryptSecret } from "../crypto-secrets";
import { CalendarError } from "../outlook-calendar-core";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import { zohoOAuthStore, type ZohoActor } from "./zoho-oauth-store";
import {
  ZOHO_READ_MODULES,
  zohoFailure,
  zohoOAuthConfig,
  zohoOAuthProvider,
} from "./zoho-oauth-provider";
import { CheckZohoRecruitAccessResponse } from "@workspace/api-zod";
type ZohoRecruitAccessCheck = ZodInfer<typeof CheckZohoRecruitAccessResponse>;

/** Explicit administrator-only diagnostics. Never returns or persists remote records. */
export function zohoAccessCheck({
  store = zohoOAuthStore(),
  config = zohoOAuthConfig(),
  actorLookup = zohoEmployerAdmin,
  providerFactory = zohoOAuthProvider as (
    config: NonNullable<ReturnType<typeof zohoOAuthConfig>>,
  ) => Pick<ReturnType<typeof zohoOAuthProvider>, "refresh" | "organization" | "probeModule">,
  unseal = decryptSecret,
} = {}) {
  return {
    async check(actor: ZohoActor, revision: string): Promise<ZohoRecruitAccessCheck> {
      if (!config) throw zohoFailure("zoho_setup_required");
      const initial = await store.get(actor);
      if (
        !initial?.approvedAt ||
        !initial.refreshTokenEnc ||
        !initial.accountRef ||
        initial.revision !== revision ||
        initial.fingerprint !== config.fingerprint ||
        initial.tenantId !== actor.tenantId
      )
        throw new CalendarError(
          409,
          "zoho_review_required",
          "Confirm the current Zoho employer account before checking access.",
        );
      async function guard() {
        const requester = await actorLookup(actor.id);
        const owner = await actorLookup(initial!.userId);
        const row = await store.get(actor);
        if (
          requester.id !== actor.id ||
          requester.tenantId !== actor.tenantId ||
          owner.id !== initial!.userId ||
          owner.tenantId !== actor.tenantId ||
          !row ||
          row.tenantId !== actor.tenantId ||
          row.userId !== initial!.userId ||
          row.revision !== revision ||
          row.fingerprint !== config!.fingerprint ||
          row.refreshTokenEnc !== initial!.refreshTokenEnc ||
          row.accountRef !== initial!.accountRef ||
          row.approvedAt?.getTime() !== initial!.approvedAt!.getTime()
        )
          throw new CalendarError(
            409,
            "zoho_connection_changed",
            "Zoho authorization changed. Reload the connection status and try again.",
          );
      }
      await guard();
      let custody;
      try {
        custody = z
          .object({
            purpose: z.literal("zoho-recruit"),
            tenantId: z.literal(actor.tenantId),
            userId: z.literal(initial.userId),
            accountRef: z.literal(initial.accountRef),
            fingerprint: z.literal(config.fingerprint),
            token: z.string().min(1).max(16384),
          })
          .parse(JSON.parse(unseal(initial.refreshTokenEnc)));
      } catch {
        throw new CalendarError(
          409,
          "zoho_credentials_unavailable",
          "Stored Zoho authorization could not be verified. Reconnect this employer account.",
        );
      }
      const provider = providerFactory(config);
      const accessToken = await provider.refresh(custody.token);
      await guard();
      const organization = await provider.organization(accessToken);
      await guard();
      if (organization.accountRef !== initial.accountRef)
        throw new CalendarError(
          409,
          "zoho_account_changed",
          "Zoho returned a different account. Disconnect and review a fresh authorization.",
        );
      const modules: ZohoRecruitAccessCheck["modules"] = [];
      for (const module of ZOHO_READ_MODULES) {
        await guard();
        try {
          const status = await provider.probeModule(accessToken, module);
          modules.push({ module, status, reason: null });
        } catch (error) {
          if (!(error instanceof CalendarError)) throw zohoFailure();
          if (error.code === "zoho_module_token_rejected") throw zohoFailure();
          const reasons: Record<
            string,
            "scope_missing" | "access_denied" | "unsupported" | "request_failed"
          > = {
            zoho_module_scope_missing: "scope_missing",
            zoho_module_access_denied: "access_denied",
            zoho_module_unsupported: "unsupported",
            zoho_module_request_failed: "request_failed",
          };
          if (!Object.hasOwn(reasons, error.code)) throw zohoFailure();
          modules.push({ module, status: "unavailable", reason: reasons[error.code] });
        }
        await guard();
      }
      return { revision, checkedAt: new Date(), importsEnabled: false, modules };
    },
  };
}
