export interface ScheduleApplication {
  id: string;
  stage: string;
  candidate: { name: string | null } | null;
  job: { title: string | null } | null;
}

function readCandidate(candidate: unknown): ScheduleApplication["candidate"] {
  if (candidate === null) return null;
  if (!candidate || typeof candidate !== "object")
    throw new Error("The candidate list could not be verified.");
  // /applications returns canonical name parts; older responses may have name.
  if ("name" in candidate) {
    if (candidate.name !== null && typeof candidate.name !== "string")
      throw new Error("The candidate list could not be verified.");
    return { name: candidate.name };
  }
  if (!("firstName" in candidate) && !("lastName" in candidate))
    throw new Error("The candidate list could not be verified.");
  const firstName = "firstName" in candidate ? candidate.firstName : null;
  const lastName = "lastName" in candidate ? candidate.lastName : null;
  if (
    (firstName !== null && typeof firstName !== "string") ||
    (lastName !== null && typeof lastName !== "string")
  )
    throw new Error("The candidate list could not be verified.");
  return { name: [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ") || null };
}

// Validate the picker boundary without retaining private fields it does not use.
export function parseScheduleApplications(body: unknown): ScheduleApplication[] {
  if (!Array.isArray(body)) throw new Error("The candidate list could not be verified.");
  const ids = new Set<string>();
  return body.map((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("id" in row) ||
      typeof row.id !== "string" ||
      !row.id.trim() ||
      !("stage" in row) ||
      typeof row.stage !== "string" ||
      !("candidate" in row) ||
      !("job" in row) ||
      ids.has(row.id)
    )
      throw new Error("The candidate list could not be verified.");
    const candidate = readCandidate(row.candidate);
    const job = row.job;
    if (
      job !== null &&
      (!job ||
        typeof job !== "object" ||
        !("title" in job) ||
        (job.title !== null && typeof job.title !== "string"))
    )
      throw new Error("The candidate list could not be verified.");
    ids.add(row.id);
    return {
      id: row.id,
      stage: row.stage,
      candidate,
      job: job === null ? null : { title: (job as { title: string | null }).title },
    };
  });
}

export function hasScheduleApplication(rows: ScheduleApplication[], id: string): boolean {
  return rows.some((row) => row.id === id && row.candidate !== null && row.job !== null);
}
