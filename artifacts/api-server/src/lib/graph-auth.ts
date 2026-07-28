/**
 * graph-auth.ts — Microsoft Graph OAuth for per-recruiter mailbox sending
 *
 * Separate from routes/auth-microsoft.ts (which is SSO *login*). This handles the
 * "Connect your Outlook" CONSENT flow that grants Lexy delegated Mail.Send /
 * Mail.Read on the recruiter's behalf, plus offline_access so we can send their
 * approved outreach later from an encrypted refresh token.
 *
 * ─── MSAL client lifecycle ───────────────────────────────────────────────────
 * A FRESH ConfidentialClientApplication is created per operation. MSAL Node keeps
 * an in-memory token cache on the instance; sharing one instance across many
 * recruiters would mingle their tokens. Per-op clients keep each recruiter's
 * cache isolated and short-lived, and let us extract exactly their refresh token.
 */
import { ConfidentialClientApplication, CryptoProvider, LogLevel } from "@azure/msal-node";
import { logger } from "./logger.js";
import { encryptSecret, decryptSecret } from "./crypto-secrets.js";
import {
  getMailAccount,
  upsertMailAccountTokens,
  markMailAccountError,
} from "./recruiter-mail.js";

/** offline_access → refresh token; Mail.Send → send; Mail.Read → reply sync. */
export const GRAPH_SCOPES = ["offline_access", "Mail.Send", "Mail.Read"];

const cryptoProvider = new CryptoProvider();

export function isGraphConfigured(): boolean {
  return Boolean(process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET);
}

function newClient(): ConfidentialClientApplication | null {
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const tenant = (process.env.ENTRA_TENANT || "common").trim();
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenant}`,
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) logger.warn({ msal: message }, "[graph] msal");
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  });
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  return cryptoProvider.generatePkceCodes();
}
export function newGuid(): string {
  return cryptoProvider.createNewGuid();
}

/** Build the consent (authorize) URL the recruiter is redirected to. */
export async function buildConsentUrl(opts: {
  redirectUri: string;
  state: string;
  challenge: string;
  loginHint?: string;
}): Promise<string | null> {
  const pca = newClient();
  if (!pca) return null;
  return pca.getAuthCodeUrl({
    scopes: GRAPH_SCOPES,
    redirectUri: opts.redirectUri,
    responseMode: "query",
    codeChallenge: opts.challenge,
    codeChallengeMethod: "S256",
    state: opts.state,
    prompt: "select_account",
    loginHint: opts.loginHint,
  });
}

/**
 * Pull the refresh token MSAL cached after a code/refresh exchange. MSAL Node
 * does not expose refresh tokens directly, so we read the serialized cache and
 * pick the entry for this account (homeAccountId prefix) when known.
 */
function extractRefreshToken(
  pca: ConfidentialClientApplication,
  homeAccountId?: string | null,
): string | null {
  try {
    const cache = JSON.parse(pca.getTokenCache().serialize());
    const rts = cache.RefreshToken || {};
    const keys = Object.keys(rts);
    if (keys.length === 0) return null;
    let key = keys[0];
    if (homeAccountId) {
      const match = keys.find((k) => k.toLowerCase().startsWith(homeAccountId.toLowerCase()));
      if (match) key = match;
    }
    return rts[key]?.secret ?? null;
  } catch {
    return null;
  }
}

/** Redeem the auth code from the callback and store the encrypted refresh token. */
export async function redeemCodeAndStore(opts: {
  userId: string;
  tenantId: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const pca = newClient();
  if (!pca) return { ok: false, error: "not_configured" };
  try {
    const res = await pca.acquireTokenByCode({
      code: opts.code,
      scopes: GRAPH_SCOPES,
      redirectUri: opts.redirectUri,
      codeVerifier: opts.verifier,
    });
    const account = res.account;
    const homeAccountId = account?.homeAccountId ?? null;
    const claims = (account?.idTokenClaims ?? {}) as Record<string, any>;
    const email = String(
      account?.username || claims.email || claims.preferred_username || "",
    ).toLowerCase();
    const refreshToken = extractRefreshToken(pca, homeAccountId);
    if (!refreshToken) return { ok: false, error: "no_refresh_token" };
    await upsertMailAccountTokens({
      userId: opts.userId,
      tenantId: opts.tenantId,
      provider: "microsoft",
      email,
      homeAccountId,
      refreshTokenEnc: encryptSecret(refreshToken),
      scopes: GRAPH_SCOPES.join(" "),
    });
    logger.info({ userId: opts.userId }, "[graph] mailbox connected");
    return { ok: true, email };
  } catch (err: any) {
    logger.error({ err: err?.message }, "[graph] code redemption failed");
    return { ok: false, error: "token_exchange_failed" };
  }
}

/**
 * Get a fresh Graph access token for a recruiter from their stored refresh token,
 * rotating the stored token if Microsoft issued a new one. Returns null (and
 * marks the mailbox unhealthy) on any failure so callers fall back to SES.
 */
export async function getAccessTokenForUser(userId: string): Promise<string | null> {
  const acct = await getMailAccount(userId);
  if (!acct || acct.status === "revoked" || !acct.refreshTokenEnc) return null;
  const pca = newClient();
  if (!pca) return null;

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(acct.refreshTokenEnc);
  } catch {
    await markMailAccountError(userId, "decrypt_failed");
    return null;
  }

  try {
    const res = await pca.acquireTokenByRefreshToken({
      refreshToken,
      scopes: ["Mail.Send", "Mail.Read"],
    });
    if (!res?.accessToken) {
      await markMailAccountError(userId, "no_access_token");
      return null;
    }
    const rotated = extractRefreshToken(pca, acct.homeAccountId);
    if (rotated && rotated !== refreshToken) {
      await upsertMailAccountTokens({
        userId,
        tenantId: acct.tenantId,
        provider: acct.provider,
        email: acct.email,
        homeAccountId: acct.homeAccountId,
        refreshTokenEnc: encryptSecret(rotated),
        scopes: acct.scopes,
      });
    }
    return res.accessToken;
  } catch (err: any) {
    const msg = String(err?.errorCode || err?.subError || err?.message || "");
    const revoked = /invalid_grant|interaction_required|expired|revoked|consent/i.test(msg);
    await markMailAccountError(userId, msg || "refresh_failed", revoked);
    logger.warn({ userId, msg }, "[graph] token refresh failed");
    return null;
  }
}
