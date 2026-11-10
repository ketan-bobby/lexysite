import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  calendarPanelConsentsTable as consents,
  calendarWorkingHoursTable as hours,
  usersTable,
} from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import { getDataScopeTenantIds, type TenantScopeReader } from "./tenantUtils";
import { recruiterOwnsResource } from "./ownership";
import { CalendarError, calendarEvents } from "./outlook-calendar-core";
import { outlookCalendarRequest } from "./outlook-calendar";
import { workingHoursPolicy } from "./calendar-working-hours";
import type { visibleSchedule } from "../routes/outlook-calendar";

export type PanelCaller = Awaited<ReturnType<typeof calendarStaff>>;
export type PanelSchedule = Awaited<ReturnType<typeof visibleSchedule>>;
export type PanelTx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
export const mailboxHash = (id: string) => createHash("sha256").update(id).digest("hex");
export function unavailable() {
  return new CalendarError(
    409,
    "panel_changed",
    "The panel, sharing consent or interview changed. Reload and check again; availability is unknown.",
  );
}
export async function storage(tx: PanelTx, table = "calendar_panel_consents") {
  const proof = await tx.execute(sql`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS no_policies,
      NOT has_table_privilege('lexy_app',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS private,
      NOT has_any_column_privilege('lexy_app',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') AS private_columns
    FROM pg_class c WHERE c.oid=to_regclass(${table})
  `);
  if (!proof.rows[0] || Object.values(proof.rows[0]).some((value) => value !== true))
    throw new CalendarError(
      503,
      "panel_unavailable",
      "Panel availability is temporarily unavailable. No booking was confirmed.",
    );
}
export async function memberAllowed(
  member: Pick<PanelCaller, "id" | "tenantId" | "role">,
  row: PanelSchedule,
  reader?: TenantScopeReader,
) {
  const allowed = await getDataScopeTenantIds(member, reader);
  if (allowed !== null && !allowed.includes(row.job.tenantId)) return false;
  if (member.role === "hiring_manager") return row.job.assignedHiringManagerId === member.id;
  if (["interviewer", "tenant_admin", "platform_admin"].includes(member.role)) return true;
  return recruiterOwnsResource(member, { kind: "jobId", value: row.job.id }, reader);
}
export async function members(
  caller: PanelCaller,
  row: PanelSchedule,
  tx: PanelTx,
  selected?: string[],
) {
  const tenants = [...new Set([caller.tenantId, row.job.tenantId].filter((v): v is string => !!v))];
  const roles = [
    "platform_admin",
    "tenant_admin",
    "recruiter_admin",
    "recruiter",
    "hiring_manager",
    "interviewer",
  ];
  const rows = await tx
    .select({ member: usersTable, consent: consents })
    .from(usersTable)
    .innerJoin(
      consents,
      and(eq(consents.userId, usersTable.id), eq(consents.tenantId, usersTable.tenantId)),
    )
    .where(
      and(
        inArray(usersTable.tenantId, tenants),
        eq(usersTable.status, "active"),
        inArray(usersTable.role, roles as Array<typeof usersTable.$inferSelect.role>),
        selected ? inArray(usersTable.id, selected) : undefined,
      ),
    )
    .limit(101)
    .for("share");
  if (rows.length > 100)
    throw new CalendarError(
      409,
      "panel_directory_large",
      "The panel directory is too large. Contact your administrator.",
    );
  const result: typeof rows = [];
  for (const entry of rows) if (await memberAllowed(entry.member, row)) result.push(entry);
  return result;
}
export async function panelCalendars(
  tx: PanelTx,
  panel: Awaited<ReturnType<typeof members>>,
  start: string,
  end: string,
  bufferMinutes: number,
) {
  await storage(tx, "calendar_working_hours");
  const preferences = await tx
    .select()
    .from(hours)
    .where(
      inArray(
        hours.userId,
        panel.map((p) => p.member.id),
      ),
    )
    .for("share");
  let policies: ReturnType<typeof workingHoursPolicy>[];
  try {
    policies = panel.map(({ member }) => {
      const preference = preferences.find(
        (p) => p.userId === member.id && p.tenantId === member.tenantId,
      );
      return preference
        ? workingHoursPolicy(preference.timeZone, preference.windows)
        : workingHoursPolicy(null, []);
    });
  } catch {
    throw new CalendarError(
      503,
      "working_hours_unknown",
      "One or more working-hour settings could not be verified. Availability is unknown.",
    );
  }
  const buffer = bufferMinutes * 60000;
  const calendars = await Promise.all(
    panel.map(async ({ member, consent }) => {
      const graph = await outlookCalendarRequest(member.id);
      const mailbox = await graph<{ id: string }>("/me?$select=id");
      if (!mailbox?.id || mailboxHash(mailbox.id) !== consent.mailboxHash) throw unavailable();
      return calendarEvents(
        graph,
        new Date(Date.parse(start) - buffer).toISOString(),
        new Date(Date.parse(end) + buffer).toISOString(),
      );
    }),
  );
  return {
    calendars,
    allows: (a: number, b: number) => policies.every((p) => p.allows(a - buffer, b + buffer)),
  };
}
