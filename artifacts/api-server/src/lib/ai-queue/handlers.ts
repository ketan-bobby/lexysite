/**
 * lib/ai-queue/handlers.ts — AI job processors
 *
 * One handler per `ai_job_type`. The worker (lib/ai-queue/worker.ts) looks up
 * the handler by `job.type` and runs it. Each handler is:
 *   • idempotent  — a retried/duplicate job must not double-write
 *                   (e.g. summarize_interview returns early if a summary row
 *                   already exists for the session).
 *   • self-contained — it reloads everything it needs from the session id in
 *                   the payload, so a job row stays small and never carries
 *                   stale snapshots.
 *
 * This is the exact AI work that used to run inline inside
 * `POST /interviews/:id/end`. Moving it here keeps the live interview path
 * (transcribe → converse) responsive under concurrency.
 *
 * Ordering: `/end` enqueues only `summarize_interview`. That handler, after it
 * persists the summary, chains `generate_candidate_insights` and
 * `match_candidate_to_job` — both of which depend on the freshly-written scores
 * — so they can never run before the summary exists.
 */
import {
  dbAdmin,
  interviewSessionsTable,
  interviewPlansTable,
  interviewSummariesTable,
  aiDecisionLogTable,
  type AiJob,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import nodeCrypto from "crypto";
import { generateJSON, resolveLangMeta } from "../ai";
import { FAIRNESS_DIRECTIVE } from "../fairness";
import { upsertIntelligenceFromInterviewSession } from "../intelligence";
import { rescoreCandidateForJob } from "../enrich-candidate";
import { logCandidateEvent } from "../candidate-event-logger.js";
import { logger } from "../logger";
import { enqueueAiJob } from "./queue";
import { enqueueInterviewFollowups } from "./interview-followups";
import { resolveInterviewSummary } from "../interview-summary-result.js";
import { isValidInterviewScore, parseInterviewGrade } from "../interview-turn-policy.js";

type Handler = (job: AiJob) => Promise<unknown>;

/* ── Shared: grade a single interview answer ─────────────────────────────────
 * Returns a 0-100 score (and optional feedback) or null when grading fails —
 * callers must NEVER fabricate a score for an unscored answer. */
async function gradeAnswer(args: {
  questionText: string;
  answer: string;
  language: string;
  focusLine: string;
}): Promise<{ score: number; feedback?: string } | null> {
  const ans = typeof args.answer === "string" ? args.answer.trim() : "";
  if (!ans) return null; // absent capture is not a demonstrated non-answer
  const langLabel = resolveLangMeta(args.language).label;
  try {
    const r = await generateJSON<{ score: number; feedback: string }>(
      `Rate this interview answer from 0 to 100 on relevance, depth, specificity and clarity of CONTENT. A non-answer, refusal, joke, or off-topic remark (e.g. "I'm just testing", "I don't know", "no comment") MUST score very low (under 20). Reserve 80+ ONLY for answers containing verifiable specifics: concrete numbers, named tools or decisions, and measurable or verifiable outcomes. A well-structured answer (e.g. STAR-formatted) whose claims are generic and unverifiable is average at best (50-70) — structure is not substance. Judge substance, not format: a narrative or conversational answer rich in verifiable specifics deserves the same score as a formally structured one. Do NOT penalize accent, grammar, fluency, or interview-answer style and format (e.g. absence of STAR structure or corporate interview coaching) unless it genuinely prevents understanding.${args.focusLine}\n\nQuestion: ${args.questionText}\nAnswer: ${ans}\nReturn JSON: { "score": number, "feedback": string (1 honest sentence in ${langLabel}) }`,
      `You are a rigorous interviewer grading a single answer. Be honest and calibrated — never inflate a weak or non-serious answer. Respond with valid JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
      args.language,
    );
    return parseInterviewGrade(r);
  } catch {
    return null;
  }
}

/* ── summarize_interview ─────────────────────────────────────────────────────
 * Grades any unscored answers, produces the recruiter-facing summary, writes
 * the interview_summaries row + AEDT audit log, then chains the downstream
 * intelligence + match jobs. Idempotent on the summary row. */
const summarizeInterview: Handler = async (job) => {
  const sessionId = String((job.payload as any)?.sessionId ?? "");
  if (!sessionId) throw new Error("summarize_interview: missing sessionId");

  const [session] = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sessionId))
    .limit(1);
  if (!session) throw new Error(`summarize_interview: session ${sessionId} not found`);

  /* Idempotent: a session is summarized once. */
  const [existing] = await dbAdmin
    .select()
    .from(interviewSummariesTable)
    .where(eq(interviewSummariesTable.interviewSessionId, sessionId))
    .orderBy(desc(interviewSummariesTable.createdAt))
    .limit(1);
  if (existing) {
    /* Still ensure the downstream jobs are queued (e.g. a prior run crashed
       after the summary insert but before chaining). Dedupe keys make this safe. */
    await chainDownstream(session);
    return { skipped: "summary_exists", summaryId: existing.id };
  }

  const answers = (session.answers as any[]) || [];
  const [plan] = await dbAdmin
    .select()
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, session.planId))
    .limit(1);
  const questions = (plan?.questions as any[]) || [];
  const language = session.language ?? "en-US";
  const langLabel = resolveLangMeta(language).label;

  const endFocusDir = (plan?.focusDirective ?? "").toString().trim();
  const graderFocusLine = endFocusDir
    ? `\n\nThe recruiter asked this interview to focus on the job-relevant competency: "${endFocusDir}". Where this answer gives evidence of that competency, weigh it; never reward or penalize protected characteristics or personality labels.`
    : "";
  const summaryFocusLine = endFocusDir
    ? `\n\nRECRUITER FOCUS: this interview was specifically meant to assess the job-relevant competency "${endFocusDir}". In recruiterSummary, explicitly state how the candidate did on this competency, citing concrete evidence from the transcript. Keep it fair — never infer it from accent, demeanour, or any protected characteristic.`
    : "";

  /* Per-question scoring (parallel). A failed rating leaves the answer unscored. */
  const unscored = answers.filter((a: any) => a && !isValidInterviewScore(a.score));
  if (unscored.length > 0) {
    await Promise.all(
      unscored.map(async (a: any) => {
        const q = questions.find((qq: any) => qq.id === a.questionId);
        const qText = a.questionText || q?.text || "Interview question";
        const graded = await gradeAnswer({ questionText: qText, answer: a.answer ?? "", language, focusLine: graderFocusLine });
        if (graded) {
          a.score = graded.score;
          if (graded.feedback) a.feedback = graded.feedback;
        }
      }),
    );
    await dbAdmin
      .update(interviewSessionsTable)
      .set({ answers })
      .where(eq(interviewSessionsTable.id, sessionId));
  }

  const transcript = answers
    .map((a: any) => {
      const q = questions.find((q: any) => q.id === a.questionId);
      const qText = a.questionText || q?.text || "Interview question";
      return `Q: ${qText}\nA: ${a.answer}`;
    })
    .join("\n\n");

  if (!answers.some((a: any) => isValidInterviewScore(a?.score) &&
    typeof a.answer === "string" && a.answer.trim())) {
    throw new Error("Interview summary has no valid assessment score");
  }
  let generatedSummary: unknown;
  try {
    generatedSummary = await generateJSON<any>(
      `Analyze this interview transcript and produce a hiring recommendation.\n\nEvaluate ONLY the substance of the candidate's answers (relevance, depth, correctness, specific examples). Do NOT reward or penalize accent, dialect, grammar, fluency, verbosity, speaking style, or interview-answer format (e.g. presence or absence of STAR structure or other interview coaching conventions) except where it genuinely prevents job-relevant communication. Judge substance: reserve high scores for verifiable specifics (numbers, named decisions, verifiable outcomes) regardless of how the answer is formatted.${summaryFocusLine}\n\nTranscript:\n${transcript}\n\nReturn JSON:\n{\n  "overallScore": number (0-100),\n  "strengths": string[] (3-5 specific strengths),\n  "weaknesses": string[] (1-3 areas for improvement),\n  "redFlags": string[] (serious concerns, or empty),\n  "recommendation": "yes" | "maybe" | "no",\n  "recruiterSummary": string (3-4 sentences specific to this candidate)\n}\nAll text in ${langLabel}.`,
      `You are a senior recruiter writing a post-interview evaluation. Be specific to the candidate's actual responses. Respond with valid JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
      language,
    );

  } catch (err: any) {
    logger.warn({ sessionId, err: err?.message }, "[ai-queue] summary generation failed — assessment not saved");
    // The queue's existing retry/failure handling applies. Never save a made-up
    // successful assessment or enqueue downstream hiring signals on failure.
    throw err;
  }

  const { strengths, weaknesses, redFlags, overallScore, recruiterSummary, recommendation } =
    resolveInterviewSummary(generatedSummary, answers, transcript);

  const [dbSummary] = await dbAdmin
    .insert(interviewSummariesTable)
    .values({
      interviewSessionId: sessionId,
      overallScore,
      strengths,
      weaknesses,
      redFlags,
      recommendation,
      recruiterSummary,
      transcript: answers.map((a: any) => {
        const q = questions.find((q: any) => q.id === a.questionId);
        return { questionId: a.questionId, question: a.questionText || q?.text || "Question", answer: a.answer, score: a.score };
      }),
    })
    .returning();

  /* AEDT (NYC LL144) append-only audit record. Best-effort. */
  if (plan?.jobId && session.candidateId) {
    try {
      const inputHash = nodeCrypto.createHash("sha256").update(transcript).digest("hex");
      await dbAdmin.insert(aiDecisionLogTable).values({
        tenantId: session.tenantId ?? "demo",
        jobId: plan.jobId,
        candidateId: session.candidateId,
        decisionType: "interview_assessment",
        score: overallScore,
        label: recommendation,
        inputHash,
        modelId: "gpt-4o",
        snapshot: {
          prompt: "post-interview hiring evaluation",
          language,
          transcriptChars: transcript.length,
          focusDirective: endFocusDir || null,
          output: { overallScore, strengths, weaknesses, redFlags, recommendation },
        },
      });
    } catch (e: any) {
      logger.warn({ sessionId, err: e?.message }, "[ai-queue] ai_decision_log insert failed");
    }

    void logCandidateEvent({
      candidateId: session.candidateId,
      jobId: plan.jobId ?? null,
      tenantId: session.tenantId ?? "",
      applicationId:
        session.applicationId && !["direct", "pipeline"].includes(session.applicationId) ? session.applicationId : null,
      eventType: "INTERVIEW_SCORE_GENERATED",
      actorType: "system",
      source: "interview_agent",
      metadata: { sessionId, overallScore, recommendation },
    });
  }

  await chainDownstream(session);

  return { summaryId: dbSummary?.id, overallScore, recommendation };
};

/* Enqueue the intelligence + match jobs that depend on a written summary. */
async function chainDownstream(session: typeof interviewSessionsTable.$inferSelect): Promise<void> {
  const [plan] = await dbAdmin
    .select({ jobId: interviewPlansTable.jobId })
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, session.planId))
    .limit(1);
  const jobId = plan?.jobId ?? null;
  await enqueueInterviewFollowups(
    {
      sessionId: session.id,
      tenantId: session.tenantId,
      candidateId: session.candidateId,
      jobId,
    },
    enqueueAiJob,
  );
}

/* ── generate_candidate_insights ─────────────────────────────────────────────
 * Feeds the interview scores into the candidate-intelligence engine. Reloads
 * the session + persisted summary so it always uses fresh, graded data. */
const generateCandidateInsights: Handler = async (job) => {
  const sessionId = String((job.payload as any)?.sessionId ?? "");
  if (!sessionId) throw new Error("generate_candidate_insights: missing sessionId");

  const [session] = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sessionId))
    .limit(1);
  if (!session) throw new Error(`generate_candidate_insights: session ${sessionId} not found`);

  const [plan] = await dbAdmin
    .select({ jobId: interviewPlansTable.jobId })
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, session.planId))
    .limit(1);
  if (!plan?.jobId || !session.candidateId) return { skipped: "no_job_or_candidate" };

  const [summary] = await dbAdmin
    .select()
    .from(interviewSummariesTable)
    .where(eq(interviewSummariesTable.interviewSessionId, sessionId))
    .orderBy(desc(interviewSummariesTable.createdAt))
    .limit(1);
  if (!summary) throw new Error(`generate_candidate_insights: summary not ready for ${sessionId}`);

  const answers = (session.answers as any[]) || [];
  const result = await upsertIntelligenceFromInterviewSession(sessionId, {
    tenantId: session.tenantId ?? "demo",
    jobId: plan.jobId,
    candidateId: session.candidateId,
    answers: answers.map((a: any) => ({
      questionId: a.questionId,
      answer: a.answer,
      score: a.score ?? null,
      feedback: a.feedback,
    })),
    overallScore: summary.overallScore,
    strengths: summary.strengths ?? [],
    weaknesses: summary.weaknesses ?? [],
    redFlags: summary.redFlags ?? [],
    recommendation: summary.recommendation ?? "maybe",
  });
  return { ok: !!result };
};

/* ── match_candidate_to_job ──────────────────────────────────────────────────
 * Recomputes the candidate↔job match score now that interview signals exist. */
const matchCandidateToJob: Handler = async (job) => {
  const candidateId = String((job.payload as any)?.candidateId ?? "");
  const jobId = String((job.payload as any)?.jobId ?? "");
  if (!candidateId || !jobId) throw new Error("match_candidate_to_job: missing candidateId/jobId");
  const score = await rescoreCandidateForJob(candidateId, jobId);
  return { matchScore: score };
};

/* ── score_answer ────────────────────────────────────────────────────────────
 * Grades a single answer by index and persists it back onto the session. Not
 * enqueued by /end (summarize_interview grades all answers in one pass), but
 * available as a standalone, retriable unit for granular re-grading. */
const scoreAnswer: Handler = async (job) => {
  const sessionId = String((job.payload as any)?.sessionId ?? "");
  const answerIndex = Number((job.payload as any)?.answerIndex ?? -1);
  if (!sessionId || answerIndex < 0) throw new Error("score_answer: missing sessionId/answerIndex");

  const [session] = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sessionId))
    .limit(1);
  if (!session) throw new Error(`score_answer: session ${sessionId} not found`);

  const answers = (session.answers as any[]) || [];
  const a = answers[answerIndex];
  if (!a) return { skipped: "no_such_answer" };

  const [plan] = await dbAdmin
    .select()
    .from(interviewPlansTable)
    .where(eq(interviewPlansTable.id, session.planId))
    .limit(1);
  const questions = (plan?.questions as any[]) || [];
  const q = questions.find((qq: any) => qq.id === a.questionId);
  const qText = a.questionText || q?.text || "Interview question";
  const endFocusDir = (plan?.focusDirective ?? "").toString().trim();
  const focusLine = endFocusDir
    ? `\n\nThe recruiter asked this interview to focus on the job-relevant competency: "${endFocusDir}". Where this answer gives evidence of that competency, weigh it; never reward or penalize protected characteristics or personality labels.`
    : "";

  const graded = await gradeAnswer({ questionText: qText, answer: a.answer ?? "", language: session.language ?? "en-US", focusLine });
  if (!graded) throw new Error("score_answer: grading failed");
  a.score = graded.score;
  if (graded.feedback) a.feedback = graded.feedback;
  await dbAdmin.update(interviewSessionsTable).set({ answers }).where(eq(interviewSessionsTable.id, sessionId));
  return { score: graded.score };
};

export const handlers: Record<string, Handler> = {
  summarize_interview: summarizeInterview,
  generate_candidate_insights: generateCandidateInsights,
  match_candidate_to_job: matchCandidateToJob,
  score_answer: scoreAnswer,
  /* transcribe_answer is reserved for a future async-recording flow. The
     current keep-live interview transcribes in real time via /transcribe. */
  transcribe_answer: async () => ({ skipped: "live_transcription" }),
};
