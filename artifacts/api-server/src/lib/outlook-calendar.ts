import { getAccessTokenForUser } from "./graph-auth";
import { getMailAccount } from "./recruiter-mail";
import {
  CalendarError,
  CALENDAR_SCOPE,
  hasCalendarScope,
  safeGraphPath,
  type CalendarRequest,
} from "./outlook-calendar-core";
import { meteredFetch } from "./vendor-usage";

/** Delegated /me only. No application-wide token, mailbox selector, or SES fallback. */
export async function outlookCalendarRequest(userId: string): Promise<CalendarRequest> {
  const account = await getMailAccount(userId);
  if (!account || account.status !== "connected" || !hasCalendarScope(account.scopes)) {
    throw new CalendarError(
      409,
      "calendar_consent_required",
      "Connect Outlook Calendar in Settings first. Email access alone does not grant calendar access.",
    );
  }
  const token = await getAccessTokenForUser(userId, [CALENDAR_SCOPE]);
  if (!token)
    throw new CalendarError(
      409,
      "calendar_reconnect_required",
      "Reconnect Outlook Calendar. Your email connection has not been changed.",
    );
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    // Normalize every HeadersInit variant and prevent caller-supplied auth overrides.
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    headers.set("Prefer", 'outlook.timezone="UTC", IdType="ImmutableId"');
    let response: Response;
    try {
      response = await meteredFetch("ms_graph")(safeGraphPath(path), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers,
      });
    } catch {
      throw new CalendarError(
        503,
        "calendar_request_uncertain",
        "Outlook did not confirm the request. Refresh the linked event before retrying; no email fallback was used.",
      );
    }
    if (!response.ok) {
      const status = response.status;
      throw new CalendarError(
        status === 429 ? 429 : status === 412 ? 409 : 502,
        status === 401 || status === 403
          ? "calendar_reconnect_required"
          : status === 412
            ? "calendar_changed"
            : "calendar_provider_error",
        status === 401 || status === 403
          ? "Outlook denied calendar access. Reconnect Calendar or ask your Microsoft administrator to approve Calendars.ReadWrite."
          : status === 412
            ? "The Outlook event changed. Refresh before trying again."
            : status === 429
              ? "Outlook is throttling calendar requests. Please try again later."
              : "Outlook did not confirm this operation. Refresh before retrying.",
      );
    }
    if (response.status === 204 || response.headers.get("content-length") === "0")
      return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new CalendarError(
        503,
        "calendar_request_uncertain",
        "Outlook returned an unreadable response. Refresh the linked event before retrying.",
      );
    }
  };
}
