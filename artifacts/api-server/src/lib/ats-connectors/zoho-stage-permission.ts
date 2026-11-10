import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { decryptSecret } from "../crypto-secrets";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import { zohoOAuthConfig, zohoFailure } from "./zoho-oauth-provider";
import { zohoOAuthStore, type ZohoActor } from "./zoho-oauth-store";

/** Local custody/authority check only; never refreshes a token or contacts Zoho. */
export function zohoStagePermission({
  store = zohoOAuthStore(),
  config = zohoOAuthConfig(),
  actorLookup = zohoEmployerAdmin,
  unseal = decryptSecret,
} = {}) {
  return {
    async check(actor: ZohoActor, accountRef: string) {
      const current = await actorLookup(actor.id);
      if (current.id !== actor.id || current.tenantId !== actor.tenantId)
        throw zohoFailure("zoho_authority_changed", 403);
      const row = await store.get(actor);
      if (
        !config ||
        !row?.approvedAt ||
        !row.refreshTokenEnc ||
        row.tenantId !== actor.tenantId ||
        row.accountRef !== accountRef ||
        row.fingerprint !== config.fingerprint
      )
        return {
          connectionRevision: null,
          writeConsentSaved: false,
          custodyRevision: null,
          configFingerprint: null,
        };
      const owner = await actorLookup(row.userId);
      if (owner.id !== row.userId || owner.tenantId !== actor.tenantId)
        throw zohoFailure("zoho_authority_changed", 403);
      const custody = z
        .object({
          purpose: z.literal("zoho-recruit"),
          tenantId: z.literal(actor.tenantId),
          userId: z.literal(row.userId),
          accountRef: z.literal(accountRef),
          fingerprint: z.literal(config.fingerprint),
          token: z.string().min(1).max(16384),
          stageWrites: z.boolean().optional(),
        })
        .safeParse(
          (() => {
            try {
              return JSON.parse(unseal(row.refreshTokenEnc!));
            } catch {
              return null;
            }
          })(),
        );
      return {
        connectionRevision: custody.success ? row.revision : null,
        writeConsentSaved: custody.success && custody.data.stageWrites === true,
        // Internal compare-and-lock evidence only. Never return ciphertext/tokens.
        custodyRevision: custody.success
          ? createHash("sha256").update(row.refreshTokenEnc).digest("hex")
          : null,
        configFingerprint: custody.success ? config.fingerprint : null,
      };
    },
  };
}
