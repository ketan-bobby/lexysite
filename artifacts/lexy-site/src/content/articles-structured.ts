import type { Article } from "./types";

export const structuredArticles: Article[] = [
  {
    slug: "structured-interview-guide",
    category: "Structured Interviews",
    title: "The Structured Interview Guide: How to Run Interviews That Predict Performance",
    excerpt:
      "Structured interviews are among the strongest predictors of job performance ever measured. Here's how to design and run one, step by step.",
    readTime: "8 min read",
    body: `
## Why structure wins

In selection research, structured interviews consistently rank alongside work samples as the strongest predictors of job performance — roughly twice as predictive as unstructured conversations. The reason is simple: structure removes the noise that drowns the signal.

An unstructured interview measures rapport, confidence, and similarity to the interviewer. A structured interview measures the candidate.

## The four pillars of structure

**1. Consistent questions.** Every candidate for the role answers the same questions, in the same order. This is what makes answers comparable — without it, you're comparing apples to conversations.

**2. Job-derived content.** Questions come from an analysis of what the role actually requires — the competencies that separate strong performers from weak ones — not from an interviewer's favorites.

**3. Anchored scoring.** Each question has a rubric describing what a 1, a 3, and a 5 look like, written before any interviews happen. Scorers rate against the anchors, not against each other.

**4. Independent evaluation.** Scores are recorded per question, during or immediately after the interview, before any group discussion contaminates them.

## Designing the interview

1. **List the competencies.** Pick the four to six capabilities that actually determine success in the role. Fewer, measured well, beats many measured loosely.
2. **Write two questions per competency.** Behavioral ("tell me about a time…") and situational ("what would you do if…") both work; the evidence slightly favors using both.
3. **Write the anchors.** For each question, describe a weak, adequate, and excellent answer in concrete terms.
4. **Pilot it.** Run the interview on a current strong performer. If the questions don't differentiate, rewrite them.

## Running it

- Ask the questions as written. Probe for specifics — "what did *you* do?" — but don't improvise new questions.
- Take notes on what the candidate *said*, not how you felt.
- Score each answer against the anchors before moving on mentally.
- Never discuss a candidate with co-interviewers before scores are recorded.

## What you get

Comparable evidence for every candidate, a defensible record of every decision, a fairer experience for everyone interviewed — and, on the evidence of fifty years of research, meaningfully better hires.
`,
  },
  {
    slug: "structured-interview-template",
    category: "Structured Interviews",
    title: "Structured Interview Template: Questions and Rubric You Can Use Today",
    excerpt:
      "A ready-to-use structured interview template — competencies, questions, and a scoring rubric — that works for almost any professional role.",
    readTime: "7 min read",
    body: `
## How to use this template

Pick four competencies that matter for the role (the four below fit most professional positions), ask both questions for each, and score every answer against the rubric before comparing candidates. Total time: about 50 minutes.

## Competency 1: Problem solving

- *"Walk me through the most complex problem you've solved in the last year. What made it hard, and what did you actually do?"*
- *"Imagine you inherit a project that's behind schedule and the original owner is gone. What are your first three moves?"*

## Competency 2: Communication

- *"Tell me about a time you had to explain something technical or complicated to someone who disagreed with you. How did it go?"*
- *"If you had to give this team one piece of difficult feedback after your first month, how would you deliver it?"*

## Competency 3: Ownership

- *"Describe a time something failed and it was at least partly your fault. What happened afterward?"*
- *"Tell me about a time you did work nobody asked you to do. Why did you do it?"*

## Competency 4: Adaptability

- *"Tell me about a time priorities changed suddenly under you. What did you keep, and what did you drop?"*
- *"What's a strongly held opinion about your work you've reversed in the last two years?"*

## The scoring rubric

Score each answer 1–5 against these anchors:

- **1 — No evidence.** Vague, generic, or evasive. Cannot name specifics when probed.
- **2 — Weak.** Real example, but the candidate's own role in it is unclear or minimal.
- **3 — Solid.** Specific example, clear personal actions, plausible outcome.
- **4 — Strong.** Specific, personally owned, with reflection — the candidate can say what they'd do differently.
- **5 — Exceptional.** All of the above, plus evidence the behavior is repeated and deliberate, not a one-off.

## Three rules that protect the data

1. Score during or immediately after the interview — never from memory the next day.
2. Don't average away disagreement between interviewers; discuss the specific answers that produced it.
3. If every candidate scores 4+, your anchors are too soft. Recalibrate.
`,
  },
  {
    slug: "interview-scorecards",
    category: "Structured Interviews",
    title: "Interview Scorecards: How to Build One That Actually Gets Used",
    excerpt:
      "A good scorecard turns interviews into comparable data. A bad one becomes a form nobody fills in. The difference is design.",
    readTime: "6 min read",
    body: `
## What a scorecard is for

An interview scorecard does three jobs: it forces evaluation against criteria (not vibes), it makes candidates comparable, and it creates a record you can defend later. Most scorecards fail because they're designed for compliance, not for the interviewer filling them in.

## The anatomy of a scorecard that works

**Per-competency scores, not one overall number.** An overall score invites a gut call laundered through a form. Four to six competency scores force the evaluator to think about each dimension separately.

**Anchored scales.** "Rate communication 1–5" produces noise — every interviewer carries a different internal scale. Anchors ("3 = explained their reasoning clearly when probed; 5 = adjusted their explanation to the listener unprompted") produce data.

**An evidence field per score.** One required sentence: *what did the candidate say or do that justifies this score?* This single field does more for scorecard quality than anything else — a score without evidence is just a mood.

**A recommendation, separated from the scores.** Hire/no-hire is recorded last, so the scores inform the recommendation rather than justify it retroactively.

## What to leave out

- Free-text "general impressions" boxes (they collect bias and legal risk in equal measure)
- Criteria nobody can observe in an interview ("passion," "hunger")
- More than seven competencies (fatigue sets in and later scores go soft)

## The discipline that makes it work

Fill it in **before** discussing the candidate with anyone. The first opinion voiced in a debrief anchors every scorecard completed after it. Independent-then-discuss is the whole game: scores recorded independently are data; scores recorded after a discussion are consensus dressed as data.

## The payoff

Six months in, compare scorecards to actual performance. This is the moment scorecards become a system: you learn which competencies and which questions predicted success, and your next iteration measurably improves. Teams without scorecards can never run this loop — they have nothing to compare.
`,
  },
  {
    slug: "interview-evaluation-forms",
    category: "Structured Interviews",
    title: "Interview Evaluation Forms: What to Include and What to Avoid",
    excerpt:
      "The evaluation form is where interviews become records. Here's how to design one that's useful in the debrief and defensible years later.",
    readTime: "5 min read",
    body: `
## The form is the record

Months or years after an interview, the evaluation form is all that remains. If a hiring decision is ever questioned — by a candidate, a court, or your own audit — the form is your evidence. Design it accordingly.

## What to include

- **The role's defined competencies**, each scored on an anchored scale
- **A required evidence note per score** — what was observed, in behavioral terms
- **The questions asked** (or a reference to the standard set), proving consistency across candidates
- **Interviewer identity and date**
- **A structured recommendation** — hire / no hire / insufficient evidence, tied to the scores

## What to avoid

- **Open "comments" sections.** Unstructured space fills with unstructured judgment — the exact thing the form exists to prevent, and the first thing opposing counsel reads.
- **Protected-characteristic adjacent observations.** Notes about age, family, accent, appearance, or health don't belong anywhere on an evaluation, even flatteringly.
- **Personality diagnosis.** Interviewers aren't psychologists. "Seemed anxious" is speculation; "paused long and asked to restart twice" is observation. Record observations.
- **Score inflation by default.** If the scale's midpoint isn't genuinely usable, the scale is decoration.

## Behavioral language: the core skill

The single habit that separates strong evaluations from weak ones is describing behavior rather than character:

- Not "great leader" → "described setting weekly priorities for a team of 5 and gave a specific example of removing a blocker"
- Not "poor communicator" → "answers stayed general after two probes for a concrete example"

Behavioral language is comparable, teachable, and defensible. Character judgments are none of the three.

## One form, every candidate

The form only produces comparable data if every candidate for the role is evaluated on the same one. Interviewers customizing forms per candidate — adding criteria, skipping sections — quietly destroys the comparison that justifies the whole exercise.
`,
  },
  {
    slug: "interview-scoring-rubric",
    category: "Structured Interviews",
    title: "Interview Scoring Rubrics: Turning Answers Into Comparable Data",
    excerpt:
      "The rubric is where subjectivity goes to die. How to write scoring anchors that make two interviewers score the same answer the same way.",
    readTime: "6 min read",
    body: `
## The problem a rubric solves

Two interviewers hear the same answer. One scores it 4, the other 2. Neither is wrong — they're using different internal scales. Multiply by every question and every panel, and interview scores become noise wearing the costume of data.

A scoring rubric replaces internal scales with a shared, written one.

## What a good anchor looks like

An anchor describes an observable answer, not a quality. For the question *"Tell me about a time you had to deliver bad news to a stakeholder"*:

- **1:** Cannot produce a specific example, or example shows avoidance (delayed, delegated, or softened the message into meaninglessness).
- **3:** Specific example; delivered the news directly; can describe the stakeholder's reaction and their own follow-up.
- **5:** All of 3, plus: prepared the stakeholder in advance or brought options, and can articulate what they'd do differently — evidence of a deliberate approach, not a survived incident.

Notice: nothing about "good communication skills." Only what the answer *contains*.

## Writing rules

1. **Write anchors before interviewing anyone.** Anchors written after hearing answers get fitted to candidates you've already decided about.
2. **Anchor 1, 3, and 5. Leave 2 and 4 as between-states.** Full five-point anchoring adds work without adding reliability.
3. **Use content criteria, not delivery criteria.** "Confident tone" scores charisma. "Named the tradeoff explicitly" scores substance.
4. **Test on real answers.** Have two people score the same recorded or transcribed answers. Disagreement of more than a point means the anchor is ambiguous — rewrite it.

## The consistency dividend

Rubric-scored interviews are the raw material of every downstream improvement: calibration across interviewers, comparison across candidates, validation against on-the-job performance, and audit-ready fairness evidence. Without a rubric, each of those is impossible; with one, they're queries.
`,
  },
];
