/**
 * work-order-approval.ts — pure logic behind the "Approve & Assign Recruiters"
 * flow on the work-order detail page.
 *
 * Extracted from pages/recruiter/jobs/[id].tsx so the approval gating and the
 * approve request payload can be unit-tested (test:work-order-approval). Keep
 * this in lockstep with the backend approve route in
 * artifacts/api-server/src/routes/jobs.ts:
 *   - HM-created jobs → tenant_admin / platform_admin / recruiter_admin approve
 *   - Recruiter-created jobs → the assigned HM, or any of the admin roles
 *   - Self-approval is additionally blocked SERVER-side (createdById === caller)
 */

export interface ApprovalJob {
  status: string;
  createdByRole?: string | null;
  assignedHiringManagerId?: string | null;
}

export interface ApprovalUser {
  id?: string;
  role?: string;
}

const ADMIN_APPROVER_ROLES = ["tenant_admin", "platform_admin", "recruiter_admin"];

/** Roles that see the multi-recruiter "Approve & Assign" dialog (vs plain approve). */
export const ASSIGN_ON_APPROVE_ROLES = ["tenant_admin", "platform_admin", "recruiter_admin"];

export function isHmCreated(job: ApprovalJob | null | undefined): boolean {
  return job?.createdByRole === "hiring_manager";
}

/** Mirrors the page's canApprove gate: may this user action the approval? */
export function canApproveWorkOrder(
  job: ApprovalJob | null | undefined,
  user: ApprovalUser | null | undefined,
): boolean {
  if (!job) return false;
  if (job.status !== "pending_approval") return false;
  if (isHmCreated(job)) return ADMIN_APPROVER_ROLES.includes(user?.role ?? "");
  return (
    ["hiring_manager", ...ADMIN_APPROVER_ROLES].includes(user?.role ?? "") &&
    (user?.role !== "hiring_manager" || job.assignedHiringManagerId === user?.id)
  );
}

/**
 * Body for PATCH /jobs/:id/approve. When a roster is selected the request
 * carries BOTH assignedRecruiterId (the lead = first pick) and
 * assignedRecruiterIds (the full roster). Empty roster → empty body
 * (approve without assigning).
 */
export function buildApprovePayload(recruiterIds?: (string | null | undefined)[]): {
  assignedRecruiterId?: string;
  assignedRecruiterIds?: string[];
} {
  const roster = (recruiterIds ?? []).filter((x): x is string => !!x);
  return roster.length ? { assignedRecruiterId: roster[0], assignedRecruiterIds: roster } : {};
}
