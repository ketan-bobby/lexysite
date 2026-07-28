/* Job-approval gate for interview actions.
 *
 * A recruiter-created work order enters `pending_approval` and must be approved
 * by a recruiter_admin (status → `active`) before ANY interview can be run or
 * invited. A rejected work order reverts to `draft` (with a rejection note), so
 * `draft` and `rejected` are likewise not yet cleared for interviews.
 *
 * This is a BLOCKLIST (not an allowlist) so any future job_status defaults to
 * "allowed" rather than silently blocking a legitimate flow. Keep the blocked
 * set in sync with the job_status enum in lib/db/src/schema/jobs.ts.
 */
export const UNAPPROVED_JOB_STATUSES = ["pending_approval", "draft", "rejected"] as const;

/** True once a work order is cleared for interviewing (i.e. NOT awaiting / sent
 *  back from recruiter_admin approval). */
export function isJobApprovedForInterview(status: string | null | undefined): boolean {
  return status != null && !(UNAPPROVED_JOB_STATUSES as readonly string[]).includes(status);
}

/** Human-facing reason shown when an interview action is blocked on approval. */
export const JOB_NOT_APPROVED_MESSAGE =
  "This work order is awaiting approval — interviews can't be created until a recruiter admin approves it.";
