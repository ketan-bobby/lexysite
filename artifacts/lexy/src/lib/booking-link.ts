const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VERSION = /^v1_[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** Reads `#token=<43 base64url>` only; anything else is invalid. */
export function parseBookingToken(hash: string): string | null {
  const m = /^#token=([^&]*)$/.exec(hash);
  return m && TOKEN.test(m[1]) ? m[1] : null;
}

export function buildBookingUrl(origin: string, baseUrl: string, token: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${origin}${base}book-interview#token=${token}`;
}

export function parseLinkStatus(v: unknown): {
  version: string | null;
  active: boolean;
  expiresAt: string | null;
} {
  const bad = () => new Error("The link status could not be verified.");
  if (!isObj(v) || typeof v.active !== "boolean") throw bad();
  if (v.version !== null && (typeof v.version !== "string" || !v.version)) throw bad();
  if (
    v.expiresAt !== null &&
    (typeof v.expiresAt !== "string" || !Number.isFinite(Date.parse(v.expiresAt)))
  )
    throw bad();
  if (v.active && (v.version === null || v.expiresAt === null)) throw bad();
  return v as { version: string | null; active: boolean; expiresAt: string | null };
}

export function parseLinkCreated(v: unknown): {
  version: string;
  expiresAt: string;
  token: string;
} {
  if (
    !isObj(v) ||
    v.active !== true ||
    typeof v.version !== "string" ||
    !v.version ||
    typeof v.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    typeof v.token !== "string" ||
    !TOKEN.test(v.token)
  )
    throw new Error("The new link could not be verified and was discarded.");
  return v as { version: string; expiresAt: string; token: string };
}

export const isStaffVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);
