/** Pure helpers for staff-provided Zoom links. Never treat as API-verified. */
export function safeZoomJoinUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(raw))
    return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?zoom\.us$/.test(u.hostname.toLowerCase()))
    return null;
  if (/%/.test(raw.split("?")[0]) || raw.split("?")[0].includes("..")) return null;
  if (!/^\/j\/\d{9,11}\/?$/.test(u.pathname)) return null; // join paths only
  const keys = [...u.searchParams.keys()];
  if (keys.length > 1 || keys.some((k) => k !== "pwd")) return null;
  const pwd = u.searchParams.get("pwd");
  if (keys.length === 1 && !(pwd !== null && /^[A-Za-z0-9._~-]{1,256}$/.test(pwd))) return null;
  if (raw.includes("?") && keys.length === 0) return null;
  const path = u.pathname.replace(/\/$/, "");
  return `https://${u.hostname.toLowerCase()}${path}${keys.length ? `?pwd=${pwd}` : ""}`;
}

export function zoomErrorMessage(error: unknown, action: string): string {
  const status = (error as { status?: number } | null)?.status;
  const m: Record<number, string> = {
    400: "The request was not valid. Check the link and review again.",
    401: "Your session ended. Sign in again, then reload the saved state.",
    403: "You do not have access to manage this interview's link.",
    404: "This interview or link no longer exists.",
    409: "The interview or link changed. Your draft is kept; review again.",
    503: "Zoom link storage is unavailable or not set up. The outcome is unconfirmed; reload the saved state before retrying.",
  };
  return (
    (status && m[status]) ||
    `Lexy could not confirm the ${action}. Reload the saved state before retrying.`
  );
}
