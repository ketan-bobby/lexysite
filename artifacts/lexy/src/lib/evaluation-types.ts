/**
 * evaluation-types.ts — Frontend mirror of the backend evaluation shapes
 * (artifacts/api-server/src/lib/evaluation-synthesis.ts). Kept in lockstep by
 * hand; the /evaluations/library endpoint is the runtime source of truth for the
 * competency list + band labels.
 */

export const RECOMMENDATION_BANDS = [
  "strongly_recommend",
  "recommend",
  "recommend_with_reservations",
  "further_assessment",
  "not_recommended",
] as const;
export type RecommendationBand = (typeof RECOMMENDATION_BANDS)[number];

export interface EvalCompetency {
  key: string;
  label: string;
  score: number | null;
  insufficientEvidence: boolean;
  evidence: string;
  rationale: string;
}

export interface EvalBehavioral {
  dimension: string;
  descriptor: string;
}

export interface EvalObservation {
  observed: string;
  whyItMatters: string;
  followUps: string[];
}

export interface EvalDevelopment {
  area: string;
  impact: "high" | "medium" | "low";
  coaching: string;
}

export interface EvalVerification {
  status: "verified" | "flagged" | "pending" | "not_available";
  summary: string;
}

export interface EvaluationContent {
  headline: string;
  executiveSummary: string;
  roleAlignment: string;
  competencies: EvalCompetency[];
  behavioralInsights: EvalBehavioral[];
  observations: EvalObservation[];
  developmentOpportunities: EvalDevelopment[];
  riskAssessment: { concerns: string[]; toValidate: string[] };
  verification: EvalVerification;
  recommendation: { band: RecommendationBand; rationale: string };
  evidenceBasis: {
    hasInterview: boolean;
    interviewAnswers: number;
    hasIntelligence: boolean;
    hasResume: boolean;
  };
}

/** Sparse recruiter overrides merged over ai_content at read time. */
export interface EvaluationHumanEdits {
  headline?: string;
  executiveSummary?: string;
  roleAlignment?: string;
  behavioralInsights?: EvalBehavioral[];
  observations?: EvalObservation[];
  developmentOpportunities?: EvalDevelopment[];
  riskAssessment?: { concerns?: string[]; toValidate?: string[] };
  recommendation?: { band?: RecommendationBand; rationale?: string };
  verification?: { summary?: string };
  competencyOverrides?: Record<
    string,
    Partial<Pick<EvalCompetency, "score" | "insufficientEvidence" | "evidence" | "rationale">>
  >;
  recruiterComments?: string;
}

/** The merged, client-facing content the API returns under `content`. */
export type MergedEvaluationContent = EvaluationContent & { recruiterComments: string };

export interface Evaluation {
  id: string;
  jobId: string;
  candidateId: string;
  competencyKeys: string[];
  recommendationBand: RecommendationBand;
  confidence: number | null;
  approvalState: "draft" | "approved";
  model: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  content: MergedEvaluationContent;
  aiContent: EvaluationContent;
  humanEdits: EvaluationHumanEdits | null;
}

export interface EvaluationGetResponse {
  evaluation: Evaluation | null;
  defaultCompetencyKeys?: string[];
}

/** Client-facing recommendation display: the AI's internal verdict band is
 *  never shown as the headline recommendation. Until a recruiter approves the
 *  report it reads "Ready for Recruiter Review"; after approval it reads
 *  "Approved with Recruiter Recommendation". */
export function recommendationWorkflowLabel(approvalState: "draft" | "approved"): string {
  return approvalState === "approved"
    ? "Approved with Recruiter Recommendation"
    : "Ready for Recruiter Review";
}

export interface CompetencyLibEntry {
  key: string;
  label: string;
  description?: string;
  roleFamilies?: string[];
}

export interface EvaluationLibrary {
  competencies: CompetencyLibEntry[];
  bands: { value: RecommendationBand; label: string }[];
}
