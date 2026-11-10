import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  usersTable as users,
  staffGoogleCalendarsTable as grants,
  googlePanelConsentsTable as consents,
} from "@workspace/db";
import { z } from "zod/v4";
import { readSchedulePanel } from "./saved-panel-view";
import {
  assertGooglePanelBindings,
  readSavedPanelMembers,
  savedPanelProvider,
} from "./saved-panel-members";
import { googlePanelShared } from "./google-panel-times";
import {
  memberAllowed,
  type PanelCaller,
  type PanelSchedule,
  type PanelTx,
} from "./calendar-panel-access";
import { digest, googleStaffConfig, googleStaffFailure } from "./google-staff-config";

export type GoogleInvitationPanel = {
  bufferMinutes?: number;
  revision: string;
  binding: string;
  recipients: Array<{
    userId: string;
    email: string;
    subjectHash: string;
    connectionRevision: string;
    grantedAt: string;
  }>;
};
export function sameGoogleInvitationPanel(
  scheduleRevision: string | null,
  current: GoogleInvitationPanel | undefined,
  receipt: { revision: string; binding: string } | undefined,
) {
  return scheduleRevision
    ? !!current &&
        !!receipt &&
        current.revision === scheduleRevision &&
        receipt.revision === current.revision &&
        receipt.binding === current.binding
    : !current && !receipt;
}
/** Locks are acquired before the organizer grant, in the shared panel lock order.
 * Availability consent is NOT invitation-write consent; the organizer must
 * separately hold that permission and approve the entire recipient snapshot.
 */
export async function readGoogleInvitationPanel(
  tx: PanelTx,
  caller: Pick<PanelCaller, "id" | "tenantId" | "role">,
  row: PanelSchedule,
  lock = false,
): Promise<GoogleInvitationPanel | undefined> {
  if (!row.schedule.panelRevision) return undefined;
  const saved = await readSchedulePanel(tx, row);
  const fail = () => googleStaffFailure("google_panel_changed", 409);
  const cfg = googleStaffConfig();
  if (
    !saved ||
    saved.coordinatorId !== caller.id ||
    !cfg ||
    savedPanelProvider(saved.members) !== "google"
  )
    throw fail();
  const ids = readSavedPanelMembers(saved.members)
    .map((member) => member.userId)
    .sort();
  if (!ids.length) throw fail();
  const allIds = [...new Set([...ids, caller.id])].sort();
  const tenants = [
    ...new Set([caller.tenantId, row.job.tenantId].filter((id): id is string => !!id)),
  ];
  if (lock) {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, allIds), inArray(users.tenantId, tenants)))
      .orderBy(users.id)
      .for("share");
    await tx
      .select({ id: grants.userId })
      .from(grants)
      .where(and(inArray(grants.userId, allIds), inArray(grants.tenantId, tenants)))
      .orderBy(grants.userId)
      .for("update");
    await tx
      .select({ id: consents.userId })
      .from(consents)
      .where(and(inArray(consents.userId, ids), inArray(consents.tenantId, tenants)))
      .orderBy(consents.userId)
      .for("share");
  }
  const people = await tx
    .select({
      member: {
        id: users.id,
        tenantId: users.tenantId,
        role: users.role,
        status: users.status,
        accountErasedAt: users.accountErasedAt,
        name: users.name,
      },
      connection: grants,
      consent: consents,
    })
    .from(users)
    .innerJoin(grants, and(eq(grants.userId, users.id), eq(grants.tenantId, users.tenantId)))
    .innerJoin(consents, and(eq(consents.userId, users.id), eq(consents.tenantId, users.tenantId)))
    .where(
      and(
        inArray(users.id, ids),
        inArray(users.tenantId, tenants),
        inArray(users.role, [
          "platform_admin",
          "tenant_admin",
          "recruiter_admin",
          "recruiter",
          "hiring_manager",
          "interviewer",
        ]),
        eq(users.status, "active"),
        isNull(users.accountErasedAt),
      ),
    )
    .orderBy(users.id);
  if (people.length !== ids.length) throw fail();
  for (const p of people)
    if (!googlePanelShared(p, cfg.fingerprint) || !(await memberAllowed(p.member, row, tx)))
      throw fail();
  assertGooglePanelBindings(saved.members, people);
  const recipients = people.map((p) => ({
    userId: p.member.id,
    email: p.connection.accountEmail!.trim().toLowerCase(),
    subjectHash: digest(p.connection.subject!),
    connectionRevision: p.connection.revision,
    grantedAt: p.consent.grantedAt.toISOString(),
  }));
  if (
    recipients.some((p) => !z.email().safeParse(p.email).success) ||
    new Set(recipients.map((p) => p.email)).size !== recipients.length ||
    recipients.some((p) => p.email === row.candidate.email.trim().toLowerCase())
  )
    throw fail();
  return {
    bufferMinutes: saved.bufferMinutes,
    revision: saved.revision,
    recipients,
    binding: digest(JSON.stringify([saved.revision, saved.coordinatorId, recipients])),
  };
}
