/**
 * routes/prep.ts — Interview Preparation Plans & Sessions
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Generates and serves AI-powered interview preparation plans for candidates.
 * Accessible from the candidate portal (no recruiter auth required) so
 * candidates can self-serve prep materials before their interview.
 *
 * ─── Round types (mock interview modes) ─────────────────────────────────────
 *   behavioral        — STAR-format behavioural questions
 *   technical         — coding / technical depth
 *   competency        — leadership & people-management competency
 *   product_sense     — product judgement, prioritisation, customer empathy
 *   domain_deep_dive  — vertical / domain-specific expertise probe
 *   mock_interview    — mixed full-loop mock
 *   quick / full      — preset depth profiles
 *
 * ─── Per-dimension rubric (returned on session completion) ──────────────────
 *   clarity   — how clearly the candidate communicated
 *   depth     — how substantively they engaged with the problem
 *   structure — how well-organized the answer was
 *   signal    — strength of evidence the candidate has done this for real
 */
import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import { prepSessionsTable, prepPlansTable, jobsTable, usersTable, candidatesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { generateWithAI } from "../lib/ai";
import { assertNotForTraining } from "../lib/policies";
import { getAuthUserId } from "../lib/auth-token.js";
import { validate } from "../middlewares/validate";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";

/* Resolve the caller's OWN candidate record ids (empty unless role==="candidate").
   Prep content is candidate-owned: a candidate maps to their candidate row via
   candidates.userId and may only touch sessions/plans for that candidateId —
   tenant scope alone would leak peers' practice within the same tenant (report c). */
async function candidateOwnIds(user: { id: string; role: string }): Promise<string[]> {
  if (user.role !== "candidate") return [];
  const rows = await db.select({ id: candidatesTable.id })
    .from(candidatesTable).where(eq(candidatesTable.userId, user.id));
  return rows.map(r => r.id);
}

const GeneratePrepBody = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().min(1),
  mode: z.string().optional(),
});

const CreatePrepSessionBody = z.object({
  jobId: z.string().min(1),
  mode: z.string().optional(),
  candidateId: z.string().optional(),
});

const AnswerPrepBody = z.object({
  questionId: z.string().min(1),
  answerText: z.string().min(1),
});

/* Auth gate for prep routes (2026-05-23 audit, expanded).
 *
 * The prep module was half-built — all four routes were unauthenticated,
 * the two write paths (POST /prep/generate, POST /prep/sessions) hardcoded
 * `tenantId: "acme"`, and GET /prep/sessions returned every session in the
 * database regardless of tenant. Closed:
 *   - every route now requires a valid auth token
 *   - the user's resolved `tenantId` is used everywhere the code used to
 *     hardcode "acme"
 *   - GET /prep/sessions now filters by the caller's tenantId
 * Returns the resolved user row, or null after writing 401. */
async function requireAuthedUser(req: Request, res: Response): Promise<any | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || !user.tenantId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return user;
}

const router: IRouter = Router();

/* Per-round-type question banks. Used when no AI-generated questions are
   available so every round still feels purposeful. Keep these short and
   deliberately probing — the structured rubric below scores the answers. */
const ROUND_QUESTION_BANKS: Record<string, string[]> = {
  behavioral: [
    "Tell me about a time you disagreed with a senior leader. How did you handle it?",
    "Describe a project that failed. What did you learn?",
    "Walk me through a moment you had to make a decision with incomplete information.",
    "Tell me about feedback that changed how you work.",
    "Describe a time you had to influence without authority.",
  ],
  technical: [
    "Walk me through the most complex system you've designed end-to-end.",
    "Explain a tradeoff you made between latency, cost, and consistency.",
    "How would you debug a service that's intermittently slow under load?",
    "Describe a piece of code you're proud of and why.",
    "What's a technology you've adopted recently and what surprised you?",
  ],
  competency: [
    "How do you set direction for a team that has lost momentum?",
    "Describe how you run 1:1s and what you optimise them for.",
    "Tell me about a hire that didn't work out — and what you'd change.",
    "How do you handle a top performer who is hurting team morale?",
    "Describe how you measure your team's effectiveness.",
  ],
  product_sense: [
    "Pick a product you use daily. What would you change first and why?",
    "How would you decide whether to launch a feature with 60% of the spec done?",
    "A core metric is up but NPS is down. What do you investigate first?",
    "Walk me through how you'd size the market for a new B2B SaaS idea.",
    "Tell me about a time you killed a feature you had championed.",
  ],
  domain_deep_dive: [
    "Walk me through the deepest problem you've solved in your domain.",
    "What does 'best practice' look like in your domain — and where is it wrong?",
    "Describe a niche skill in your area that most generalists underestimate.",
    "What's a recent shift in your domain and how are you adapting?",
    "Teach me one non-obvious thing about your area in two minutes.",
  ],
  mock_interview: [
    "Tell me about yourself and your background",
    "Why are you interested in this specific role?",
    "Describe your most significant achievement",
    "How do you handle working under pressure?",
    "Where do you see yourself in 5 years?",
  ],
};

function questionsForMode(mode: string): string[] {
  return ROUND_QUESTION_BANKS[mode] ?? ROUND_QUESTION_BANKS.mock_interview;
}

/* Heuristic per-dimension rubric — fast, deterministic, and good enough for
   a v1 candidate-facing score. Each dimension is scored 0-100 from observable
   signals in the answer text. The candidate brochure promises structured
   scoring; this is the structure. */
function scoreRubric(answers: { questionId?: string; answer: string }[]): {
  clarity: number; depth: number; structure: number; signal: number;
} {
  const texts = answers.map(a => (a?.answer ?? "").trim()).filter(Boolean);
  if (texts.length === 0) {
    return { clarity: 0, depth: 0, structure: 0, signal: 0 };
  }
  const allText = texts.join(" ");
  const lengths = texts.map(t => t.split(/\s+/).length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;

  /* clarity — penalise ultra-short answers and very long unfocused ones */
  const clarity = Math.round(Math.min(100, Math.max(20,
    avgLen <= 15 ? 35 : avgLen <= 60 ? 60 : avgLen <= 200 ? 88 : 70)));

  /* depth — reward concrete numbers, named systems, named people/companies */
  const numberHits = (allText.match(/\b\d+(\.\d+)?%?\b/g) ?? []).length;
  const properNouns = (allText.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? []).length;
  const depthRaw = 40 + numberHits * 4 + properNouns * 1.2;
  const depth = Math.round(Math.min(100, Math.max(25, depthRaw)));

  /* structure — STAR-ish words & connectors signal organisation */
  const structureMarkers = [
    "situation", "task", "action", "result",
    "first", "then", "next", "finally", "because", "so that",
  ];
  const lower = allText.toLowerCase();
  const markerHits = structureMarkers.filter(m => lower.includes(m)).length;
  const structure = Math.round(Math.min(100, Math.max(30, 45 + markerHits * 6)));

  /* signal — first-person ownership ("I led", "I designed", "I shipped") */
  const ownershipHits = (allText.match(/\bI\s+(led|designed|shipped|built|owned|launched|negotiated|mentored|hired|fired|grew|cut|reduced|delivered)\b/gi) ?? []).length;
  const signal = Math.round(Math.min(100, Math.max(30, 40 + ownershipHits * 8)));

  return { clarity, depth, structure, signal };
}

/* Pull up to 3 strongest verbatim quote snippets — first sentence of the
   three longest answers, lightly truncated. Pure surfacing, no AI. */
function extractVerbatimQuotes(answers: { answer: string }[]): string[] {
  return answers
    .map(a => (a?.answer ?? "").trim())
    .filter(t => t.length > 30)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .map(t => {
      const firstSentence = t.split(/[.!?]\s/)[0] ?? t;
      const trimmed = firstSentence.trim();
      return trimmed.length > 220 ? trimmed.slice(0, 217) + "…" : trimmed;
    });
}

router.post("/prep/generate", validate({ body: GeneratePrepBody }), async (req, res) => {
  const user = await requireAuthedUser(req, res);
  if (!user) return;
  const { candidateId, jobId, mode = "quick" } = req.body;
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  /* Candidate self-path: may only generate prep for their OWN candidate record.
     Staff: tenant scope FIRST (fail-closed on missing/out-of-scope job), THEN the
     plain-recruiter ASSIGNED-requisition ceiling. */
  if (user.role === "candidate") {
    const own = await candidateOwnIds(user);
    if (!own.includes(candidateId)) { res.status(404).json({ error: "Not found" }); return; }
  } else {
    if (!job) { res.status(404).json({ error: "Not found" }); return; }
    const allowed = await getDataScopeTenantIds(user);
    if (allowed !== null && !allowed.includes(job.tenantId ?? "")) { res.status(404).json({ error: "Not found" }); return; }
    if (!(await recruiterOwnsResource(user, { kind: "jobId", value: jobId }))) { res.status(404).json({ error: "Not found" }); return; }
  }

  const prompt = `Generate interview preparation materials for a candidate applying to: ${job?.title || "a software position"}.
Mode: ${mode}
Return JSON with: likelyQuestions (array of 5-8 questions), keySkillsToFocus (array), preparationTips (array), readinessScore (number 0-100).`;

  const aiResponse = await generateWithAI(prompt);
  let parsed: any = {};
  try { parsed = JSON.parse(aiResponse); } catch { parsed = {}; }

  const [plan] = await db.insert(prepPlansTable).values({
    /* Was previously hardcoded `tenantId: "acme"` — see audit_report.md. */
    tenantId: user.tenantId,
    candidateId,
    jobId,
    mode,
    likelyQuestions: parsed.likelyQuestions || ["Tell me about yourself", "Why are you interested in this role?"],
    keySkillsToFocus: parsed.keySkillsToFocus || ["Technical skills", "Communication"],
    preparationTips: parsed.preparationTips || ["Research the company", "Prepare STAR examples"],
    estimatedPrepTimeMinutes: mode === "quick" ? 20 : mode === "full" ? 180 : 60,
    readinessScore: parsed.readinessScore || 72,
  }).returning();

  res.json({ ...plan, createdAt: plan.createdAt.toISOString() });
});

router.get("/prep/sessions", async (req, res) => {
  const user = await requireAuthedUser(req, res);
  if (!user) return;
  const { candidateId } = req.query;
  /* Was previously: `db.select().from(prepSessionsTable)` with no filter —
     returned every session in the database. Now scoped to caller's tenant. */
  let sessions = await db.select().from(prepSessionsTable)
    .where(eq(prepSessionsTable.tenantId, user.tenantId))
    .orderBy(desc(prepSessionsTable.createdAt));
  /* Candidate self-path: only their OWN sessions — tenant scope alone leaks peers.
     Plain-recruiter ceiling: only sessions for an ASSIGNED requisition. */
  if (user.role === "candidate") {
    const own = new Set(await candidateOwnIds(user));
    sessions = own.size === 0 ? [] : sessions.filter(s => s.candidateId && own.has(s.candidateId));
  } else if (user.role === "recruiter") {
    const assigned = new Set(await getRecruiterAssignedJobIds(user));
    sessions = assigned.size === 0 ? [] : sessions.filter(s => s.jobId && assigned.has(s.jobId));
  }
  if (candidateId) sessions = sessions.filter(s => s.candidateId === candidateId);
  res.json(sessions.map(s => ({ ...s, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() })));
});

router.post("/prep/sessions", validate({ body: CreatePrepSessionBody }), async (req, res) => {
  const user = await requireAuthedUser(req, res);
  if (!user) return;
  const { jobId, mode = "quick" } = req.body;
  let candidateId: string | undefined = req.body.candidateId;
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  /* Candidate self-path: candidateId must be their OWN record (default→their id).
     Staff: tenant scope FIRST (fail-closed on missing/out-of-scope job), THEN the
     plain-recruiter ASSIGNED-requisition ceiling. */
  if (user.role === "candidate") {
    const own = await candidateOwnIds(user);
    if (candidateId && !own.includes(candidateId)) { res.status(404).json({ error: "Not found" }); return; }
    /* A candidate with NO candidate-record mapping (staff without a candidate row,
       or an orphaned account) has no self record to attach a session to. Fail
       closed with 404 — never fall through to the "default" placeholder below,
       which would create an orphan session the caller can't read back. */
    if (!candidateId) {
      if (own.length === 0) { res.status(404).json({ error: "Not found" }); return; }
      candidateId = own[0];
    }
  } else {
    if (!job) { res.status(404).json({ error: "Not found" }); return; }
    const allowed = await getDataScopeTenantIds(user);
    if (allowed !== null && !allowed.includes(job.tenantId ?? "")) { res.status(404).json({ error: "Not found" }); return; }
    if (!(await recruiterOwnsResource(user, { kind: "jobId", value: jobId }))) { res.status(404).json({ error: "Not found" }); return; }
  }

  const questions = questionsForMode(mode);

  const [session] = await db.insert(prepSessionsTable).values({
    /* Was previously hardcoded `tenantId: "acme"` — see audit_report.md. */
    tenantId: user.tenantId,
    candidateId: candidateId || "default",
    jobId,
    mode,
    status: "active",
    questionsAnswered: 0,
    totalQuestions: questions.length,
    questions,
    answers: [],
  }).returning();

  res.status(201).json({ ...session, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() });
});

router.post("/prep/sessions/:sessionId/answer", validate({ body: AnswerPrepBody }), async (req, res) => {
  const user = await requireAuthedUser(req, res);
  if (!user) return;
  const { questionId, answerText } = req.body;
  const [session] = await db.select().from(prepSessionsTable).where(eq(prepSessionsTable.id, req.params.sessionId)).limit(1);
  if (!session) { res.status(404).json({ error: "Not found" }); return; }

  /* Post-load owner check (previously ABSENT — any authed user could answer any
     session cross-tenant). Candidate self-path: only their OWN session. Staff:
     data-scope tenant + plain-recruiter assigned-req ceiling. */
  if (user.role === "candidate") {
    const own = await candidateOwnIds(user);
    if (!session.candidateId || !own.includes(session.candidateId)) { res.status(404).json({ error: "Not found" }); return; }
  } else {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed !== null && !(session.tenantId && allowed.includes(session.tenantId))) {
      res.status(404).json({ error: "Not found" }); return;
    }
    if (!(await recruiterOwnsResource(user, { kind: "jobId", value: session.jobId ?? "" }))) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  /* Hard policy guard: candidate practice content must NEVER be exported into
     model-training pathways. Throws if the caller hints at training intent. */
  assertNotForTraining({ purpose: "prep_session_answer", candidateId: session.candidateId });

  const questions = (session.questions as string[]) || [];
  const answers = (session.answers as any[]) || [];
  answers.push({ questionId, answer: answerText });

  const isComplete = answers.length >= session.totalQuestions;

  /* On completion, compute a per-dimension rubric and lift the strongest
     verbatim quotes — both surfaced in the candidate dashboard. */
  let rubricScores: ReturnType<typeof scoreRubric> | null = null;
  let verbatimQuotes: string[] = [];
  let readinessScore: number | null = null;
  if (isComplete) {
    rubricScores = scoreRubric(answers);
    verbatimQuotes = extractVerbatimQuotes(answers);
    /* Overall readiness = weighted average of the four dimensions */
    readinessScore = Math.round(
      rubricScores.clarity * 0.2 +
      rubricScores.depth * 0.3 +
      rubricScores.structure * 0.2 +
      rubricScores.signal * 0.3
    );
  }

  await db.update(prepSessionsTable).set({
    answers,
    questionsAnswered: answers.length,
    status: isComplete ? "completed" : "active",
    readinessScore,
    rubricScores: rubricScores as any,
    verbatimQuotes: verbatimQuotes as any,
    updatedAt: new Date(),
  }).where(eq(prepSessionsTable.id, req.params.sessionId));

  const nextIdx = answers.length;
  const nextQuestion = !isComplete && nextIdx < questions.length ? questions[nextIdx] : null;

  res.json({
    score: readinessScore ?? 78,
    rubricScores,
    verbatimQuotes,
    feedback: isComplete
      ? "Session complete — see your per-dimension rubric below. Use the strongest line you said as a starter for your next live interview."
      : "Good answer! Try to be more specific with concrete examples. Use the STAR method (Situation, Task, Action, Result) to structure your response.",
    strengths: ["Clear communication", "Relevant experience mentioned"],
    improvements: ["Add specific metrics", "Structure with STAR format"],
    sampleAnswer: "A strong answer would include: a specific situation, your role and responsibility, the concrete actions you took, and the measurable results achieved.",
    nextQuestion,
    isComplete,
  });
});

export default router;
