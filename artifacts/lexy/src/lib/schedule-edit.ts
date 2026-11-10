export interface ScheduleEditRecord extends Record<string, unknown> {
  id: string;
  applicationId: string;
  interviewerId: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  version: string;
  feedbackRating?: number | null;
  feedbackNotes?: string | null;
}

export function requireScheduleVersion(value: { version?: unknown }): string {
  if (typeof value.version !== "string" || !/^v1_[0-9a-f]{64}$/.test(value.version))
    throw new Error("Refresh the schedule to load its latest saved version before making changes.");
  return value.version;
}

function parseRecord(value: unknown): ScheduleEditRecord {
  if (!value || typeof value !== "object")
    throw new Error("The schedule response could not be verified.");
  const row = value as Record<string, unknown>;
  requireScheduleVersion(row);
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.applicationId !== "string" ||
    !row.applicationId ||
    typeof row.type !== "string" ||
    typeof row.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(row.scheduledAt)) ||
    typeof row.durationMinutes !== "number" ||
    !Number.isInteger(row.durationMinutes) ||
    row.durationMinutes < 5 ||
    row.durationMinutes > 480 ||
    !(row.interviewerId === null || typeof row.interviewerId === "string") ||
    !["pending", "scheduled", "confirmed", "rescheduled", "cancelled", "completed"].includes(
      String(row.status),
    ) ||
    !(
      row.feedbackRating == null ||
      (typeof row.feedbackRating === "number" &&
        Number.isInteger(row.feedbackRating) &&
        row.feedbackRating >= 1 &&
        row.feedbackRating <= 5)
    ) ||
    [
      "candidateName",
      "candidateEmail",
      "jobTitle",
      "interviewerName",
      "location",
      "notes",
      "feedbackNotes",
    ].some((key) => row[key] != null && typeof row[key] !== "string")
  )
    throw new Error("The schedule response could not be verified.");
  return row as ScheduleEditRecord;
}

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string" &&
      [400, 403, 404, 409].includes(response.status)
        ? body.error
        : "The server did not confirm this request.";
    throw Object.assign(new Error(message), { status: response.status });
  }
  return body;
}

export async function readAssignedSchedules(
  response: Response,
  userId: string,
): Promise<ScheduleEditRecord[]> {
  return (await readNativeSchedules(response)).filter((row) => row.interviewerId === userId);
}

export async function readNativeSchedules(response: Response): Promise<ScheduleEditRecord[]> {
  const body = await responseJson(response);
  if (!Array.isArray(body)) throw new Error("The interview queue could not be verified.");
  return body.map(parseRecord);
}

export async function readUpdatedSchedule(
  response: Response,
  id: string,
): Promise<ScheduleEditRecord> {
  const row = parseRecord(await responseJson(response));
  if (row.id !== id)
    throw new Error("The saved schedule does not match this interview. Refresh before continuing.");
  return row;
}
