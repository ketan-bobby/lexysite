import { createHash, randomBytes } from "node:crypto";
import { CalendarError } from "./outlook-calendar-core";

export const GOOGLE_STAFF_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;
export const GOOGLE_INVITATION_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
export type GoogleStaffConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  settingsUrl: string;
  fingerprint: string;
};
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const opaque = () => randomBytes(32).toString("base64url");
export const googleStaffFailure = (code = "google_calendar_unavailable", status = 503) =>
  new CalendarError(
    status,
    code,
    "Google Calendar could not be verified. Reload the connection or try again.",
  );

export function googleStaffConfig(env = process.env): GoogleStaffConfig | null {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  const settingsUrl = env.GOOGLE_CALENDAR_SETTINGS_URL?.trim();
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !settingsUrl ||
    !(env.SESSION_SECRET || env.AUTH_SECRET)
  )
    return null;
  try {
    const callback = new URL(redirectUri),
      settings = new URL(settingsUrl);
    if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) return null;
    for (const url of [callback, settings])
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
        return null;
    if (
      callback.pathname !== "/api/google-calendar/callback" ||
      !settings.pathname.endsWith("/settings/calendar")
    )
      return null;
    return {
      clientId,
      clientSecret,
      redirectUri,
      settingsUrl,
      fingerprint: digest(`${clientId}|${redirectUri}`),
    };
  } catch {
    return null;
  }
}

export function googleStaffConsent(
  config: GoogleStaffConfig,
  state: string,
  challenge: string,
  nonce: string,
  allowInvitations = false,
) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: [...GOOGLE_STAFF_SCOPES, ...(allowInvitations ? [GOOGLE_INVITATION_SCOPE] : [])].join(
      " ",
    ),
    access_type: "offline",
    prompt: "consent select_account",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    include_granted_scopes: "false",
  }).toString();
  return url.toString();
}
