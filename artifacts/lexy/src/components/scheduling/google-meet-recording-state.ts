/** Only the fixed Google consent destination is allowed to leave this page. */
export function safeGoogleMeetAuthUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "accounts.google.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/o/oauth2/v2/auth"
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
export function shouldShowStatus(state: { readFailing: boolean; denied: boolean }): boolean {
  return !state.readFailing && !state.denied;
}
export function errStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}
