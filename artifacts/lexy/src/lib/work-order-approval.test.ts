/**
 * work-order-approval.test.ts — guards the "Approve & Assign Recruiters" flow
 * for recruiter_admin (and the other approver roles).
 *
 * A UI-level regression in canApproveWorkOrder would silently HIDE the approval
 * action from an authorized recruiter_admin; a regression in
 * buildApprovePayload would drop the multi-recruiter roster from the
 * PATCH /jobs/:id/approve request. Both are pinned here.
 *
 * Run: pnpm --filter lexy test:work-order-approval
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canApproveWorkOrder,
  buildApprovePayload,
  isHmCreated,
  ASSIGN_ON_APPROVE_ROLES,
} from "./work-order-approval";

const pendingRecruiterJob = {
  status: "pending_approval",
  createdByRole: "recruiter",
  assignedHiringManagerId: "hm-1",
};
const pendingHmJob = {
  status: "pending_approval",
  createdByRole: "hiring_manager",
  assignedHiringManagerId: null,
};

/* ── canApprove gate ─────────────────────────────────────────────────────── */

test("recruiter_admin sees the approval action on a pending_approval work order", () => {
  const ra = { id: "ra-1", role: "recruiter_admin" };
  assert.equal(canApproveWorkOrder(pendingRecruiterJob, ra), true);
  // HM-created work orders too — recruiter_admin is an admin approver.
  assert.equal(canApproveWorkOrder(pendingHmJob, ra), true);
});

test("recruiter_admin is in the Approve & Assign (multi-recruiter dialog) role set", () => {
  assert.ok(ASSIGN_ON_APPROVE_ROLES.includes("recruiter_admin"));
  assert.ok(ASSIGN_ON_APPROVE_ROLES.includes("tenant_admin"));
  assert.ok(!ASSIGN_ON_APPROVE_ROLES.includes("recruiter"));
  assert.ok(!ASSIGN_ON_APPROVE_ROLES.includes("hiring_manager"));
});

test("tenant_admin and platform_admin can approve both job kinds", () => {
  for (const role of ["tenant_admin", "platform_admin"]) {
    assert.equal(canApproveWorkOrder(pendingRecruiterJob, { id: "u", role }), true);
    assert.equal(canApproveWorkOrder(pendingHmJob, { id: "u", role }), true);
  }
});

test("hiring_manager can approve only recruiter-created jobs assigned to THEM", () => {
  assert.equal(
    canApproveWorkOrder(pendingRecruiterJob, { id: "hm-1", role: "hiring_manager" }),
    true,
  );
  assert.equal(
    canApproveWorkOrder(pendingRecruiterJob, { id: "hm-2", role: "hiring_manager" }),
    false,
  );
  // HMs never approve HM-created jobs (that's the admin's job).
  assert.equal(canApproveWorkOrder(pendingHmJob, { id: "hm-1", role: "hiring_manager" }), false);
});

test("plain recruiter and candidate never see the approval action", () => {
  for (const role of ["recruiter", "candidate", undefined]) {
    assert.equal(canApproveWorkOrder(pendingRecruiterJob, { id: "u", role }), false);
    assert.equal(canApproveWorkOrder(pendingHmJob, { id: "u", role }), false);
  }
});

test("approval action is hidden for non-pending statuses and missing job", () => {
  const ra = { id: "ra-1", role: "recruiter_admin" };
  for (const status of ["draft", "active", "rejected", "closed"]) {
    assert.equal(canApproveWorkOrder({ ...pendingRecruiterJob, status }, ra), false);
  }
  assert.equal(canApproveWorkOrder(null, ra), false);
  assert.equal(canApproveWorkOrder(undefined, ra), false);
});

test("isHmCreated flags only hiring_manager-created jobs", () => {
  assert.equal(isHmCreated(pendingHmJob), true);
  assert.equal(isHmCreated(pendingRecruiterJob), false);
  assert.equal(isHmCreated(null), false);
});

/* ── approve request payload ─────────────────────────────────────────────── */

test("multi-recruiter roster → payload carries BOTH lead and full roster", () => {
  const payload = buildApprovePayload(["rec-1", "rec-2", "rec-3"]);
  assert.deepEqual(payload, {
    assignedRecruiterId: "rec-1", // first pick = lead
    assignedRecruiterIds: ["rec-1", "rec-2", "rec-3"],
  });
});

test("single recruiter → lead + one-element roster", () => {
  assert.deepEqual(buildApprovePayload(["rec-9"]), {
    assignedRecruiterId: "rec-9",
    assignedRecruiterIds: ["rec-9"],
  });
});

test("empty / falsy roster → empty body (approve without assigning)", () => {
  assert.deepEqual(buildApprovePayload([]), {});
  assert.deepEqual(buildApprovePayload(undefined), {});
  assert.deepEqual(buildApprovePayload([null, undefined, ""]), {});
});

test("falsy entries are filtered but order is preserved", () => {
  assert.deepEqual(buildApprovePayload([null, "rec-2", "", "rec-1"]), {
    assignedRecruiterId: "rec-2",
    assignedRecruiterIds: ["rec-2", "rec-1"],
  });
});
