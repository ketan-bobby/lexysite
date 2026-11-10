/**
 * Recognize only schema failures involving this feature's own private table.
 * Never turn unrelated persistence failures into a misleading migration error.
 * PostgreSQL errors are commonly wrapped by Drizzle with the SQL on the parent.
 */
export function offeredTimesSchemaUnavailable(error: unknown): boolean {
  let node = error;
  let offeredQuery = false;
  let schemaFailure = false;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8 && node && typeof node === "object"; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const current = node as {
      query?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      where?: unknown;
      internalQuery?: unknown;
    };
    if (
      typeof current.query === "string" &&
      /\b(?:from|into|update)\s+"?interview_offered_times"?\b/i.test(current.query)
    )
      offeredQuery = true;
    if (
      current.code === "42P01" &&
      typeof current.message === "string" &&
      /relation "(?:[a-z_][a-z0-9_]*\.)?interview_offered_times" does not exist/.test(
        current.message,
      )
    )
      return true;
    // A trigger may fail on some OTHER relation. Do not misdiagnose that as
    // this feature's migration, even though the outer SQL mentions our table.
    if (current.code === "42P01" && typeof current.message === "string") return false;
    if (
      !current.where &&
      !current.internalQuery &&
      (current.code === "42P01" || current.code === "42703")
    )
      schemaFailure = true;
    node = current.cause;
  }
  return offeredQuery && schemaFailure;
}
