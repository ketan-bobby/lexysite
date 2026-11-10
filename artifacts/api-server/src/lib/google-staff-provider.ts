import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod/v4";
import {
  digest,
  GOOGLE_STAFF_SCOPES,
  GOOGLE_INVITATION_SCOPE,
  googleStaffFailure,
  type GoogleStaffConfig,
} from "./google-staff-config";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export async function verifyGoogleStaffIdentity(
  config: GoogleStaffConfig,
  token: string,
  keys: JWTVerifyGetKey = googleKeys,
) {
  return (
    await jwtVerify(token, keys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.clientId,
      algorithms: ["RS256"],
      maxTokenAge: "10m",
      clockTolerance: 5,
    })
  ).payload;
}
const identity = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(254),
  email_verified: z.literal(true),
  nonce: z.string().min(1).max(256),
  azp: z.string().optional(),
});
const tokens = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.literal("Bearer"),
  refresh_token: z.string().min(1).max(16384).optional(),
  expires_in: z.number().int().min(1).max(86400),
  scope: z.string().max(4096).optional(),
  id_token: z.string().max(16384).optional(),
});
export interface GoogleStaffProvider {
  authorize(
    code: string,
    verifier: string,
    nonceHash: string,
    allowInvitations?: boolean,
  ): Promise<{ subject: string; email: string; refreshToken: string }>;
  refresh(
    refreshToken: string,
    requireInvitations?: boolean,
  ): Promise<{ accessToken: string; refreshToken?: string }>;
  busy(accessToken: string, startAt: string, endAt: string): Promise<boolean>;
}
/** Dedicated customer OAuth transport. Never imports the project connector. */
export function googleStaffProvider(
  config: GoogleStaffConfig,
  request: typeof fetch = fetch,
  verify: (
    config: GoogleStaffConfig,
    token: string,
  ) => Promise<JWTPayload> = verifyGoogleStaffIdentity,
): GoogleStaffProvider {
  async function tokenRequest(params: Record<string, string>) {
    let response: Response;
    try {
      response = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...params,
        }),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
    } catch {
      throw googleStaffFailure();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw googleStaffFailure();
    }
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? body.error : null;
      throw googleStaffFailure(
        error === "invalid_grant" ? "google_reconnect_required" : "google_calendar_unavailable",
        error === "invalid_grant" ? 409 : 503,
      );
    }
    const parsed = tokens.safeParse(body);
    if (!parsed.success) throw googleStaffFailure();
    return parsed.data;
  }
  return {
    async authorize(code, verifier, nonceHash, allowInvitations = false) {
      const token = await tokenRequest({
        code,
        code_verifier: verifier,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      });
      if (!token.refresh_token || !token.id_token)
        throw googleStaffFailure("google_reconnect_required", 409);
      const scopes = new Set(token.scope?.split(" "));
      if (!GOOGLE_STAFF_SCOPES.slice(2).every((scope) => scopes.has(scope)))
        throw googleStaffFailure("google_scope_required", 409);
      if (allowInvitations && !scopes.has(GOOGLE_INVITATION_SCOPE))
        throw googleStaffFailure("google_scope_required", 409);
      let claims: z.infer<typeof identity>;
      try {
        claims = identity.parse(await verify(config, token.id_token));
      } catch {
        throw googleStaffFailure("google_identity_invalid", 409);
      }
      if (digest(claims.nonce) !== nonceHash || (claims.azp && claims.azp !== config.clientId))
        throw googleStaffFailure("google_identity_invalid", 409);
      return { subject: claims.sub, email: claims.email, refreshToken: token.refresh_token };
    },
    async refresh(refreshToken, requireInvitations = false) {
      const token = await tokenRequest({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      if (token.scope) {
        const scopes = new Set(token.scope.split(" "));
        if (!GOOGLE_STAFF_SCOPES.slice(2).every((scope) => scopes.has(scope)))
          throw googleStaffFailure("google_reconnect_required", 409);
        if (requireInvitations && !scopes.has(GOOGLE_INVITATION_SCOPE))
          throw googleStaffFailure("google_reconnect_required", 409);
      }
      return {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      };
    },
    async busy(accessToken, startAt, endAt) {
      let calendarId: string;
      try {
        const primary = await request(
          "https://www.googleapis.com/calendar/v3/calendars/primary?fields=id,timeZone",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(8000),
            redirect: "error",
          },
        );
        if (!primary.ok)
          throw googleStaffFailure(
            primary.status === 401 || primary.status === 403
              ? "google_reconnect_required"
              : "google_calendar_unavailable",
            primary.status === 401 || primary.status === 403 ? 409 : 503,
          );
        const calendar = z
          .object({ id: z.string().min(1).max(1024), timeZone: z.string().min(1).max(100) })
          .parse(await primary.json());
        new Intl.DateTimeFormat("en-US", { timeZone: calendar.timeZone });
        calendarId = calendar.id;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "google_reconnect_required")
          throw error;
        throw googleStaffFailure();
      }
      let response: Response;
      try {
        response = await request("https://www.googleapis.com/calendar/v3/freeBusy", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            timeMin: startAt,
            timeMax: endAt,
            timeZone: "UTC",
            calendarExpansionMax: 1,
            items: [{ id: calendarId }],
          }),
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        });
      } catch {
        throw googleStaffFailure();
      }
      if (!response.ok)
        throw googleStaffFailure(
          response.status === 401 || response.status === 403
            ? "google_reconnect_required"
            : "google_calendar_unavailable",
          response.status === 401 || response.status === 403 ? 409 : 503,
        );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw googleStaffFailure();
      }
      const result = z
        .object({
          timeMin: z.iso.datetime({ offset: true }),
          timeMax: z.iso.datetime({ offset: true }),
          calendars: z.record(
            z.string(),
            z.object({
              errors: z.array(z.unknown()).max(0).optional(),
              busy: z
                .array(
                  z.object({
                    start: z.iso.datetime({ offset: true }),
                    end: z.iso.datetime({ offset: true }),
                  }),
                )
                .max(2048),
            }),
          ),
          groups: z.record(z.string(), z.unknown()).optional(),
        })
        .safeParse(body);
      if (!result.success) throw googleStaffFailure();
      const data = result.data,
        calendars = Object.values(data.calendars);
      if (
        Date.parse(data.timeMin) !== Date.parse(startAt) ||
        Date.parse(data.timeMax) !== Date.parse(endAt) ||
        calendars.length !== 1 ||
        Object.keys(data.calendars)[0] !== calendarId ||
        (data.groups && Object.keys(data.groups).length)
      )
        throw googleStaffFailure();
      let busy = false;
      for (const interval of calendars[0].busy) {
        const start = Date.parse(interval.start),
          end = Date.parse(interval.end);
        if (end <= start || start < Date.parse(startAt) || end > Date.parse(endAt))
          throw googleStaffFailure();
        busy = true;
      }
      return busy;
    },
  };
}
