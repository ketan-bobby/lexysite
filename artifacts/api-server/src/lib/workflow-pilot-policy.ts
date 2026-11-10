/** Shared scope rules for isolated pilots, not a global feature entitlement. */
export const WORKFLOW_PILOT_APPROVERS = ["platform_admin", "tenant_admin", "recruiter_admin"];
export const canControlWorkflowPilot = (role: string) => WORKFLOW_PILOT_APPROVERS.includes(role);
export const isIsolatedPilotJob = (title: string) => title.startsWith("[AUTONOMY PILOT] ");
