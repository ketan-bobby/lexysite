interface InterviewLinkSettings {
  appBaseUrl?: string;
  devDomain?: string;
  nodeEnv?: string;
}

/** Email links must return to the database/environment that minted the session. */
export function interviewRoomUrl(
  sessionId: string,
  settings: InterviewLinkSettings = {
    appBaseUrl: process.env.APP_BASE_URL,
    devDomain: process.env.REPLIT_DEV_DOMAIN,
    nodeEnv: process.env.NODE_ENV,
  },
): string {
  const configured = settings.appBaseUrl?.trim();
  const base =
    configured ||
    (settings.nodeEnv !== "production" && settings.devDomain
      ? `https://${settings.devDomain}`
      : undefined);
  if (!base) throw new Error("APP_BASE_URL is required for production interview invitation links.");
  const parsed = new URL(base);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Invalid interview invitation app URL.");
  if (parsed.search || parsed.hash)
    throw new Error("App URL must not contain a query or fragment.");
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}/interviews/${encodeURIComponent(sessionId)}/room`;
}
