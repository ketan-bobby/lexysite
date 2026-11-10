import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { interviewSchedulesTable } from "@workspace/db";

const nullableFields = [
  "interviewerId",
  "interviewerName",
  "location",
  "notes",
  "feedbackRating",
  "feedbackNotes",
] as const;

export const SCHEDULE_CHANGED_MESSAGE =
  "This schedule changed. Review the latest saved details before trying again.";

// A content revision, not a credential. Authorization is always checked separately.
export function scheduleVersion(row: Record<string, unknown>): string {
  const instant = new Date(row.scheduledAt as string | Date).getTime();
  if (!Number.isFinite(instant)) throw new Error("Invalid saved schedule time");
  const snapshot = [
    row.id,
    row.tenantId,
    row.applicationId,
    instant,
    row.durationMinutes,
    row.type,
    row.status,
    ...nullableFields.map((field) => row[field] ?? null),
    ...(row.panelRevision ? [row.panelRevision] : []),
  ];
  return `v1_${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

export function scheduleSnapshotPredicate(row: typeof interviewSchedulesTable.$inferSelect) {
  return and(
    eq(interviewSchedulesTable.id, row.id),
    eq(interviewSchedulesTable.tenantId, row.tenantId),
    eq(interviewSchedulesTable.applicationId, row.applicationId),
    eq(interviewSchedulesTable.scheduledAt, row.scheduledAt),
    eq(interviewSchedulesTable.durationMinutes, row.durationMinutes),
    eq(interviewSchedulesTable.type, row.type),
    eq(interviewSchedulesTable.status, row.status),
    ...nullableFields.map(
      (field) => sql`${interviewSchedulesTable[field]} IS NOT DISTINCT FROM ${row[field] ?? null}`,
    ),
    sql`${interviewSchedulesTable.panelRevision} IS NOT DISTINCT FROM ${row.panelRevision ?? null}`,
  );
}
