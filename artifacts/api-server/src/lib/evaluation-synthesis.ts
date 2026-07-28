/**
 * lib/evaluation-synthesis.ts — Client-facing evaluation synthesiser
 *
 * Assembles every available signal for ONE candidate × ONE role (candidate row,
 * job, latest ICP, candidate_job_intelligence, latest interview session + AI
 * summary) and produces a structured, evidence-grounded `EvaluationContent`
 * object that drives both the in-app report and the client PDF.
 *
 * Guardrails (non-negotiable):
 *   • FAIRNESS_DIRECTIVE is appended to the system prompt of the model call.
 *   • redactPii() strips names/contact/protected details from the transcript and
 *     any free text BEFORE it reaches the model (blind screening).
 *   • The 5-band recommendation and the confidence score are computed
 *     DETERMINISTICALLY in code from scores + red flags — the model only writes
 *     the narrative rationale, never the verdict.
 *   • Evidence-grounded: a competency with no supporting evidence is returned as
 *     `insufficientEvidence` with a null score, never a fabricated number.
 *   • Verification is reported honestly (flagged ≠ pending ≠ verified) and raw
 *     internal risk internals are never exposed.
 */
import { db } from "@workspace/db";
import {
  candidatesTable,
  jobsTable,
  icpTable,
  candidateJobIntelligenceTable,
  interviewSessionsTable,
  interviewSummariesTable,
  applicationsTable,
} from "@workspace/db";
import { and, eq, desc, inArray, sql, type SQL } from "drizzle-orm";
import { generateJSON } from "./ai";
import { FAIRNESS_DIRECTIVE, redactPii } from "./fairness";
import { logger } from "./logger";
import { intelTenantScope, type TenantScope } from "./class-b-access";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import { resolveCompetencies, selectCompetencies, type Competency } from "./competency-library";

/* ── Public content shape (persisted as ai_content; same shape overlaid by
 *    human_edits; rendered by the web report AND the PDF) ─────────────────── */

export const RECOMMENDATION_BANDS = [
  "strongly_recommend",
  "recommend",
  "recommend_with_reservations",
  "further_assessment",
  "not_recommended",
] as const;
export type RecommendationBand = (typeof RECOMMENDATION_BANDS)[number];

export const RECOMMENDATION_BAND_LABEL: Record<RecommendationBand, string> = {
  strongly_recommend: "Strongly Recommend",
  recommend: "Recommend",
  recommend_with_reservations: "Recommend with Reservations",
  further_assessment: "Further Assessment Advised",
  not_recommended: "Not Recommended",
};

export interface EvalCompetency {
  key: string;
  label: string;
  /** 0–100, or null when there is not enough evidence to score. */
  score: number | null;
  insufficientEvidence: boolean;
  /** Short, specific, cited observation grounding the score. */
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
  /** "verified" | "flagged" | "pending" | "not_available" — honest states only. */
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
  /** Evidence provenance shown to the recruiter (not scores). */
  evidenceBasis: {
    hasInterview: boolean;
    interviewAnswers: number;
    hasIntelligence: boolean;
    hasResume: boolean;
  };
}

/* ── Gathered inputs ───────────────────────────────────────────────────────── */

interface EvaluationInputs {
  candidate: typeof candidatesTable.$inferSelect;
  job: typeof jobsTable.$inferSelect;
  icp: typeof icpTable.$inferSelect | null;
  intelligence: typeof candidateJobIntelligenceTable.$inferSelect | null;
  interview: {
    session: typeof interviewSessionsTable.$inferSelect;
    summary: typeof interviewSummariesTable.$inferSelect | null;
  } | null;
}

/**
 * Load every signal for the pair. Caller MUST have already authorised access to
 * both the job and the candidate (this function does no tenant gating — it is
 * called only from the authorised route handler).
 */
export async function gatherEvaluationInputs(
  jobId: string,
  candidateId: string,
  scope: TenantScope,
): Promise<EvaluationInputs | null> {
  const [candidate] = await db
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId))
    .limit(1);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!candidate || !job) return null;

  const [icp] = await db
    .select()
    .from(icpTable)
    .where(eq(icpTable.jobId, jobId))
    .orderBy(desc(icpTable.version))
    .limit(1);

  // candidate_job_intelligence is HIGH_RISK Class-B (no RLS) — scope through the
  // canonical accessor helper, never a bare .tenantId predicate.
  const [intelligence] = await db
    .select()
    .from(candidateJobIntelligenceTable)
    .where(
      and(
        intelTenantScope(scope),
        eq(candidateJobIntelligenceTable.jobId, jobId),
        eq(candidateJobIntelligenceTable.candidateId, candidateId),
      ),
    )
    .limit(1);

  /* Most-recent interview session for this candidate on this job (sessions are
   * keyed to an application; match on candidate + the job via the application).
   * The session is the DRIVING table and carries an explicit tenant predicate;
   * interview_summaries is joined in for attributes only. */
  const sessionScope: SQL =
    scope === null
      ? sql`true`
      : scope.length
        ? inArray(interviewSessionsTable.tenantId, scope)
        : sql`false`;
  classBRead(CLASS_B_READ_EXEMPTION.TENANT_SCOPED_VIA_JOIN);
  const sessionRows = await db
    .select({
      session: interviewSessionsTable,
      appJobId: applicationsTable.jobId,
      summary: interviewSummariesTable,
    })
    .from(interviewSessionsTable)
    .leftJoin(applicationsTable, eq(applicationsTable.id, interviewSessionsTable.applicationId))
    .leftJoin(
      interviewSummariesTable,
      eq(interviewSummariesTable.interviewSessionId, interviewSessionsTable.id),
    )
    .where(and(sessionScope, eq(interviewSessionsTable.candidateId, candidateId)))
    .orderBy(desc(interviewSessionsTable.createdAt));

  let interview: EvaluationInputs["interview"] = null;
  const match = sessionRows.find((r) => r.appJobId === jobId) ?? sessionRows[0];
  if (match) {
    interview = { session: match.session, summary: match.summary ?? null };
  }

  return { candidate, job, icp: icp ?? null, intelligence: intelligence ?? null, interview };
}

/** The default, role-adaptive competency set for a pair's ICP/job. */
export function defaultCompetencyKeysFor(inputs: EvaluationInputs): string[] {
  return selectCompetencies(
    inputs.icp?.roleFamily,
    inputs.icp?.seniority,
    inputs.icp?.domain,
    inputs.job.title,
  );
}

/* ── Deterministic verdict + confidence (NOT the LLM) ──────────────────────── */

function primaryScore(inputs: EvaluationInputs): number | null {
  const overall = inputs.interview?.summary?.overallScore;
  if (typeof overall === "number") return overall;
  const fit = inputs.intelligence?.fitScore;
  if (typeof fit === "number") return fit;
  const hp = inputs.intelligence?.hireProbability;
  if (typeof hp === "number") return Math.round(hp * 100);
  return null;
}

function redFlagCount(inputs: EvaluationInputs): number {
  return (inputs.interview?.summary?.redFlags ?? []).length;
}

/** 5-band recommendation, computed in code and capped by red flags. */
export function computeRecommendationBand(inputs: EvaluationInputs): RecommendationBand {
  const score = primaryScore(inputs);
  const flags = redFlagCount(inputs);

  let band: RecommendationBand;
  if (score === null) band = "further_assessment";
  else if (score >= 85) band = "strongly_recommend";
  else if (score >= 70) band = "recommend";
  else if (score >= 55) band = "recommend_with_reservations";
  else if (score >= 40) band = "further_assessment";
  else band = "not_recommended";

  // Red flags cap the ceiling — never let a strong score bury a serious concern.
  const order = RECOMMENDATION_BANDS;
  const idx = order.indexOf(band);
  if (flags >= 2) return order[Math.max(idx, order.indexOf("further_assessment"))];
  if (flags === 1) return order[Math.max(idx, order.indexOf("recommend_with_reservations"))];
  return band;
}

/** 0–100 evidence-backed confidence from coverage + interview depth + verification. */
export function computeConfidence(
  inputs: EvaluationInputs,
  competencies: EvalCompetency[],
): number {
  let conf = 0;
  const total = competencies.length || 1;
  const scored = competencies.filter((c) => !c.insufficientEvidence && c.score !== null).length;
  conf += (scored / total) * 50;

  if (inputs.interview?.summary) conf += 25;
  const answers = Array.isArray(inputs.interview?.session.answers)
    ? (inputs.interview!.session.answers as unknown[]).length
    : 0;
  if (answers >= 5) conf += 10;
  else if (answers >= 2) conf += 5;

  const v = verificationState(inputs);
  if (v.status === "verified") conf += 15;
  else if (v.status === "flagged") conf += 5;

  return Math.max(0, Math.min(100, Math.round(conf)));
}

/** Honest verification state — flagged ≠ pending ≠ verified. No raw internals.
 *  Prefers the CANONICAL candidates.verification_status enum (what the badge
 *  and kanban show) over re-parsing the raw agent verdict, so a re-run or
 *  recruiter-visible "verified" always carries through to the evaluation. */
export function verificationStateFor(candidate: {
  verificationStatus?: string | null;
  verificationResult?: unknown;
}): EvalVerification {
  const canonical = String(candidate.verificationStatus ?? "").toLowerCase();
  if (canonical === "verified") {
    return { status: "verified", summary: "Key details were checked and returned no concerns." };
  }
  if (canonical === "flagged") {
    return {
      status: "flagged",
      summary: "Verification returned items that warrant a closer look before proceeding.",
    };
  }
  if (canonical === "pending" || canonical === "in_progress") {
    return { status: "pending", summary: "Verification is in progress or has not yet completed." };
  }
  const vr = candidate.verificationResult as
    | { status?: string; verdict?: string; flagged?: boolean; summary?: string }
    | null
    | undefined;
  if (!vr)
    return {
      status: "not_available",
      summary: "Identity/experience verification has not been run.",
    };

  const raw = String(vr.status ?? vr.verdict ?? "").toLowerCase();
  if (
    vr.flagged === true ||
    raw.includes("flag") ||
    raw.includes("fail") ||
    raw.includes("mismatch")
  ) {
    return {
      status: "flagged",
      summary: "Verification returned items that warrant a closer look before proceeding.",
    };
  }
  if (raw.includes("verif") || raw.includes("pass") || raw.includes("clear")) {
    return { status: "verified", summary: "Key details were checked and returned no concerns." };
  }
  return { status: "pending", summary: "Verification is in progress or has not yet completed." };
}

export function verificationState(inputs: EvaluationInputs): EvalVerification {
  return verificationStateFor(inputs.candidate as any);
}

/* ── Synthesis ─────────────────────────────────────────────────────────────── */

function transcriptExcerpt(inputs: EvaluationInputs, names: string[]): string {
  const t = inputs.interview?.summary?.transcript ?? inputs.interview?.session.answers ?? [];
  if (!Array.isArray(t) || t.length === 0) return "";
  const lines: string[] = [];
  for (const turn of t as any[]) {
    const role =
      turn?.role ??
      turn?.speaker ??
      (turn?.question ? "interviewer" : turn?.answer ? "candidate" : "");
    const text = turn?.content ?? turn?.text ?? turn?.answer ?? turn?.question ?? "";
    if (text) lines.push(`${role ? `[${role}] ` : ""}${text}`);
  }
  const joined = lines.join("\n");
  return redactPii(joined, names).slice(0, 8000);
}

/** One evidence line listing the interview grader's per-question scores. */
function perQuestionScoreLine(inputs: EvaluationInputs): string {
  const answers = Array.isArray(inputs.interview?.session.answers)
    ? (inputs.interview!.session.answers as any[])
    : [];
  const scores = answers
    .map((a) => (typeof a?.score === "number" ? Math.round(a.score) : null))
    .filter((s): s is number => s !== null);
  if (scores.length === 0) return "";
  return `Per-question scores (same 0-100 grader as the overall score): ${scores.join(", ")}`;
}

interface SynthesisResult {
  content: EvaluationContent;
  model: string;
}

/**
 * Produce a full EvaluationContent for the pair using the given competency set.
 * The recommendation band + confidence are stamped deterministically; the model
 * only writes the narrative and per-competency evidence/rationale.
 */
export async function synthesizeEvaluation(
  inputs: EvaluationInputs,
  competencyKeys: string[],
  language = "en-US",
): Promise<SynthesisResult> {
  const comps: Competency[] = resolveCompetencies(competencyKeys);
  const names = [inputs.candidate.firstName, inputs.candidate.lastName].filter(Boolean) as string[];

  const summary = inputs.interview?.summary;
  const intel = inputs.intelligence;

  const evidenceBlock = [
    `ROLE: ${inputs.job.title}${inputs.job.department ? ` (${inputs.job.department})` : ""}`,
    inputs.icp?.roleFamily ? `Role family: ${inputs.icp.roleFamily}` : "",
    inputs.icp?.seniority ? `Seniority: ${inputs.icp.seniority}` : "",
    inputs.icp?.domain ? `Domain: ${inputs.icp.domain}` : "",
    inputs.icp?.requiredSkills?.length
      ? `Required skills: ${inputs.icp.requiredSkills.join(", ")}`
      : "",
    inputs.icp?.mustHaves?.length ? `Must-haves: ${inputs.icp.mustHaves.join(", ")}` : "",
    "",
    `CANDIDATE SIGNAL (identity redacted):`,
    inputs.candidate.currentTitle ? `Current title: ${inputs.candidate.currentTitle}` : "",
    inputs.candidate.skills?.length
      ? `Skills: ${redactPii(inputs.candidate.skills.join(", "), names)}`
      : "",
    "",
    summary ? `INTERVIEW ASSESSMENT (AI):` : `NO INTERVIEW ON FILE for this role.`,
    summary ? `Overall interview score: ${summary.overallScore}/100` : "",
    summary ? perQuestionScoreLine(inputs) : "",
    summary?.strengths?.length
      ? `Assessed strengths: ${redactPii(summary.strengths.join("; "), names)}`
      : "",
    summary?.weaknesses?.length
      ? `Assessed weaknesses: ${redactPii(summary.weaknesses.join("; "), names)}`
      : "",
    summary?.redFlags?.length ? `Red flags: ${redactPii(summary.redFlags.join("; "), names)}` : "",
    summary?.recruiterSummary
      ? `Interviewer summary: ${redactPii(summary.recruiterSummary, names)}`
      : "",
    "",
    intel ? `INTELLIGENCE SIGNAL:` : "",
    intel?.fitScore != null ? `Role-fit score: ${intel.fitScore}/100` : "",
    Array.isArray(intel?.topStrengths) && (intel!.topStrengths as string[]).length
      ? `Top strengths: ${redactPii((intel!.topStrengths as string[]).join("; "), names)}`
      : "",
    Array.isArray(intel?.topRisks) && (intel!.topRisks as string[]).length
      ? `Top risks: ${redactPii((intel!.topRisks as string[]).join("; "), names)}`
      : "",
    "",
    `INTERVIEW TRANSCRIPT EXCERPT (identity redacted):`,
    transcriptExcerpt(inputs, names) || "(none available)",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const competencyList = comps
    .map(
      (c) =>
        `- ${c.key} — ${c.label}: ${c.definition}\n    Strong: ${c.anchors.strong}\n    Developing: ${c.anchors.developing}`,
    )
    .join("\n");

  const systemPrompt = [
    "You are an expert talent assessor writing a CLIENT-FACING candidate evaluation for a hiring company.",
    "Tone: professional, balanced, specific, and respectful — this is read by the client's hiring team.",
    "You MUST ground every claim in the provided evidence. When evidence for a competency is missing or too thin to judge, mark it insufficient — DO NOT invent a score or fabricate observations.",
    "Never reference the candidate by name, contact details, or any protected characteristic. Never expose internal risk scores, model internals, or proctoring internals.",
    FAIRNESS_DIRECTIVE,
    "Respond with valid JSON only — no markdown fences, no commentary.",
  ].join("\n\n");

  const prompt = `Evaluate this candidate for the specified role using ONLY the evidence below.

${evidenceBlock}

COMPETENCIES TO ASSESS (assess each; if evidence is insufficient, set insufficientEvidence true and score null):
${competencyList}

Return JSON with EXACTLY this shape:
{
  "headline": "one-line client-facing summary of the candidate for this role",
  "executiveSummary": "3-5 sentence balanced overview for the hiring team",
  "roleAlignment": "2-4 sentences on how the candidate's profile maps to THIS role's requirements",
  "competencies": [
    { "key": "<one of the keys above>", "score": <0-100 or null>, "insufficientEvidence": <bool>, "evidence": "specific grounded observation", "rationale": "why this score" }
  ],
  "behavioralInsights": [ { "dimension": "e.g. Communication style", "descriptor": "qualitative, non-scored observation" } ],
  "observations": [ { "observed": "notable moment/pattern", "whyItMatters": "relevance to the role", "followUps": ["suggested follow-up question for the client's own interview"] } ],
  "developmentOpportunities": [ { "area": "growth area", "impact": "high|medium|low", "coaching": "how it could be supported" } ],
  "riskAssessment": { "concerns": ["evidence-based concern"], "toValidate": ["thing the client should verify themselves"] },
  "recommendation": { "rationale": "2-4 sentence justification (do NOT state a verdict label; only the reasoning)" }
}

Rules:
- Include one competencies entry for EVERY key listed above, in the same order.
- CALIBRATION: competency scores use the SAME 0-100 scale and severity as the interview grader whose overall and per-question scores appear above. Anchor to them — if the interview scored 67 overall with some answers under 50, competency scores clustering in the 80s are miscalibrated. Weak or thin answers must pull the related competency scores DOWN, and your competency scores should average close to the overall interview score. Reserve 80+ for competencies backed by verifiable specifics, exactly as the interview grader does.
- behavioralInsights: 3-5 qualitative, non-scored items.
- observations: 2-4 items. developmentOpportunities: 1-3 items.
- Keep everything concise and free of fabrication. Empty arrays are fine when there is nothing evidence-based to say.`;

  let parsed: any = {};
  const model = "gpt-4o";
  try {
    parsed = await generateJSON<any>(prompt, systemPrompt, language);
  } catch (err: any) {
    logger.warn(
      { err: err?.message, jobId: inputs.job.id, candidateId: inputs.candidate.id },
      "evaluation synthesis LLM failed — returning insufficient-evidence scaffold",
    );
    parsed = {};
  }

  // Normalise competencies to the requested set, in order, honestly.
  const byKey = new Map<string, any>();
  for (const c of Array.isArray(parsed.competencies) ? parsed.competencies : []) {
    if (c && typeof c.key === "string") byKey.set(c.key, c);
  }
  const competencies: EvalCompetency[] = comps.map((c) => {
    const raw = byKey.get(c.key);
    const rawScore = raw?.score;
    const insufficient =
      raw?.insufficientEvidence === true || rawScore == null || typeof rawScore !== "number";
    return {
      key: c.key,
      label: c.label,
      score: insufficient ? null : Math.max(0, Math.min(100, Math.round(rawScore))),
      insufficientEvidence: insufficient,
      evidence: typeof raw?.evidence === "string" ? raw.evidence : "",
      rationale: typeof raw?.rationale === "string" ? raw.rationale : "",
    };
  });

  /* Deterministic calibration clamp — the model cannot out-score the interview
     grader. When an interview overall score exists, the scored competencies'
     mean may not exceed it by more than 5 points; if it does, scale every
     scored competency down proportionally (never up — a harsh model stands). */
  const overallForClamp = inputs.interview?.summary?.overallScore;
  if (typeof overallForClamp === "number") {
    const scoredComps = competencies.filter((c) => c.score !== null);
    if (scoredComps.length > 0) {
      const mean = scoredComps.reduce((s, c) => s + (c.score as number), 0) / scoredComps.length;
      const ceiling = Math.min(100, overallForClamp + 5);
      if (mean > ceiling && mean > 0) {
        const factor = ceiling / mean;
        for (const c of competencies) {
          if (c.score !== null) c.score = Math.max(0, Math.min(100, Math.round(c.score * factor)));
        }
      }
    }
  }

  const band = computeRecommendationBand(inputs);
  const verification = verificationState(inputs);
  const answers = Array.isArray(inputs.interview?.session.answers)
    ? (inputs.interview!.session.answers as unknown[]).length
    : 0;

  const content: EvaluationContent = {
    headline: str(parsed.headline) || `Evaluation for ${inputs.job.title}`,
    executiveSummary: str(parsed.executiveSummary),
    roleAlignment: str(parsed.roleAlignment),
    competencies,
    behavioralInsights: cleanBehavioral(parsed.behavioralInsights),
    observations: cleanObservations(parsed.observations),
    developmentOpportunities: cleanDevelopment(parsed.developmentOpportunities),
    riskAssessment: {
      concerns: strArray(parsed?.riskAssessment?.concerns),
      toValidate: strArray(parsed?.riskAssessment?.toValidate),
    },
    verification,
    recommendation: {
      band,
      rationale: str(parsed?.recommendation?.rationale),
    },
    evidenceBasis: {
      hasInterview: !!inputs.interview,
      interviewAnswers: answers,
      hasIntelligence: !!inputs.intelligence,
      hasResume: !!inputs.candidate.resumeUrl,
    },
  };

  return { content, model };
}

/* ── Human overlay merge ───────────────────────────────────────────────────── */

/** Sparse recruiter overrides, merged OVER ai_content at read time. */
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
  /** Per-competency overrides keyed by competency key. */
  competencyOverrides?: Record<
    string,
    Partial<Pick<EvalCompetency, "score" | "insufficientEvidence" | "evidence" | "rationale">>
  >;
  /** Recruiter's own free-text note, appended to the report. */
  recruiterComments?: string;
}

/**
 * Produce the FINAL client-facing content from the persisted draft + overlay +
 * the (possibly recruiter-overridden) competency set. Competency keys are the
 * source of truth for WHICH competencies show; a key with no AI content and no
 * override renders as an honest insufficient-evidence placeholder.
 */
export function mergeEvaluation(
  aiContent: EvaluationContent,
  humanEdits: EvaluationHumanEdits | null | undefined,
  competencyKeys: string[],
): EvaluationContent & { recruiterComments: string } {
  const he = humanEdits ?? {};
  const aiByKey = new Map<string, EvalCompetency>();
  for (const c of aiContent.competencies ?? []) aiByKey.set(c.key, c);

  const libByKey = new Map(resolveCompetencies(competencyKeys).map((c) => [c.key, c]));
  const competencies: EvalCompetency[] = competencyKeys.map((key) => {
    const base: EvalCompetency = aiByKey.get(key) ?? {
      key,
      label: libByKey.get(key)?.label ?? key,
      score: null,
      insufficientEvidence: true,
      evidence: "",
      rationale: "",
    };
    const ov = he.competencyOverrides?.[key];
    if (!ov) return base;
    const score = ov.score !== undefined ? ov.score : base.score;
    return {
      ...base,
      score,
      insufficientEvidence:
        ov.insufficientEvidence !== undefined
          ? ov.insufficientEvidence
          : score == null
            ? true
            : false,
      evidence: ov.evidence !== undefined ? ov.evidence : base.evidence,
      rationale: ov.rationale !== undefined ? ov.rationale : base.rationale,
    };
  });

  return {
    headline: he.headline ?? aiContent.headline,
    executiveSummary: he.executiveSummary ?? aiContent.executiveSummary,
    roleAlignment: he.roleAlignment ?? aiContent.roleAlignment,
    competencies,
    behavioralInsights: he.behavioralInsights ?? aiContent.behavioralInsights,
    observations: he.observations ?? aiContent.observations,
    developmentOpportunities: he.developmentOpportunities ?? aiContent.developmentOpportunities,
    riskAssessment: {
      concerns: he.riskAssessment?.concerns ?? aiContent.riskAssessment.concerns,
      toValidate: he.riskAssessment?.toValidate ?? aiContent.riskAssessment.toValidate,
    },
    verification: {
      status: aiContent.verification.status, // status stays honest/derived — recruiter may only annotate
      summary: he.verification?.summary ?? aiContent.verification.summary,
    },
    recommendation: {
      band: he.recommendation?.band ?? aiContent.recommendation.band,
      rationale: he.recommendation?.rationale ?? aiContent.recommendation.rationale,
    },
    evidenceBasis: aiContent.evidenceBasis,
    recruiterComments: he.recruiterComments ?? "",
  };
}

/* ── small normalisers ─────────────────────────────────────────────────────── */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim())
    : [];
}
function cleanBehavioral(v: unknown): EvalBehavioral[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({ dimension: str(x.dimension), descriptor: str(x.descriptor) }))
    .filter((x) => x.dimension || x.descriptor)
    .slice(0, 6);
}
function cleanObservations(v: unknown): EvalObservation[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({
      observed: str(x.observed),
      whyItMatters: str(x.whyItMatters),
      followUps: strArray(x.followUps),
    }))
    .filter((x) => x.observed || x.whyItMatters)
    .slice(0, 5);
}
function cleanDevelopment(v: unknown): EvalDevelopment[] {
  if (!Array.isArray(v)) return [];
  const okImpact = new Set(["high", "medium", "low"]);
  return v
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({
      area: str(x.area),
      impact: okImpact.has(String(x.impact)) ? (x.impact as EvalDevelopment["impact"]) : "medium",
      coaching: str(x.coaching),
    }))
    .filter((x) => x.area)
    .slice(0, 4);
}
