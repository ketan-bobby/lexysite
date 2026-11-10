export interface ScheduleApplication {
  id: string;
  stage: string;
  candidate: { name: string | null } | null;
  job: { title: string | null } | null;
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
    const candidate = row.candidate;
    const job = row.job;
    if (
      (candidate !== null &&
        (!candidate ||
          typeof candidate !== "object" ||
          !("name" in candidate) ||
          (candidate.name !== null && typeof candidate.name !== "string"))) ||
      (job !== null &&
        (!job ||
          typeof job !== "object" ||
          !("title" in job) ||
          (job.title !== null && typeof job.title !== "string")))
    )
      throw new Error("The candidate list could not be verified.");
    ids.add(row.id);
    return {
      id: row.id,
      stage: row.stage,
      candidate: candidate === null ? null : { name: (candidate as { name: string | null }).name },
      job: job === null ? null : { title: (job as { title: string | null }).title },
    };
  });
}

export function hasScheduleApplication(rows: ScheduleApplication[], id: string): boolean {
  return rows.some((row) => row.id === id && row.candidate !== null && row.job !== null);
}
