import { controlDb, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CalendarError } from "./outlook-calendar-core";

export async function calendarStaff(userId: string | null) {
  if (!userId) throw new CalendarError(401, "unauthenticated", "Please sign in.");
  const [caller] = await controlDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!caller || caller.status !== "active")
    throw new CalendarError(401, "unauthenticated", "Please sign in with an active staff account.");
  if (
    ![
      "platform_admin",
      "tenant_admin",
      "recruiter_admin",
      "recruiter",
      "hiring_manager",
      "interviewer",
    ].includes(caller.role)
  ) {
    throw new CalendarError(
      403,
      "staff_required",
      "Calendar coordination requires a recruiter or administrator account.",
    );
  }
  return caller;
}
