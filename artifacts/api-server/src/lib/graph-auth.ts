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
import { CALENDAR_SCOPE, hasCalendarScope, hasGraphScope } from "./outlook-calendar-core";
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
  calendar?: boolean;
}): Promise<string | null> {
  const pca = newClient();
  if (!pca) return null;
  return pca.getAuthCodeUrl({
    scopes: opts.calendar ? [...GRAPH_SCOPES, CALENDAR_SCOPE] : GRAPH_SCOPES,
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
    let key: string | undefined;
    if (homeAccountId) {
      const home = homeAccountId.toLowerCase();
      key = keys.find((k) =>
        rts[k]?.home_account_id
          ? String(rts[k].home_account_id).toLowerCase() === home
          : k.toLowerCase().startsWith(`${home}-`),
      );
    } else if (keys.length === 1) key = keys[0];
    const secret = key ? rts[key]?.secret : null;
    return typeof secret === "string" && secret.length ? secret : null;
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
  calendar?: boolean;
}): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const pca = newClient();
  if (!pca) return { ok: false, error: "not_configured" };
  try {
    const res = await pca.acquireTokenByCode({
      code: opts.code,
      scopes: opts.calendar ? [...GRAPH_SCOPES, CALENDAR_SCOPE] : GRAPH_SCOPES,
      redirectUri: opts.redirectUri,
      codeVerifier: opts.verifier,
    });
    const account = res.account;
    const homeAccountId = account?.homeAccountId ?? null;
    const claims = (account?.idTokenClaims ?? {}) as Record<string, any>;
    const email = String(
      account?.username || claims.email || claims.preferred_username || "",
    ).trim().toLowerCase();
    if (!email || !homeAccountId) return { ok: false, error: "account_identity_missing" };
    const refreshToken = extractRefreshToken(pca, homeAccountId);
    if (!refreshToken) return { ok: false, error: "no_refresh_token" };
    if (opts.calendar) {
      if (!hasCalendarScope(res.scopes.join(" "))) return { ok: false, error: "calendar_consent_required" };
      if (!["Mail.Send", "Mail.Read"].every((scope) => hasGraphScope(res.scopes.join(" "), scope))) {
        return { ok: false, error: "mail_consent_required" };
      }
      const current = await getMailAccount(opts.userId);
      if (current && (current.homeAccountId
        ? current.homeAccountId.toLowerCase() !== homeAccountId.toLowerCase()
        : current.email.trim().toLowerCase() !== email)) {
        return { ok: false, error: "calendar_account_mismatch" };
      }
    }
    await upsertMailAccountTokens({
      userId: opts.userId,
      tenantId: opts.tenantId,
      provider: "microsoft",
      email,
      homeAccountId,
      refreshTokenEnc: encryptSecret(refreshToken),
      scopes: res.scopes.join(" "),
    });
    logger.info({ userId: opts.userId }, "[graph] mailbox connected");
    return { ok: true, email };
  } catch (err: any) {
    logger.error({ reason: safeFailureReason(err) }, "[graph] code redemption failed");
    return { ok: false, error: "token_exchange_failed" };
  }
}

/**
 * Get a fresh Graph access token for a recruiter from their stored refresh token,
 * rotating the stored token if Microsoft issued a new one. Returns null (and
 * marks the mailbox unhealthy) on mail failure so mail callers fall back to SES.
 * Calendar-only failures never change mailbox health.
 */
export async function getAccessTokenForUser(userId: string, scopes = ["Mail.Send", "Mail.Read"]): Promise<string | null> {
  const calendarOnly = scopes.includes(CALENDAR_SCOPE);
  const acct = await getMailAccount(userId);
  if (!acct || acct.status === "revoked" || !acct.refreshTokenEnc) return null;
  const pca = newClient();
  if (!pca) return null;

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(acct.refreshTokenEnc);
  } catch {
    if (!calendarOnly) await markMailAccountError(userId, "decrypt_failed");
    return null;
  }

  try {
    const res = await pca.acquireTokenByRefreshToken({
      refreshToken,
      scopes,
    });
    if (!res?.accessToken) {
      if (!calendarOnly) await markMailAccountError(userId, "no_access_token");
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
    const reason = safeFailureReason(err);
    if (!calendarOnly) await markMailAccountError(userId, reason, revoked);
    logger.warn({ userId, reason }, "[graph] token refresh failed");
    return null;
  }
}

/** Provider exception messages can contain private request data. Persist codes only. */
function safeFailureReason(error: { errorCode?: string; subError?: string } | null): string {
  const allowed = new Set([
    "invalid_grant", "interaction_required", "consent_required", "login_required",
    "invalid_client", "invalid_scope", "temporarily_unavailable", "no_tokens_found",
    "refresh_token_expired", "client_mismatch",
  ]);
  for (const code of [error?.errorCode, error?.subError]) {
    if (typeof code === "string" && allowed.has(code.toLowerCase())) return code.toLowerCase();
  }
  return "token_request_failed";
}
