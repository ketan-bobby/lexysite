import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { interviewSchedulesTable } from "@workspace/db";
import type { db } from "@workspace/db";

type Schedule = typeof interviewSchedulesTable.$inferSelect;
type ScheduleInput = Pick<
  Schedule,
  | "applicationId"
  | "interviewerId"
  | "interviewerName"
  | "location"
  | "scheduledAt"
  | "durationMinutes"
  | "type"
  | "notes"
>;

// Durable operation identity without a new table, secret, or in-memory receipt.
// UUIDv8 uses a namespaced SHA-256 digest, scoped to the authenticated creator.
export function scheduleRequestId(callerId: string, requestId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["lexy/native-schedule/v1", callerId, requestId.toLowerCase()]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sameScheduleInput(saved: ScheduleInput, input: ScheduleInput): boolean {
  return (
    saved.applicationId === input.applicationId &&
    saved.scheduledAt.getTime() === input.scheduledAt.getTime() &&
    saved.durationMinutes === input.durationMinutes &&
    saved.type === input.type &&
    (["interviewerId", "interviewerName", "location", "notes"] as const).every(
      (key) => (saved[key] ?? null) === (input[key] ?? null),
    )
  );
}

export class ScheduleSaveConflict extends Error {
  constructor() {
    super(
      "This save already exists with different or updated details. Refresh the schedule list before making another change.",
    );
  }
}

export async function createScheduleOnce(
  database: Pick<typeof db, "insert" | "select">,
  values: typeof interviewSchedulesTable.$inferInsert,
  callerId: string,
  requestId?: string,
): Promise<{ schedule: Schedule; replayed: boolean }> {
  if (!requestId) {
    const [schedule] = await database.insert(interviewSchedulesTable).values(values).returning();
    if (!schedule) throw new Error("Schedule insert was not confirmed");
    return { schedule, replayed: false };
  }
  const id = scheduleRequestId(callerId, requestId);
  // The primary key arbitrates parallel inserts across processes and restarts.
  const [created] = await database
    .insert(interviewSchedulesTable)
    .values({ ...values, id })
    .onConflictDoNothing({ target: interviewSchedulesTable.id })
    .returning();
  if (created) return { schedule: created, replayed: false };
  const [existing] = await database
    .select()
    .from(interviewSchedulesTable)
    .where(
      and(
        eq(interviewSchedulesTable.id, id),
        eq(interviewSchedulesTable.tenantId, values.tenantId),
        eq(interviewSchedulesTable.applicationId, values.applicationId),
      ),
    )
    .limit(1);
  if (!existing || !sameScheduleInput(existing, values as ScheduleInput))
    throw new ScheduleSaveConflict();
  return { schedule: existing, replayed: true };
}
