/**
 * Canonical firewall for data that can leave the candidate-development space.
 *
 * Career intake, baseline conversations, preparation sessions, mock interviews,
 * and growth coaching are candidate-owned developmental records. They are not
 * employer evidence.  Do not "redact" arbitrary objects here: callers must use
 * the explicit allowlists below so an added private field fails closed.
 */

export type JobBoundAssessmentProvenance = {
  kind: "job_bound_assessment_v1";
  jobId: string;
  candidateId: string;
  sessionId: string;
};

const finiteScore = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;

const strings = (value: unknown, max = 6): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, max)
    : [];

const text = (value: unknown, max = 240): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

/**
 * Job-bound evidence has to identify the candidate, requisition, and the actual
 * assessment session. Historical summary blobs have none of this and are
 * intentionally not accepted as evidence.
 */
export function isJobBoundAssessment(
  value: unknown,
  jobId: string,
  candidateId: string,
): value is JobBoundAssessmentProvenance {
  const p = value as Partial<JobBoundAssessmentProvenance> | null;
  return !!p
    && p.kind === "job_bound_assessment_v1"
    && p.jobId === jobId
    && p.candidateId === candidateId
    && typeof p.sessionId === "string"
    && p.sessionId.length > 0;
}

/**
 * Keep only scoring inputs that can be employer evidence. In particular:
 *  - developmental prose/gaps/coaching is never preserved;
 *  - an interview signal is accepted only with exact job/candidate/session
 *    provenance (legacy snapshots without it fail closed);
 *  - resume-screen numeric facts remain valid inputs.
 */
export function sanitizeEmployerSignals(
  raw: unknown,
  context: { jobId: string; candidateId: string },
): Record<string, unknown> {
  const input = raw && typeof raw === "object" ? raw as Record<string, any> : {};
  const out: Record<string, any> = {};

  if (input.icp && typeof input.icp === "object") {
    const s: Record<string, unknown> = {};
    for (const key of ["requiredSkills", "preferredSkills", "disqualifiers", "mustHaves"] as const) {
      const value = strings(input.icp[key], 30);
      if (value.length) s[key] = value;
    }
    for (const key of ["seniority"] as const) {
      const value = text(input.icp[key]);
      if (value) s[key] = value;
    }
    for (const key of ["yearsExperienceMin", "yearsExperienceMax"] as const) {
      if (typeof input.icp[key] === "number" && Number.isFinite(input.icp[key])) s[key] = input.icp[key];
    }
    if (Object.keys(s).length) out.icp = s;
  }

  if (input.sourcing && typeof input.sourcing === "object") {
    const s: Record<string, unknown> = {};
    const sourceType = text(input.sourcing.sourceType, 100);
    if (sourceType) s.sourceType = sourceType;
    for (const key of ["sourceConfidence", "profileCompleteness", "passiveCandidateScore"] as const) {
      const value = finiteScore(input.sourcing[key]);
      if (value !== undefined) s[key] = value;
    }
    if (Object.keys(s).length) out.sourcing = s;
  }

  if (input.screening && typeof input.screening === "object") {
    const s: Record<string, unknown> = {};
    // Deliberately exclude recommendation, gapFlags, strengthAreas and gapAreas:
    // their free text is not safe provenance and can carry coaching/baseline notes.
    for (const key of ["resumeMatchScore", "skillMatchScore", "experienceScore", "score"] as const) {
      const value = finiteScore(input.screening[key]);
      if (value !== undefined) s[key] = value;
    }
    if (Object.keys(s).length) out.screening = s;
  }

  if (
    input.interview
    && typeof input.interview === "object"
    && isJobBoundAssessment(input.interview.provenance, context.jobId, context.candidateId)
  ) {
    const s: Record<string, unknown> = { provenance: input.interview.provenance };
    for (const key of [
      "communicationScore", "technicalDepthScore", "behavioralScore",
      "answerQualityScore", "interviewScore", "overallScore",
    ] as const) {
      const value = finiteScore(input.interview[key]);
      if (value !== undefined) s[key] = value;
    }
    for (const key of ["strengths", "weaknesses", "redFlags"] as const) {
      const value = strings(input.interview[key]);
      if (value.length) s[key] = value;
    }
    const recommendation = text(input.interview.recommendation, 80);
    if (recommendation) s.recommendation = recommendation;
    out.interview = s;
  }

  if (input.proctoring && typeof input.proctoring === "object") {
    const s: Record<string, unknown> = {};
    for (const key of ["fraudRiskScore", "integrityScore", "riskScore"] as const) {
      const value = finiteScore(input.proctoring[key]);
      if (value !== undefined) s[key] = value;
    }
    for (const key of ["gazeAnomalyFlag", "multipleFacesFlag"] as const) {
      if (typeof input.proctoring[key] === "boolean") s[key] = input.proctoring[key];
    }
    if (Object.keys(s).length) out.proctoring = s;
  }

  for (const group of ["outreach", "antiGhosting", "scheduling", "verification", "analytics"] as const) {
    if (!input[group] || typeof input[group] !== "object") continue;
    const keys: Record<typeof group, readonly string[]> = {
      outreach: ["openRate", "replyRate", "positiveReplyScore"],
      antiGhosting: ["ghostingRiskScore", "engagementDecayScore", "reengagementSuccessRate"],
      scheduling: ["schedulingFrictionScore", "rescheduleCount", "noShowRisk"],
      verification: ["identityConfidence", "linkedinMatchScore", "resumeConsistencyScore", "emailValidity", "verdict"],
      analytics: ["stageConversionBenchmark", "sourceQualityBenchmark", "similarHirePatternScore", "similarHireSource", "similarHireExemplarCount"],
    };
    const s: Record<string, unknown> = {};
    for (const key of keys[group]) {
      const value = input[group][key];
      if (typeof value === "boolean") s[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) s[key] = finiteScore(value);
      else if (
        typeof value === "string"
        && ((group === "verification" && key === "verdict") || (group === "analytics" && key === "similarHireSource"))
      ) s[key] = value.slice(0, 40);
    }
    if (Object.keys(s).length) out[group] = s;
  }

  return out;
}

/**
 * The HM package and its PDF attachment are external presentation surfaces.
 * The caller's package is untrusted, so only resume-derived/factual fields are
 * retained. Assessment summaries, interview arrays, gaps, recommendations and
 * arbitrary prose are intentionally absent. A binary PDF cannot be safely
 * inspected; routes must decline client-supplied PDFs and generate one from a
 * trusted server-side report in a future integration.
 */
export function sanitizeEmployerPackageSnapshot(
  raw: unknown,
  options: { includeContact: boolean },
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, any>;
  const candidate = input.candidate && typeof input.candidate === "object" ? input.candidate : {};
  const safeCandidate: Record<string, unknown> = {};
  for (const key of ["firstName", "lastName", "currentTitle", "currentCompany", "location", "verificationStatus"] as const) {
    const value = text(candidate[key]);
    if (value) safeCandidate[key] = value;
  }
  const skills = strings(candidate.skills, 60);
  if (skills.length) safeCandidate.skills = skills;
  if (options.includeContact) {
    for (const key of ["email", "phone"] as const) {
      const value = text(candidate[key]);
      if (value) safeCandidate[key] = value;
    }
  }

  const out: Record<string, unknown> = { candidate: safeCandidate };
  const resumeScreen = input.resumeScreen && typeof input.resumeScreen === "object" ? input.resumeScreen : null;
  const extractedSkills = strings(resumeScreen?.extractedSkills, 60);
  if (extractedSkills.length) out.resumeScreen = { extractedSkills };
  const preparedBy = text(input.preparedBy, 160);
  if (preparedBy) out.preparedBy = preparedBy;
  return out;
}