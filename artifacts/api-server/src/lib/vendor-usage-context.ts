import { vendorUsageScope, type UsageScope } from "./vendor-usage";

export type UsageActivity =
  | "screening"
  | "matching"
  | "intelligence"
  | "assessment"
  | "interview"
  | "development_private"
  | "recruiter"
  | "other";

/** Labels only. Never grants execution authority or carries candidate/job IDs.
 * A validated bound workflow keeps its original attribution. */
export function withUsageActivity<T>(
  tenantId: string | null,
  activity: UsageActivity,
  work: () => T,
): T {
  const current = vendorUsageScope.getStore();
  if (current?.tenantId === tenantId && current.area.startsWith("workflow:")) return work();
  const scope: UsageScope = { tenantId, area: `activity:${activity}` };
  return vendorUsageScope.run(scope, work);
}

/** Fixed labels, not paths or user input. Candidate development stays private. */
export function requestUsageActivity(path: string, candidate: boolean): UsageActivity {
  if (candidate || /^\/(learning|career-profile|candidate-portal)(\/|$)/.test(path))
    return "development_private";
  if (/^\/interviews(\/|$)/.test(path)) return "interview";
  if (/^\/(intelligence|evaluations)(\/|$)/.test(path)) return "intelligence";
  if (/^\/(screening|resume-screens)(\/|$)/.test(path)) return "screening";
  if (/^\/(talent-match|sourcing|icp)(\/|$)/.test(path)) return "matching";
  return "recruiter";
}
