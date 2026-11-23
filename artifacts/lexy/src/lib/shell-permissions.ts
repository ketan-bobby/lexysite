/** UI request eligibility only; API authorization remains authoritative. */
export function canReadAgentStatus(role?: string | null): boolean {
  return ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"].includes(role ?? "");
}

export function canReadImpersonation(role?: string | null): boolean {
  return role === "platform_admin";
}
