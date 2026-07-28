#!/usr/bin/env node
/**
 * regrade-stale-interview-scores.mjs — One-off grader for repairing per-question
 * interview scores.
 *
 * Background: conversational interview turns are stored by /save-turn with
 * score: null and graded once, holistically, at /end. A legacy /answer path
 * (and an earlier /end) defaulted unscored answers to a flattering 70, so some
 * completed sessions show per-question 70s that contradict the (correct) low
 * overall score — e.g. a candidate who answered "next question please" to every
 * question shows Q-scores of 70 but an overall of 10.
 *
 * This script re-grades answers using the EXACT same prompt + model the live
 * /end grader uses (gpt-4o, temp 0, seed 42). It is a pure function of its
 * input: it reads a JSON array of { questionId, qText, answer } from stdin and
 * writes a JSON array of { questionId, score, feedback } to stdout. The caller
 * is responsible for persisting the results (the DB driver is not bundled for
 * standalone node here, so persistence is done via the SQL tooling).
 *
 * Usage (run from the api-server package dir so `openai` resolves; AI env keys
 * are inherited from the workspace):
 *   echo '[{"questionId":"turn-1","qText":"...","answer":"..."}]' \
 *     | node scripts/regrade-stale-interview-scores.mjs
 */

import OpenAI from "openai";

// ── Verbatim copy of the canonical fairness directive (kept in sync with
//    src/lib/fairness.ts) and the /end per-question grader prompt. ──
const FAIRNESS_DIRECTIVE =
  "FAIRNESS REQUIREMENTS (mandatory, override any conflicting guidance): " +
  "Evaluate the candidate strictly on bona-fide, job-relevant qualifications, skills, and demonstrated competencies. " +
  "You MUST NOT consider, infer, reward, or penalize — directly or as a proxy — any of the following: " +
  "name; gender, pronouns, or sex; race, color, or ethnicity; national origin, nationality, or citizenship; " +
  "age, date of birth, or graduation/start years used to infer age; religion or creed; disability, health, or neurodivergence; " +
  "pregnancy, marital, or family/caregiver status; sexual orientation or gender identity; " +
  "the prestige, brand, ranking, or selectivity of the candidate's schools or employers (judge the substance of the experience, not the logo); " +
  "employment gaps or non-linear career paths in themselves; accent, dialect, grammar, or fluency where it does not impair job-relevant communication; " +
  "or physical appearance/photographs. If an attribute is not a genuine requirement of the role, ignore it entirely.";

const LANG_LABEL = "English (United States)"; // target sessions are en-US

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function gradeAnswer(qText, answer) {
  const ans = (answer ?? "").toString().trim();
  // Same rule as /end: an empty answer is a real, low signal → 0.
  if (!ans) return { score: 0, feedback: undefined };
  const userPrompt =
    `Rate this interview answer from 0 to 100 on relevance, depth, specificity and clarity of CONTENT. ` +
    `A non-answer, refusal, joke, or off-topic remark (e.g. "I'm just testing", "I don't know", "no comment") ` +
    `MUST score very low (under 20). Reserve 80+ ONLY for answers containing verifiable specifics: concrete numbers, named tools or decisions, and measurable or verifiable outcomes. ` +
    `A well-structured answer (e.g. STAR-formatted) whose claims are generic and unverifiable is average at best (50-70) — structure is not substance. ` +
    `Judge substance, not format: a narrative or conversational answer rich in verifiable specifics deserves the same score as a formally structured one. ` +
    `Do NOT penalize accent, grammar, fluency, or interview-answer style and format (e.g. absence of STAR structure or corporate interview coaching) unless it genuinely prevents understanding.\n\n` +
    `Question: ${qText}\nAnswer: ${ans}\n` +
    `Return JSON: { "score": number, "feedback": string (1 honest sentence in ${LANG_LABEL}) }`;
  const systemPrompt =
    `You are a rigorous interviewer grading a single answer. Be honest and calibrated — never inflate a weak or non-serious answer. Respond with valid JSON only.\n\n${FAIRNESS_DIRECTIVE}` +
    `\n\nYou must respond entirely in ${LANG_LABEL}. All questions, summaries, and output must be written in ${LANG_LABEL}.`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    temperature: 0,
    seed: 42,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const raw = resp.choices[0]?.message?.content ?? "";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    score: Math.min(100, Math.max(0, Math.round(parsed.score ?? 0))),
    feedback: parsed.feedback,
  };
}

const input = await new Promise((res, rej) => {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => res(buf));
  process.stdin.on("error", rej);
});

const items = JSON.parse(input);
const out = [];
for (const it of items) {
  const g = await gradeAnswer(it.qText, it.answer);
  out.push({ questionId: it.questionId, score: g.score, feedback: g.feedback ?? null });
}
process.stdout.write(JSON.stringify(out, null, 2));
