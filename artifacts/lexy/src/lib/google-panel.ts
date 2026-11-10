export const STAFF_SEARCH_ROLES = [
  "recruiter",
  "recruiter_admin",
  "platform_admin",
  "tenant_admin",
];
export const RESULT_TTL_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);

export interface ConsentView {
  enabled: boolean;
  canEnable: boolean;
  revision: string | null;
  grantedAt: string | null;
}
export function parseConsent(v: unknown): ConsentView | null {
  const r = v as Partial<ConsentView> | null;
  if (!r || typeof r.enabled !== "boolean" || typeof r.canEnable !== "boolean") return null;
  if (r.revision !== null && !isUuid(r.revision)) return null;
  if (r.canEnable && r.revision === null) return null;
  if (r.enabled ? !Number.isFinite(ms(r.grantedAt)) || r.revision === null : r.grantedAt !== null)
    return null;
  return r as ConsentView;
}

export interface Member {
  id: string;
  name: string;
}
export function parseMembers(
  v: unknown,
  scheduleId: string,
): { version: string; members: Member[] } | null {
  const r = v as { scheduleId?: unknown; version?: unknown; members?: Member[] } | null;
  if (
    !r ||
    r.scheduleId !== scheduleId ||
    typeof r.version !== "string" ||
    !r.version ||
    !Array.isArray(r.members)
  )
    return null;
  if (!r.members.every((m) => m && typeof m.id === "string" && m.id && typeof m.name === "string"))
    return null;
  if (new Set(r.members.map((m) => m.id)).size !== r.members.length) return null;
  return { version: r.version, members: r.members };
}

export interface SearchCtx {
  scheduleId: string;
  version: string;
  durationMinutes: number;
  panelSize: number;
  start: string;
  end: string;
  now: number;
}
export function parseTimes(
  v: unknown,
  c: SearchCtx,
): { checkedAt: string; slots: { start: string; end: string }[] } | null {
  const r = v as Record<string, unknown> | null;
  if (
    !r ||
    r.scheduleId !== c.scheduleId ||
    r.version !== c.version ||
    r.panelSize !== c.panelSize ||
    r.durationMinutes !== c.durationMinutes
  )
    return null;
  if (
    r.calendarReserved !== false ||
    r.invitationSent !== false ||
    !Number.isFinite(ms(r.checkedAt)) ||
    !Array.isArray(r.slots) ||
    r.slots.length > 40
  )
    return null;
  const ws = Date.parse(c.start),
    we = Date.parse(c.end);
  const slots: { start: string; end: string }[] = [];
  for (const s of r.slots as { start?: unknown; end?: unknown }[]) {
    const a = ms(s?.start),
      b = ms(s?.end);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      b - a !== c.durationMinutes * 60_000 ||
      a < ws ||
      b > we ||
      a < c.now + 15 * 60_000
    )
      return null;
    slots.push({ start: new Date(a).toISOString(), end: new Date(b).toISOString() });
  }
  return { checkedAt: r.checkedAt as string, slots };
}

export interface SavedPanelView {
  provider: "google" | "outlook" | null;
  version: string;
  scheduledAt: string;
  bufferMinutes: number;
  members: Member[];
}
/** Strict guard. Missing provider is a legacy Outlook response; null means no active panel. */
export function parseSavedPanel(
  v: unknown,
  c: { scheduleId: string; durationMinutes: number },
): SavedPanelView | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || r.scheduleId !== c.scheduleId) return null;
  if (typeof r.version !== "string" || !r.version) return null;
  if (r.durationMinutes !== c.durationMinutes) return null;
  if (!Number.isFinite(ms(r.scheduledAt))) return null;
  if (r.calendarReserved !== false || r.invitationSent !== false) return null;
  const b = r.bufferMinutes;
  if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 60) return null;
  const ms_ = r.members;
  if (!Array.isArray(ms_) || ms_.length > 5) return null;
  if (!ms_.every((m) => m && typeof m.id === "string" && m.id && typeof m.name === "string"))
    return null;
  if (new Set(ms_.map((m: Member) => m.id)).size !== ms_.length) return null;
  let provider: SavedPanelView["provider"];
  if (r.provider === "google" || r.provider === "outlook" || r.provider === null)
    provider = r.provider;
  else if (r.provider === undefined) provider = "outlook";
  else return null;
  if (provider === null && ms_.length > 0) return null;
  return {
    provider,
    version: r.version,
    scheduledAt: r.scheduledAt as string,
    bufferMinutes: b,
    members: ms_ as Member[],
  };
}
