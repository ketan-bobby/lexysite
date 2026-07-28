import type { Article } from "./types";

export const aiArticles2: Article[] = [
  {
    slug: "ai-interviews-explained",
    category: "AI Hiring",
    title: "AI Interviews Explained: What Actually Happens in One",
    excerpt:
      'The phrase "AI interview" conjures a robot judging your face. The reality is more useful and less dramatic. Here\'s what actually happens, step by step.',
    readTime: "6 min read",
    body: `
## Clearing up the caricature

Say "AI interview" and most people picture a machine scanning a candidate's face for microexpressions and rendering a verdict. That version deserves the suspicion it gets, and responsible systems do not work that way. A well-designed AI interview is not a mind reader. It is a **structured interview that runs consistently, at scale, and produces scored evidence**.

## What happens before the interview

The interview is built the way any good structured interview is built: from the job. A role is broken into the competencies it actually requires, and each competency maps to questions with a scoring rubric written in advance. The AI does not invent standards on the fly. It applies standards a human defined.

## What happens during the interview

The candidate answers a consistent set of questions, usually by voice or text, sometimes with a work-sample task attached. During the conversation the system typically does three things:

- **Asks the planned questions** in a consistent sequence for every candidate
- **Follows up** when an answer is thin, probing for specifics the same way a good interviewer would
- **Transcribes and records** the response so the evidence is reviewable later

The candidate is talking through real problems, not performing for a camera.

## What happens after the interview

This is where the actual scoring lives. The transcript is evaluated against the rubric, competency by competency. The output is not a verdict. It is **structured evidence**: a score per competency, the reasoning behind each score, and the exact response it was drawn from.

Every score traces back to something the candidate said. That is the difference between an evaluation and a black box.

## What a responsible system does not do

- It does not score accents, appearance, or "vibe."
- It does not make the hire/no-hire decision. A human does, using the evidence.
- It does not hide its reasoning. The rubric and the transcript are both reviewable.

## Why teams use it

The appeal is not that AI is smarter than a human interviewer. It is that AI is **consistent** in ways humans struggle to be. Every candidate gets the same questions, the same follow-up rigor, and the same rubric, whether they are candidate three or candidate three hundred. That consistency is exactly what decades of selection research say makes interviews predictive.

## The bottom line

An AI interview is best understood as structured interviewing that finally scales. The technology is not the point. The **consistency and the evidence trail** are. L3XY builds on exactly this model: the same questions, scored the same way, with every score traceable to the candidate's own words.
`,
  },
  {
    slug: "responsible-ai-hiring",
    category: "AI Hiring",
    title: "Responsible AI Hiring: Principles That Survive Scrutiny",
    excerpt:
      "Every vendor claims their AI is responsible. Here are the concrete principles that actually hold up when a regulator, a candidate, or your own legal team asks hard questions.",
    readTime: "7 min read",
    body: `
## Beyond the marketing word

"Responsible AI" has become a checkbox on a slide. The problem is that responsibility is not a claim, it is a set of practices you can be audited against. Here are the principles that survive contact with a skeptical regulator, a rejected candidate, and a cautious general counsel.

## Principle 1: Measure the job, nothing else

An AI hiring tool should evaluate capability relevant to the role and nothing more. If a system scores tone of voice, facial expression, or fluency in a way unrelated to the job, it is measuring the wrong thing and inviting discrimination. The test is simple: **can you draw a straight line from every scored dimension to a requirement of the job?**

## Principle 2: Keep a human accountable

Responsible systems inform decisions; they do not make them. A person reviews the evidence and owns the outcome. This is not just ethical hygiene, it is increasingly the law. Automated decision-making without human oversight is where the legal exposure concentrates.

## Principle 3: Make it explainable

If you cannot explain why a candidate scored the way they did, you cannot defend the score. Every evaluation should trace to observable evidence: the question asked, the answer given, the rubric applied. **A score without a reason is a liability.**

## Principle 4: Test for bias, continuously

Bias testing is not a one-time certification. Adverse impact is measured across demographic groups, monitored over time, and acted on when it appears. The relevant benchmark, the four-fifths rule, has been standard in employment selection for decades. A responsible vendor runs these tests and shows you the results.

## Principle 5: Disclose to candidates

Candidates deserve to know when AI is part of their evaluation, what it measures, and how to request accommodation or human review. Disclosure is required in a growing number of jurisdictions and is simply good practice everywhere.

## Principle 6: Protect the data

Interview data is sensitive personal information. Responsible handling means clear retention limits, restricted access, and a defined deletion path. If a vendor cannot tell you where the data lives and when it is destroyed, that is your answer.

## Turning principles into questions

When evaluating a vendor, ask:

1. What exactly does the model score, and how does each dimension map to the job?
2. Where is the human in the loop, and what do they see?
3. Can you show me the reasoning behind a specific score?
4. What are your adverse-impact results, and how often do you test?
5. What do you tell candidates, and when?
6. What is your data retention and deletion policy?

## The bottom line

Responsible AI hiring is not a philosophy, it is a checklist you can be held to. The systems that survive scrutiny share one trait: **every decision leaves a defensible trail.** That is the standard L3XY is built to meet, and the standard you should demand from anyone.
`,
  },
  {
    slug: "ai-interview-myths",
    category: "AI Hiring",
    title: "Seven Myths About AI Interviews",
    excerpt:
      "The debate about AI interviews is full of confident claims that do not survive examination. Here are seven of the most common, and what the evidence actually says.",
    readTime: "6 min read",
    body: `
## Myth 1: AI interviews judge your face

The most persistent fear is that AI scores facial expressions and body language. Responsible systems do not, because facial analysis has weak scientific grounding and a clear path to discrimination. A well-built AI interview scores **what you say and how you reason**, evaluated against a job-relevant rubric, not how you look while saying it.

## Myth 2: The AI decides who gets hired

AI interviews produce evidence; humans make decisions. In a responsible process the system scores responses and a person reviews that evidence to decide. Full automation of the hire decision is both bad practice and, increasingly, illegal without human oversight.

## Myth 3: AI interviews are less fair than humans

This gets it backwards. The dominant source of unfairness in hiring is **human inconsistency**: different questions, different standards, different moods, unconscious bias. A structured AI interview asks every candidate the same questions and applies the same rubric. Consistency is the foundation of fairness, and consistency is exactly what machines do well.

## Myth 4: You can game an AI interview

You can game a resume by stuffing keywords. You cannot keyword-stuff your way through demonstrating a capability you do not have. When the interview measures actual problem-solving and communication, there is no shortcut around actually being able to do it.

## Myth 5: AI interviews are cold and dehumanizing

The data does not support the assumption. Many candidates report that a structured AI interview feels **fairer** than a rushed human screen, because it is not affected by whether the interviewer is tired, distracted, or predisposed to like them. Everyone gets the same time, the same questions, and the same attention.

## Myth 6: AI interviews only work for technical roles

Structured evaluation applies wherever a role has definable competencies, which is everywhere. Communication, judgment, customer empathy, and problem framing are all measurable through scored responses. The method is not limited to code.

## Myth 7: AI interviews replace human interviewers

They replace the **inconsistent, unstructured screen** that never predicted much anyway. Human judgment stays where it belongs: reviewing evidence, assessing team fit through structured debriefs, and making the final call. The AI handles scale and consistency; humans handle decisions.

## The bottom line

Most myths about AI interviews describe a badly built system, not the category. Judged against the alternative, the unstructured human screen, a well-designed AI interview is **more consistent, more defensible, and often fairer**. The right question is not whether to trust AI, but whether your current process could survive the same scrutiny.
`,
  },
  {
    slug: "ai-bias-in-hiring",
    category: "AI Hiring",
    title: "AI Bias in Hiring: Where It Comes From and How It's Mitigated",
    excerpt:
      "AI does not invent bias out of nothing. It learns it from data and from design choices. Understanding the sources is the first step to controlling them.",
    readTime: "7 min read",
    body: `
## Bias is not magic

AI systems are not mysteriously prejudiced. Bias enters through specific, identifiable channels, and each channel has a corresponding control. The teams that manage bias well are the ones that treat it as an engineering and governance problem, not a moral abstraction.

## Source 1: Biased training data

The most cited source. If a model learns from historical hiring decisions, it learns the biases baked into those decisions. Train on who a company hired in the past and you may reproduce who that company favored in the past.

**The mitigation:** do not train models to imitate historical outcomes. Score against **job-relevant rubrics defined in advance**, not against a pattern of who got hired before. The rubric encodes what the job requires, not what history preferred.

## Source 2: Proxy variables

A model can discriminate without ever seeing a protected characteristic, by using correlated proxies. Zip code stands in for race. School stands in for class. Word choice stands in for first language.

**The mitigation:** restrict scoring to job-relevant dimensions and actively test whether scores correlate with anything they should not. Proxies reveal themselves in the adverse-impact numbers.

## Source 3: The measurement itself

If the system scores something irrelevant to the job, such as accent, speech rate, or appearance, it will systematically disadvantage groups that differ on those irrelevant dimensions.

**The mitigation:** evaluate content and reasoning, not delivery style or appearance. Every scored dimension must map to a genuine job requirement.

## How mitigation is verified

Good intentions do not count; measurement does.

- **Adverse-impact testing.** Compare selection rates across demographic groups using the four-fifths rule, a standard in employment selection for decades.
- **Continuous monitoring.** Bias is tracked over time, not certified once and forgotten.
- **Structured scoring.** Consistent questions and rubrics remove the interviewer-to-interviewer variance where human bias hides.
- **Human oversight.** People review evidence and can catch patterns the metrics miss.

## The comparison that matters

The honest benchmark is not perfection, it is the **status quo**. Unstructured human interviews are among the most bias-prone tools in hiring: inconsistent, unaccountable, and impossible to audit. A structured, tested, monitored AI process is not flawless, but it is measurable and correctable in ways a human panel never is.

## The bottom line

AI bias comes from data, proxies, and measurement choices, and every one of those has a control. The difference between a responsible system and a reckless one is whether those controls exist and are **tested continuously**. L3XY's approach starts from job-relevant rubrics and ongoing adverse-impact testing, because the only defensible claim about bias is one backed by numbers.
`,
  },
  {
    slug: "ai-hiring-compliance",
    category: "AI Hiring",
    title: "AI Hiring Compliance: Audits, Disclosures, and Documentation",
    excerpt:
      "Using AI in hiring creates obligations that most teams discover too late. Here is what compliance actually requires and how to build it in from the start.",
    readTime: "7 min read",
    body: `
## Compliance is now part of the tool

For years, AI hiring tools were adopted like any other software: pick a vendor, plug it in, move on. That era is over. Regulators now treat automated employment decision tools as a distinct category with specific obligations. If you use AI to evaluate candidates, compliance is no longer optional, and it is no longer only legal's problem.

## The three pillars

Most AI hiring regulation reduces to three requirements: **audit, disclose, document.** Get these right and you are ahead of most of the market.

## Pillar 1: Bias audits

A growing number of jurisdictions require formal bias audits of automated hiring tools, often by an independent party, often published. The audit measures whether the tool produces adverse impact across demographic groups.

What this means in practice:

- Know whether your tool has been audited and when.
- Understand the adverse-impact results, not just that an audit happened.
- Confirm the audit is refreshed on the required cadence, typically annually.

## Pillar 2: Candidate disclosure

Candidates increasingly have the right to know when AI evaluates them. Disclosure obligations commonly include:

- **Notice** that an automated tool is being used
- **What it assesses**, in plain language
- **The right to request** an accommodation or alternative process
- Sometimes, **advance notice** before the tool is used

Silent AI evaluation is the fastest route to a complaint.

## Pillar 3: Documentation

If a decision is challenged, documentation is your defense. A compliant process can produce:

1. The **job analysis** linking each scored competency to a role requirement
2. The **rubric** used to score every candidate
3. The **evidence** behind each score, traceable to the candidate's responses
4. The **human review** step showing a person made the decision
5. The **audit results** demonstrating ongoing bias testing

## Why this favors structured AI

Here is the quiet advantage. A structured, evidence-based AI process generates most of this documentation automatically. Every score already traces to a response and a rubric. The human-review step is already built in. Compliance stops being a scramble and becomes a byproduct of how the system already works.

An unstructured human process, by contrast, produces almost none of this. Ask a panel to reconstruct why they rejected a candidate two years ago and you get shrugs, not documentation.

## Building it in

- Choose tools that generate an evidence trail by default.
- Wire disclosure into the candidate flow, not a legal afterthought.
- Keep audit results current and accessible.
- Confirm a human owns every decision, on the record.

## The bottom line

AI hiring compliance is not a burden bolted on after the fact. It is a property of well-designed systems. The tools that make compliance hard are the ones that hide their reasoning; the tools that make it easy, like L3XY, are the ones where **every decision was defensible to begin with.**
`,
  },
  {
    slug: "ai-hiring-laws",
    category: "AI Hiring",
    title: "AI Hiring Laws in 2026: NYC LL144, the EU AI Act, and What's Next",
    excerpt:
      "The legal landscape for AI in hiring has moved fast. Here is a practical map of the rules that matter now and the direction the regulation is heading.",
    readTime: "7 min read",
    body: `
## From frontier to regulated market

A few years ago, using AI to evaluate candidates was a lightly governed frontier. It is not anymore. A patchwork of laws now sets real obligations, and the direction of travel is clear: **more disclosure, more testing, more accountability.** Here is a practical map for talent leaders, not lawyers.

## New York City Local Law 144

The landmark early rule. LL144 governs automated employment decision tools used on candidates in New York City. Its core requirements:

- **An annual independent bias audit** of the tool
- **Publication** of a summary of the audit results
- **Notice to candidates** that an automated tool is being used, with information about what it assesses

LL144 matters beyond New York because it became a template. Its logic, audit plus disclosure, keeps reappearing in new proposals.

## The EU AI Act

The most comprehensive framework. The EU AI Act classifies AI systems by risk, and AI used in recruitment and candidate evaluation is designated **high-risk.** High-risk status brings obligations including:

- **Risk management** and data governance
- **Transparency** to affected individuals
- **Human oversight** of the system
- **Accuracy, robustness, and record-keeping** requirements

If you hire in the EU, or evaluate EU candidates, this applies regardless of where your company sits.

## The broader US picture

Beyond New York City, activity is widespread and uneven:

- **Illinois** regulates AI analysis of video interviews, requiring notice and consent.
- **Colorado** has enacted broad AI legislation addressing algorithmic discrimination in consequential decisions, including employment.
- **The EEOC** has made clear that existing anti-discrimination law applies fully to AI-driven selection. Federal civil rights law did not pause for the technology.

## The through-line

Across every jurisdiction, the same principles recur. If you build to these, you are largely future-proof:

1. **Test for bias** and be able to show the results.
2. **Disclose** to candidates that AI is involved and what it measures.
3. **Keep a human accountable** for the decision.
4. **Document** the basis for every evaluation.
5. **Protect and retain data** responsibly.

## What's next

Expect the map to fill in, not change shape. More states and countries will adopt audit-and-disclose rules. Enforcement will intensify. The bar for "we tested it" will rise from a one-time certificate to continuous monitoring. Nothing on the horizon reverses the direction toward transparency and accountability.

## The bottom line

The specific statutes will keep multiplying, but the compliance strategy does not have to. A structured, tested, documented, human-supervised process satisfies the shared logic of nearly every law on the books and in the pipeline. Build for **defensibility**, as L3XY does, and you are building for whatever comes next.
`,
  },
  {
    slug: "ai-vs-human-interviews",
    category: "AI Hiring",
    title: "AI vs Human Interviews: Consistency, Coverage, and Where Humans Win",
    excerpt:
      "This is not a contest with a single winner. AI and human interviewers are good at different things. The strong process uses each where it is strongest.",
    readTime: "6 min read",
    body: `
## The wrong framing

"AI versus human" implies one has to win. In practice, the two excel at different parts of the hiring problem, and treating it as a competition produces worse decisions than treating it as a division of labor. The useful question is: **what is each actually good at?**

## Where AI wins: consistency

The single biggest weakness of human interviewing is inconsistency. Two interviewers ask different questions, weight answers differently, and are swayed by mood, time pressure, and first impressions. Decades of selection research show this inconsistency is exactly what makes unstructured interviews poor predictors.

AI is consistent by construction. Every candidate gets the same questions, the same follow-up rigor, and the same rubric. Candidate three hundred is evaluated identically to candidate three. That consistency is not a minor convenience, it is the mechanism that makes structured interviews predictive.

## Where AI wins: coverage and scale

A human panel cannot give a full structured interview to five hundred applicants. AI can. This changes the funnel: instead of screening most people out on a weak resume signal, you can give **everyone** a real, scored evaluation. Good candidates the resume filter would have discarded get a fair shot.

## Where AI wins: the evidence trail

Every AI-scored interview leaves a record: the question, the answer, the rubric, the reasoning. Ask a human interviewer to reconstruct why they scored someone a certain way months later and you get an impression. The evidence trail is what makes decisions defensible.

## Where humans win: context and nuance

Humans read situations AI should not be asked to judge. A candidate navigating an unusual career path, a novel answer that is brilliant but off-script, the subtle chemistry of how someone would work with a specific team. These call for human judgment.

## Where humans win: the decision

The hire decision belongs to a person. Weighing evidence against team needs, budget, timing, and tradeoffs is human work. AI supplies the evidence; a human owns the outcome. This is both good practice and, increasingly, legally required.

## Where humans win: relationship

Selling a role, answering a candidate's real questions, and building the human connection that makes someone say yes are not scoring tasks. They are relationship tasks, and they are irreducibly human.

## The strong process

1. **AI handles the structured evaluation** at scale, producing consistent, scored evidence for everyone.
2. **Humans run structured debriefs** on the evidence and handle the judgment calls that need context.
3. **A human makes the final decision** and owns it.

## The bottom line

AI is better at consistency, coverage, and documentation. Humans are better at context, judgment, and relationship. A process that pits them against each other wastes both. A process that uses each where it is strongest, the model L3XY is built around, is stronger than either alone.
`,
  },
  {
    slug: "candidate-experience-ai-interviews",
    category: "AI Hiring",
    title: "Candidate Experience in AI Interviews: What Candidates Actually Report",
    excerpt:
      "The assumption is that candidates hate AI interviews. The reality is more nuanced, and the design choices that determine the experience are within your control.",
    readTime: "6 min read",
    body: `
## The assumption vs the reports

The conventional wisdom is that candidates dread AI interviews as cold and impersonal. But when you look past the assumption to what candidates actually report, a more interesting picture emerges. The experience depends far less on the fact that AI is involved and far more on **how the process is designed.**

## What candidates actually value

Across candidate feedback, the same themes recur, and none of them are unique to AI:

- **Fairness.** Candidates consistently value knowing everyone faced the same questions and the same standard. A structured AI interview delivers exactly this, and many candidates find it fairer than a rushed human screen where the outcome depends on catching the interviewer on a good day.
- **Flexibility.** Asynchronous AI interviews let candidates respond on their own schedule, without taking time off work or coordinating calendars. For working candidates and caregivers, this is a real benefit.
- **A real chance to show capability.** Getting a full structured interview beats being silently filtered out by a resume scan. Candidates who would never have made it past a keyword filter get to actually demonstrate what they can do.
- **Speed.** AI interviews compress the timeline. Candidates hear back faster because evaluation is not stuck in a queue behind a busy panel.

## What candidates dislike

The complaints are also consistent, and they are about design, not technology:

- **No transparency.** Not knowing what is being assessed or why breeds anxiety and distrust.
- **No human anywhere.** A process with zero human contact feels like shouting into a void.
- **Feeling surveilled.** Systems that appear to scan faces or monitor behavior make candidates deeply uncomfortable, and rightly so.
- **No feedback.** Being evaluated and then hearing nothing is worse than not being evaluated at all.

## The design choices that decide it

Candidate experience in an AI interview is not fixed. It is the sum of choices you control:

1. **Disclose clearly.** Tell candidates AI is involved, what it measures, and how to request accommodation. Transparency converts anxiety into trust.
2. **Keep the scope job-relevant.** Evaluate responses and reasoning, never appearance or delivery style. Candidates can feel the difference.
3. **Keep humans visible.** Make clear that a person reviews the evidence and owns the decision.
4. **Respect their time.** Asynchronous, reasonable-length interviews signal respect.
5. **Close the loop.** Communicate outcomes, and offer signal where you can.

## The bottom line

Candidates do not hate AI interviews. They hate opaque, surveillance-flavored, feedback-free processes, whether run by machines or people. Design for transparency, job-relevance, and respect, and the AI interview becomes what candidates report they want: a **fair, flexible, genuine chance to be evaluated on capability.** That is the experience L3XY is built to deliver.
`,
  },
  {
    slug: "ai-hiring-glossary",
    category: "AI Hiring",
    title: "The AI Hiring Glossary: Terms Every Talent Leader Should Know",
    excerpt:
      "The vocabulary of AI hiring is where a lot of confusion and a lot of vendor spin lives. Here are the terms that matter, defined plainly.",
    readTime: "7 min read",
    body: `
## Why the words matter

Vendor decks and regulatory texts are full of terms that sound technical and often go undefined. Misunderstanding them is how teams buy the wrong tool or miss an obligation. This glossary defines the vocabulary that actually matters, in plain language.

## Core concepts

**Structured interview.** An interview where every candidate answers the same predefined questions, scored against a consistent rubric. The opposite of a free-form conversation. Decades of research rank it among the most predictive selection methods.

**Rubric.** The scoring guide that defines what a strong, adequate, and weak answer looks like for each competency, written before the interview. The rubric is what makes scores comparable.

**Competency.** A specific, job-relevant capability being measured, such as problem framing, communication, or technical reasoning. Good evaluation maps every score to a competency the job actually requires.

**Verified signal.** A capability claim that has been demonstrated and checked, not merely stated. The opposite of a resume bullet.

## AI and modeling terms

**Automated employment decision tool (AEDT).** The regulatory term for software that substantially assists or replaces human judgment in hiring. If your tool qualifies, specific laws likely apply.

**Model.** The underlying system that produces scores or text. What matters is not its sophistication but what it is trained to do and what it is allowed to score.

**Training data.** The examples a model learned from. A major source of bias when models are trained to imitate past hiring outcomes, which is why rubric-based scoring is safer than outcome imitation.

**Explainability.** The ability to trace a score back to the evidence and reasoning behind it. A score you cannot explain is a score you cannot defend.

## Fairness and compliance terms

**Adverse impact.** When a selection process produces substantially different pass rates across demographic groups. The core measure of hiring discrimination.

**Four-fifths rule.** The long-standing benchmark: if a group's selection rate is below 80 percent of the highest group's rate, that is a flag for adverse impact worth investigating.

**Bias audit.** A formal, often independent, evaluation of whether a tool produces adverse impact. Required by law in a growing number of jurisdictions.

**Human in the loop.** A design where a person reviews the evidence and makes or confirms the decision, rather than the system deciding autonomously. Increasingly a legal requirement.

**Disclosure.** Telling candidates that AI is involved, what it assesses, and their rights. Required in many jurisdictions and good practice everywhere.

## Process terms

**Calibration.** The practice of aligning scorers, human or machine, so the same answer earns the same score regardless of who evaluates it.

**Work sample.** A task that mirrors the actual job, giving direct evidence of capability rather than a description of it.

**Quality of hire.** The downstream measure of whether hiring decisions produced people who perform. The metric everyone wants and few track well.

**Time to evidence.** How quickly a process produces defensible, scored information about a candidate. Structured AI interviews compress this dramatically.

## The bottom line

The terms above are the ones that separate a real evaluation of an AI hiring tool from a sales pitch. When a vendor uses them, ask them to be specific: what does the model score, what is the rubric, where is the human, what are the audit results. Clear language is the first sign of a defensible system, and defensibility is the whole point. It is the standard L3XY is built to.
`,
  },
];
