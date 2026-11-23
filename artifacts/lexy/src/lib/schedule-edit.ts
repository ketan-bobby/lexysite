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

function invalidScheduleFields(row: Record<string, unknown>): string[] {
  const invalid: string[] = [];
  try { requireScheduleVersion(row); } catch { invalid.push("version"); }
  for (const key of ["id", "applicationId", "type"])
    if (typeof row[key] !== "string" || !row[key]) invalid.push(key);
  if (typeof row.scheduledAt !== "string" || !Number.isFinite(Date.parse(row.scheduledAt)))
    invalid.push("scheduledAt");
  if (typeof row.durationMinutes !== "number" || !Number.isInteger(row.durationMinutes) ||
    row.durationMinutes < 5 || row.durationMinutes > 480) invalid.push("durationMinutes");
  if (!(row.interviewerId === null || typeof row.interviewerId === "string"))
    invalid.push("interviewerId");
  if (!["pending", "scheduled", "confirmed", "rescheduled", "cancelled", "completed"].includes(String(row.status)))
    invalid.push("status");
  if (!(
      row.feedbackRating == null ||
      (typeof row.feedbackRating === "number" &&
        Number.isInteger(row.feedbackRating) &&
        row.feedbackRating >= 1 &&
        row.feedbackRating <= 5)
    )) invalid.push("feedbackRating");
  for (const key of [
      "candidateName",
      "candidateEmail",
      "jobTitle",
      "interviewerName",
      "location",
      "notes",
      "feedbackNotes",
    ])
    if (row[key] != null && typeof row[key] !== "string") invalid.push(key);
  return invalid;
}

function parseRecord(value: unknown): ScheduleEditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The schedule response could not be verified.");
  const row = value as Record<string, unknown>;
  const invalid = invalidScheduleFields(row);
  if (invalid.length)
    throw new Error(`The schedule response could not be verified. Invalid fields: ${invalid.join(", ")}.`);
  return row as ScheduleEditRecord;
}

export interface UnverifiedScheduleSummary {
  position: number;
  id: string | null;
  candidateName: string | null;
  jobTitle: string | null;
  scheduledAt: string | null;
  invalidFields: string[];
}

export interface CoordinatorScheduleOverview {
  schedules: ScheduleEditRecord[];
  unverified: UnverifiedScheduleSummary[];
  total: number;
}

// List availability is separate from edit eligibility. Never cast an invalid
// row to ScheduleEditRecord or pass it to a mutation/provider control.
export async function readCoordinatorSchedules(response: Response): Promise<CoordinatorScheduleOverview> {
  const body = await responseJson(response);
  if (!Array.isArray(body)) throw new Error("The interview queue could not be verified.");
  const result: CoordinatorScheduleOverview = { schedules: [], unverified: [], total: body.length };
  const idCounts = new Map<string, number>();
  for (const value of body)
    if (value && typeof value === "object" && typeof value.id === "string")
      idCounts.set(value.id, (idCounts.get(value.id) ?? 0) + 1);
  body.forEach((value: unknown, position: number) => {
    const row: Record<string, unknown> =
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    const invalidFields = invalidScheduleFields(row);
    if (typeof row.id === "string" && (idCounts.get(row.id) ?? 0) > 1)
      invalidFields.push("duplicate id");
    if (!invalidFields.length) {
      result.schedules.push(parseRecord(row));
      return;
    }
    const text = (key: string) => typeof row[key] === "string" ? row[key] as string : null;
    result.unverified.push({
      position,
      id: text("id"),
      candidateName: text("candidateName"),
      jobTitle: text("jobTitle"),
      scheduledAt: typeof row.scheduledAt === "string" && Number.isFinite(Date.parse(row.scheduledAt))
        ? row.scheduledAt : null,
      invalidFields,
    });
  });
  return result;
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
