import type { StaffGoogleCalendar } from "@workspace/db";
import { CalendarError } from "./outlook-calendar-core";
import { commonPanelSlots, type PanelBusyInterval } from "./panel-calendar-slots";
import type { PanelCaller } from "./calendar-panel-access";

export const googlePanelUnknown = () =>
  new CalendarError(
    503,
    "panel_unknown",
    "One or more calendars could not be verified. Availability is unknown.",
  );
export type GooglePanelMember = Pick<
  PanelCaller,
  "id" | "tenantId" | "role" | "status" | "accountErasedAt"
> & { name: string };
export type GooglePanelPerson = {
  member: GooglePanelMember;
  connection: StaffGoogleCalendar;
  consent: { userId: string; tenantId: string; connectionRevision: string; grantedAt: Date };
};
const roles = [
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
];
export function googlePanelGrantReady(
  m: GooglePanelMember,
  c: StaffGoogleCalendar,
  fingerprint: string,
) {
  return !!(
    fingerprint &&
    m.status === "active" &&
    !m.accountErasedAt &&
    roles.includes(m.role) &&
    m.tenantId &&
    c.userId === m.id &&
    c.tenantId === m.tenantId &&
    c.revision &&
    c.subject &&
    c.accountEmail &&
    c.refreshTokenEnc &&
    c.connectedAt &&
    Number.isFinite(c.connectedAt.getTime()) &&
    !c.needsReconnect &&
    c.clientFingerprint === fingerprint
  );
}
export function googlePanelShared(p: GooglePanelPerson, fingerprint: string) {
  const { member: m, connection: c, consent: s } = p;
  return (
    googlePanelGrantReady(m, c, fingerprint) &&
    s.userId === m.id &&
    s.tenantId === m.tenantId &&
    s.connectionRevision === c.revision &&
    Number.isFinite(s.grantedAt.getTime())
  );
}
export function googlePanelConsentView(
  member: GooglePanelMember,
  grant: StaffGoogleCalendar | undefined,
  consent: GooglePanelPerson["consent"] | undefined,
  fingerprint: string | null,
) {
  const owned = grant?.userId === member.id && grant?.tenantId === member.tenantId;
  // A saved permission can be withdrawn even with a broken provider/config.
  // It is never sufficient for a calendar read without googlePanelShared().
  const enabled = !!(
    owned &&
    consent &&
    consent.userId === member.id &&
    consent.tenantId === member.tenantId &&
    consent.connectionRevision === grant?.revision &&
    Number.isFinite(consent.grantedAt.getTime())
  );
  return {
    enabled,
    canEnable: !!(
      owned &&
      fingerprint &&
      grant &&
      googlePanelGrantReady(member, grant, fingerprint)
    ),
    revision: owned ? grant!.revision : null,
    grantedAt: enabled ? consent!.grantedAt.toISOString() : null,
  };
}
export interface GooglePanelInput {
  expectedVersion: string;
  userIds: string[];
  start: string;
  end: string;
  bufferMinutes: number;
}
export interface GooglePanelSnapshot {
  scheduleId: string;
  version: string;
  durationMinutes: number;
  people: GooglePanelPerson[];
  allows: (start: number, end: number) => boolean;
}
export interface GooglePanelTimesResult {
  scheduleId: string;
  version: string;
  checkedAt: string;
  panelSize: number;
  durationMinutes: number;
  slots: { start: string; end: string }[];
  calendarReserved: false;
  invitationSent: false;
}
export interface GooglePanelDependencies {
  fingerprint: string;
  snapshot(): Promise<GooglePanelSnapshot>;
  refresh(person: GooglePanelPerson): Promise<string>;
  locked(
    work: (current: GooglePanelSnapshot) => Promise<GooglePanelTimesResult>,
  ): Promise<GooglePanelTimesResult>;
  read(token: string, start: string, end: string): Promise<PanelBusyInterval[]>;
  now?: () => number;
  minimumNoticeMinutes?: 0 | 15;
}
function validateSnapshot(s: GooglePanelSnapshot, input: GooglePanelInput, fingerprint: string) {
  if (
    s.version !== input.expectedVersion ||
    s.people.length !== input.userIds.length ||
    new Set(s.people.map((p) => p.member.id)).size !== input.userIds.length ||
    !s.people.every((p) => input.userIds.includes(p.member.id) && googlePanelShared(p, fingerprint))
  )
    throw new CalendarError(
      409,
      "panel_changed",
      "The interview or sharing permission changed. Search again.",
    );
}
export async function searchGooglePanelTimes(
  input: GooglePanelInput,
  deps: GooglePanelDependencies,
) {
  const now = deps.now ?? Date.now;
  const slotNow = () => now() - (15 - (deps.minimumNoticeMinutes ?? 15)) * 60000;
  // Validate before touching any authorization grant or provider.
  if (
    new Set(input.userIds).size !== input.userIds.length ||
    Date.parse(input.start) < now() ||
    Date.parse(input.end) > now() + 90 * 86400_000
  )
    throw new CalendarError(
      400,
      "invalid_panel_window",
      "Choose unique panel members and a window in the next 90 days.",
    );
  commonPanelSlots(
    input.userIds.map(() => []),
    { ...input, durationMinutes: 5 },
    slotNow(),
  );
  const first = await deps.snapshot();
  validateSnapshot(first, input, deps.fingerprint);
  commonPanelSlots(
    first.people.map(() => []),
    { ...input, durationMinutes: first.durationMinutes },
    slotNow(),
  );
  // Refresh outside calendar/consent locks. Persist rotated credentials before
  // the read transaction; a later search failure must not roll a rotation back.
  let tokens: Map<string, string>;
  try {
    tokens = new Map(
      await Promise.all(
        first.people.map(async (p) => [p.member.id, await deps.refresh(p)] as const),
      ),
    );
  } catch {
    throw googlePanelUnknown();
  }
  return deps.locked(async (current) => {
    validateSnapshot(current, input, deps.fingerprint);
    if (
      current.scheduleId !== first.scheduleId ||
      current.durationMinutes !== first.durationMinutes ||
      current.people.some((p) => {
        const prior = first.people.find((q) => q.member.id === p.member.id);
        return (
          !prior ||
          prior.connection.revision !== p.connection.revision ||
          prior.connection.subject !== p.connection.subject ||
          prior.consent.grantedAt.getTime() !== p.consent.grantedAt.getTime()
        );
      })
    )
      throw new CalendarError(409, "panel_changed", "The panel changed. Search again.");
    const pad = input.bufferMinutes * 60000;
    let calendars: PanelBusyInterval[][];
    try {
      calendars = await Promise.all(
        current.people.map((p) =>
          deps.read(
            tokens.get(p.member.id)!,
            new Date(Date.parse(input.start) - pad).toISOString(),
            new Date(Date.parse(input.end) + pad).toISOString(),
          ),
        ),
      );
    } catch {
      throw googlePanelUnknown();
    }
    return {
      scheduleId: current.scheduleId,
      version: current.version,
      checkedAt: new Date(now()).toISOString(),
      panelSize: current.people.length,
      durationMinutes: current.durationMinutes,
      slots: commonPanelSlots(
        calendars,
        { ...input, durationMinutes: current.durationMinutes },
        slotNow(),
        current.allows,
      ),
      calendarReserved: false as const,
      invitationSent: false as const,
    };
  });
}
