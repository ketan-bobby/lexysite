import type { Article } from "./types";

export const aiArticles: Article[] = [
  {
    slug: "ai-interview-software",
    category: "AI Hiring",
    title: "AI Interview Software: What to Look For (and What to Avoid)",
    excerpt:
      "A buyer's guide to AI interview platforms — the capabilities that matter, the questions to ask vendors, and the red flags that should stop a purchase.",
    readTime: "7 min read",
    body: `
## The market is noisy on purpose

Every recruiting tool now claims AI. Very few change what gets measured. Before evaluating vendors, decide what you're buying: automation of a broken process (faster resume screening), or a better process (direct capability measurement). The first saves hours. The second improves hires.

## Capabilities that matter

**Structured, not scripted-feeling.** The AI should ask consistent core questions across candidates — that's what makes results comparable — while probing follow-ups naturally, the way a skilled human interviewer does.

**Transparent scoring.** For every score, you should be able to see the evidence: what the candidate said, which rubric anchor it matched. A number without a trail is a liability, not a signal.

**Fairness engineering you can inspect.** Ask precisely: What information is redacted before scoring? Is scoring blind to accent, name, and demographic signals? Can they show adverse-impact monitoring? "Our AI is unbiased" is not an answer; a described mechanism is.

**Human oversight by design.** AI should produce evidence; humans should make decisions. Platforms that auto-reject without human review are a legal and ethical exposure in a growing list of jurisdictions.

**Candidate experience.** Interview completion rates and candidate feedback are measurable. Ask for them.

## Red flags

- Facial-expression, tone-of-voice, or "personality inference" analysis — scientifically shaky and increasingly regulated
- Scores with no visible reasoning or transcript
- No answer to "how do you test for adverse impact?"
- Claims of eliminating bias (honest vendors reduce and measure; nobody eliminates)
- No data-processing agreement, retention policy, or deletion path

## Questions for the shortlist

1. Show me exactly what a hiring manager sees for one candidate.
2. Show me what the candidate experiences, start to finish.
3. What happens when the AI is uncertain?
4. Which decisions does a human make, and where is that recorded?
5. What do you log, and for how long?

The right platform makes your interviews more consistent, your evidence more defensible, and your decisions demonstrably fairer — and can show you, not just tell you, all three.
`,
  },
  {
    slug: "ai-recruiting-explained",
    category: "AI Hiring",
    title: "AI Recruiting, Explained: What It Actually Does in 2026",
    excerpt:
      "Beyond the buzzword: where AI genuinely helps in recruiting, where it's just automation, and where it shouldn't be trusted at all.",
    readTime: "6 min read",
    body: `
## Three very different things called "AI recruiting"

The label covers three distinct technologies, and conflating them is how buying mistakes happen.

**1. Automation with an AI badge.** Resume parsing, interview scheduling, email sequencing. Valuable, mature, and mostly not intelligence — it moves paperwork faster without changing any decision.

**2. Prediction from proxies.** Models that rank candidates from resume features — schools, employers, tenure patterns. This is the risky category: models trained on historical hiring data learn historical hiring bias, and the proxies themselves (as decades of selection research show) barely predict performance. Amazon's famously scrapped resume model is the canonical warning.

**3. Direct measurement.** AI that conducts and scores structured interviews, evaluates work samples, and verifies claimed skills. This category changes what gets measured — from what candidates wrote to what they can demonstrate — and it's where the genuine gains live.

## What AI does well in hiring

- **Consistency at scale.** An AI interviewer asks question twelve exactly as attentively as question one, for candidate one and candidate five hundred, at 9 a.m. or midnight.
- **Structured evidence capture.** Every answer transcribed, scored against a rubric, and traceable — a level of record-keeping human processes almost never sustain.
- **Widening the funnel.** When screening measures demonstrated capability instead of resume pattern-matching, candidates from non-traditional paths get evaluated instead of filtered.

## What AI should not do

- Make the final hiring decision (humans decide; AI provides evidence)
- Infer personality, emotion, or honesty from faces and voices
- Operate as a black box on decisions that affect livelihoods

## The direction of travel

Regulation (from NYC's Local Law 144 to the EU AI Act) is converging on the same demands good practice already makes: transparency, human oversight, bias testing, and candidate notice. Teams that adopt measurement-based AI hiring with those properties get better hires now and compliance later — the same architecture serves both.
`,
  },
  {
    slug: "ai-candidate-evaluation",
    category: "AI Hiring",
    title: "AI Candidate Evaluation: How Machines Score Interviews",
    excerpt:
      "What actually happens between a candidate's answer and a score on a dashboard — and how to tell rigorous evaluation from a black box.",
    readTime: "6 min read",
    body: `
## From answer to evidence

A rigorous AI evaluation pipeline has distinct, inspectable stages:

**1. Capture.** The candidate's answer is recorded and transcribed. Modern speech recognition handles dozens of languages and accents — and a serious platform measures and reports its transcription accuracy across them, because a mis-transcribed answer is a mis-scored candidate.

**2. Redaction.** Before scoring, information that shouldn't influence evaluation is stripped: names, demographic signals, personal identifiers. Scoring operates on the substance of the answer.

**3. Rubric scoring.** The answer is evaluated against the same anchored rubric a structured human interview would use: did the candidate give a specific example? Did they articulate their own actions? Did they reason about tradeoffs? Each score maps to anchor criteria, not to an opaque "quality" judgment.

**4. Consistency checks.** Strong systems look across the whole interview: do claimed skills hold up under follow-up probing? Are answers internally consistent? Is the response pattern anomalous?

**5. Evidence assembly.** The output isn't a number — it's a scored, quoted, traceable record a human reviews to make the decision.

## Questions that separate rigor from theater

- *Can I see why this answer scored a 3?* If the platform can't show the rubric anchor and the relevant quote, it's a black box.
- *What was redacted before scoring?* If nothing, bias flows freely into the model's judgment.
- *How is scoring validated?* Look for calibration against expert human scorers and monitoring for drift.
- *What happens at the margins?* Uncertain scores should be flagged for human review, not silently rounded.

## The standard to hold

The test of an AI evaluation is the same as for a human one: would two independent reviews of the same answer reach similar scores, and could you defend the score to the candidate's face? Machines make that standard *achievable at scale* — they don't get tired, anchored, or charmed. But only if the pipeline is built for evidence, not just prediction.
`,
  },
  {
    slug: "ai-interview-agents",
    category: "AI Hiring",
    title: "AI Interview Agents: The Interviewer That Never Has a Bad Day",
    excerpt:
      "Conversational AI agents now conduct full structured interviews — asking, probing, and scoring in real time. Here's how they work and why they're winning.",
    readTime: "6 min read",
    body: `
## What an interview agent is

An AI interview agent is a conversational system that conducts a complete interview: it asks structured questions by voice, listens to the answers, probes with relevant follow-ups, and scores responses against a rubric — in real time, in the candidate's language, at any hour.

This is not a chatbot with a question list. The agent adapts within structure: the core questions stay consistent (that's what makes candidates comparable), while follow-ups respond to what the candidate actually said — "you mentioned the migration failed; what did you do in the first hour?"

## Why agents outperform the logistics of human screening

**Every candidate gets interviewed.** The brutal math of human screening — hundreds of applicants, hours per interview — is why resumes still gatekeep. An agent removes the constraint: the 200th applicant gets the same full, attentive interview as the 1st.

**No fatigue, no drift, no mood.** Human interviewers score the same answer differently at 9 a.m. and 5 p.m. Agents don't. Consistency isn't a virtue they practice; it's a property they have.

**Candidates schedule nothing.** Interviews happen when candidates are ready — evenings, weekends, across time zones. Completion rates climb when the interview meets the candidate instead of the reverse.

**Structure survives contact with reality.** Human panels famously abandon their scripts. The agent asks every question, scores every answer, and files every piece of evidence, every time.

## What good agents do that mediocre ones don't

- Speak the candidate's language — dozens of them — with the same evaluation standard across all
- Hand uncertainty to humans instead of guessing
- Produce a full evidence trail: transcript, scores, rubric anchors, flags
- Treat candidates well: clear expectations, natural pacing, a chance to finish thoughts

## The human role, sharpened

Agents don't replace human judgment — they feed it. The recruiter stops spending hours on repetitive screens and starts reviewing structured evidence, interviewing finalists deeply, and making decisions. The agent does the consistent part; humans do the judgment part. That division is exactly right.
`,
  },
];
