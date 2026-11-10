/** A tenant membership alone does not authorize reading the staff audit trail. */
export function isAuditViewerRole(role: string) {
  return [
    "platform_admin",
    "tenant_admin",
    "recruiter_admin",
    "recruiter",
    "hiring_manager",
  ].includes(role);
}
