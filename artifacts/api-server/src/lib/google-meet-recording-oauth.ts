import { z } from "zod/v4";
import { googleStaffConfig, digest, type GoogleStaffConfig } from "./google-staff-config";
import { verifyGoogleStaffIdentity } from "./google-staff-provider";
import { CalendarError } from "./outlook-calendar-core";
import { GOOGLE_MEET_RECORDING_SCOPES } from "./google-meet-recordings-provider";
import type { JWTPayload } from "jose";

export const meetAccountFailure = (code = "meet_recording_unavailable", status = 503) =>
  new CalendarError(
    status,
    code,
    "Meet recording access could not be verified. Reload the connection and try again.",
  );

/** Uses the existing app registration, but an independent callback and grant. */
export function googleMeetRecordingConfig(
  base: GoogleStaffConfig | null = googleStaffConfig(),
): GoogleStaffConfig | null {
  if (!base) return null;
  const callback = new URL(base.redirectUri);
  callback.pathname = "/api/google-meet-recordings/callback";
  return {
    ...base,
    redirectUri: callback.toString(),
    fingerprint: digest(`${base.clientId}|${callback.toString()}|meet-recordings:v1`),
  };
}
export function googleMeetRecordingConsent(
  config: GoogleStaffConfig,
  state: string,
  challenge: string,
  nonce: string,
) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: ["openid", "email", ...GOOGLE_MEET_RECORDING_SCOPES].join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "false",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.literal("Bearer"),
  refresh_token: z.string().min(1).max(16384).optional(),
  id_token: z.string().max(16384).optional(),
  scope: z.string().max(4096),
  expires_in: z.number().int().min(1).max(86400),
});
const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(254),
  email_verified: z.literal(true),
  nonce: z.string().min(1).max(256),
  azp: z.string().optional(),
});
export interface MeetRecordingOAuthProvider {
  authorize(
    code: string,
    verifier: string,
    nonceHash: string,
  ): Promise<{ subject: string; email: string; refreshToken: string }>;
  refresh(refresh: string): Promise<{ accessToken: string; refreshToken?: string }>;
}
export function googleMeetRecordingOAuth(
  config: GoogleStaffConfig,
  request: typeof fetch = fetch,
  verify: (
    config: GoogleStaffConfig,
    token: string,
  ) => Promise<JWTPayload> = verifyGoogleStaffIdentity,
): MeetRecordingOAuthProvider {
  async function exchange(params: Record<string, string>) {
    try {
      const response = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...params,
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      // Token replies are small; reject oversized streams as well as headers.
      if (!response.body) throw meetAccountFailure();
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 64 * 1024) {
            await reader.cancel().catch(() => {});
            throw meetAccountFailure();
          }
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        reader.releaseLock();
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok)
        throw meetAccountFailure(
          raw?.error === "invalid_grant" ? "meet_recording_reconnect_required" : undefined,
          raw?.error === "invalid_grant" ? 409 : 503,
        );
      const token = tokenSchema.safeParse(raw);
      if (
        !token.success ||
        !GOOGLE_MEET_RECORDING_SCOPES.every((scope) => token.data.scope.split(" ").includes(scope))
      )
        throw meetAccountFailure("meet_recording_reconnect_required", 409);
      return token.data;
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw meetAccountFailure();
    }
  }
  return {
    async authorize(code, verifier, nonceHash) {
      const token = await exchange({
        code,
        code_verifier: verifier,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      });
      if (!token.refresh_token || !token.id_token)
        throw meetAccountFailure("meet_recording_reconnect_required", 409);
      let claims: z.infer<typeof identitySchema>;
      try {
        claims = identitySchema.parse(await verify(config, token.id_token));
      } catch {
        throw meetAccountFailure("meet_recording_identity_invalid", 409);
      }
      if (digest(claims.nonce) !== nonceHash || (claims.azp && claims.azp !== config.clientId))
        throw meetAccountFailure("meet_recording_identity_invalid", 409);
      return { subject: claims.sub, email: claims.email, refreshToken: token.refresh_token };
    },
    async refresh(refreshToken) {
      const token = await exchange({ refresh_token: refreshToken, grant_type: "refresh_token" });
      return {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      };
    },
  };
}
