import type { Response } from "express";

/**
 * Work-order (job) approval gate.
 *
 * A job created by a recruiter starts life in `pending_approval` (or `draft` /
 * `rejected` after a return) and must be signed off by a tenant_admin or
 * recruiter_admin before any candidate work happens against it. Until then no
 * candidate may be added, sourced, enrolled in outreach, or moved through the
 * pipeline for that requisition.
 *
 * `active` / `published` / `paused` / `closed` are all post-approval states —
 * the work order has cleared review — so they are considered actionable here.
 * The pre-approval states below are the only ones that block candidate actions.
 */
export const PRE_APPROVAL_JOB_STATUSES = ["draft", "pending_approval", "rejected"] as const;

export function isJobApproved(status: string | null | undefined): boolean {
  return !!status && !(PRE_APPROVAL_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Guard for candidate-action routes. Returns true when the job has cleared
 * approval; otherwise writes a 409 response and returns false so the caller can
 * `if (!assertJobApproved(res, job.status)) return;` and stop.
 */
export function assertJobApproved(res: Response, status: string | null | undefined): boolean {
  if (isJobApproved(status)) return true;
  res.status(409).json({
    error: "This work order is awaiting approval. Candidate actions are unavailable until a tenant admin or recruiter admin approves it.",
    code: "JOB_NOT_APPROVED",
  });
  return false;
}
