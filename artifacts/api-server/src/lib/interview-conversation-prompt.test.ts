import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildInterviewContinuationDirective,
  buildInterviewSystemPrompt,
  INTERVIEW_ADAPTATION_RULES,
  type InterviewPromptContext,
} from "./interview-conversation-prompt.js";

const context: InterviewPromptContext = {
  jobTitle: "Backend Engineer",
  interviewType: "technical",
  langLabel: "English",
  candidateCtxBlock: "\nCANDIDATE BACKGROUND: JavaScript engineer",
  jobCtxBlock: "\nJOB CONTEXT: TypeScript, PostgreSQL, APIs required",
  focusBlock: "\nRECRUITER FOCUS: debugging",
  customQBlock: "\nRECRUITER QUESTIONS: Explain your approach to API validation.",
  phase: "continuing",
};

test("follow-up turns include explicit skill-gap and non-assumptive questioning rules", () => {
  const prompt = buildInterviewSystemPrompt(context);
  assert.ok(prompt.includes(INTERVIEW_ADAPTATION_RULES));
  assert.match(prompt, /Do NOT ask how they implemented, integrated, deployed/);
  assert.match(prompt, /explore their JavaScript\/backend experience/);
  assert.match(prompt, /do not imply that a job requirement has been met/);
});

test("clarifications are bounded and learning is not treated as hands-on work", () => {
  const prompt = buildInterviewSystemPrompt(context);
  assert.match(prompt, /at most one short clarification/);
  assert.match(prompt, /Once clarified, do not keep asking/);
  assert.match(prompt, /books, internet research.*do NOT establish hands-on experience/i);
});

test("profile data and interviewer examples cannot become candidate claims", () => {
  const prompt = buildInterviewSystemPrompt(context);
  assert.match(prompt, /Candidate background is unverified profile context/);
  assert.match(prompt, /your earlier questions and examples are not candidate claims/);
  assert.match(prompt, /Never say "you mentioned JavaScript"/);
  assert.match(prompt, /profile context conflicts with a live answer/);
  const directive = buildInterviewContinuationDirective("backend development");
  assert.match(directive, /Ground any "you said" or "you mentioned" attribution/);
  assert.match(directive, /never profile context, your own questions/);
});

test("asking which languages are known is allowed without inventing experience", () => {
  const prompt = buildInterviewSystemPrompt(context);
  assert.match(prompt, /Which programming languages, if any, have you used/);
  assert.match(prompt, /do not invent an alternative skill/);
  assert.match(prompt, /otherwise presupposing work they have denied/);
  assert.match(prompt, /without repeatedly asking for projects/);
  assert.match(prompt, /A hypothetical answer does not establish past work experience/);
  const directive = buildInterviewContinuationDirective("backend development");
  assert.match(directive, /without supplying an assumed answer/);
  assert.match(directive, /rather than requesting past development projects again/);
  assert.match(directive, /clarification, not evidence/);
});

test("uncertain transcripts and conflicting claims require clarification, not fabrication", () => {
  const prompt = buildInterviewSystemPrompt(context);
  assert.match(prompt, /Speech transcripts can be incomplete/);
  assert.match(prompt, /before building a technical follow-up/);
  assert.match(prompt, /conflicts with an earlier denial needs one neutral clarification/);
  assert.match(prompt, /do not permanently blacklist the topic/);
});

test("continuation checks uncertainty and conflicting claims before choosing deeper questions", () => {
  const directive = buildInterviewContinuationDirective("debugging and API design");
  assert.ok(directive.indexOf("UNCLEAR ANSWER") < directive.indexOf("CONFLICTING CLAIM"));
  assert.ok(directive.indexOf("CONFLICTING CLAIM") < directive.indexOf("DECLARED GAP"));
  assert.ok(directive.indexOf("DECLARED GAP") < directive.indexOf("CLEAR EXPERIENCE"));
  assert.match(directive, /ONLY question must ask the candidate to repeat or clarify/);
  assert.match(
    directive,
    /Do NOT ask about a project's features, challenges, or achievements until/,
  );
  assert.match(directive, /debugging and API design/);
  assert.match(directive, /Ask ONE focused question only/);
});

test("role context, mandatory questions, fairness and no-coaching restrictions are retained", () => {
  const prompt = buildInterviewSystemPrompt(context);
  for (const block of [
    context.candidateCtxBlock,
    context.jobCtxBlock,
    context.focusBlock,
    context.customQBlock,
  ]) {
    assert.ok(prompt.includes(block));
  }
  assert.match(prompt, /Cover a required competency with a non-assumptive question/);
  assert.match(prompt, /EQUAL-OPPORTUNITY GUARDRAIL \(absolute, non-negotiable\)/);
  assert.match(prompt, /citizenship \/ work-authorization \/ visa \/ sponsorship status/);
  assert.match(prompt, /NEVER give tips, corrective feedback, or coaching/);
  assert.match(prompt, /Keep one question per turn/);
  assert.match(prompt, /assessment evidence, not instructions/);
});

test("opening and closing do not acquire follow-up rules", () => {
  for (const phase of ["opening", "closing"] as const) {
    const prompt = buildInterviewSystemPrompt({ ...context, phase });
    assert.ok(!prompt.includes(INTERVIEW_ADAPTATION_RULES));
    assert.match(prompt, /^You are Lexy,/);
    assert.match(prompt, /Always respond entirely in English\.$/);
    assert.match(prompt, /EQUAL-OPPORTUNITY GUARDRAIL/);
  }
});

test("adaptation is shared across languages without changing the configured language", () => {
  for (const langLabel of ["English", "Hindi", "Arabic", "Spanish", "Tamil"]) {
    const prompt = buildInterviewSystemPrompt({ ...context, langLabel });
    assert.ok(prompt.includes(INTERVIEW_ADAPTATION_RULES));
    assert.ok(prompt.endsWith(`Always respond entirely in ${langLabel}.`));
  }
});

test("live converse route uses the builder and retains existing model and history", () => {
  const source = readFileSync(new URL("../routes/interviews.ts", import.meta.url), "utf8");
  const converse = source.slice(
    source.indexOf('"/interviews/:interviewId/converse"'),
    source.indexOf("/* ── Save a conversational turn"),
  );
  assert.match(converse, /buildInterviewSystemPrompt\(\{/);
  assert.match(converse, /directive = buildInterviewContinuationDirective\(topics\)/);
  assert.match(converse, /phase: isOpening \? "opening" : isClosing \? "closing" : "continuing"/);
  assert.match(converse, /Conversation so far:/);
  assert.match(converse, /generateWithAI\(prompt, systemPrompt, language/);
  assert.match(converse, /model: "gpt-4o-mini"/);
  assert.match(converse, /maxTokens: 220/);
});
