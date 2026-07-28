import type { Article } from "./types";

export const evidenceArticles2: Article[] = [
  {
    slug: "interview-validity-research",
    category: "Evidence-Based Hiring",
    title: "What 100 Years of Interview Validity Research Actually Says",
    excerpt:
      "A century of selection research has a clear verdict on interviews — and it isn't the one most hiring teams operate on. Here's what the evidence supports.",
    readTime: "7 min read",
    body: `
## The question the research answers

For a hundred years, industrial-organizational psychologists have asked one question with unusual persistence: *which hiring methods actually predict who will perform on the job?* The answer is not a matter of opinion. It sits in decades of meta-analyses that pool thousands of studies across millions of hires.

The most cited synthesis, Schmidt and Hunter's review of selection methods, produced a ranking that still holds up. The headline finding is uncomfortable for anyone who trusts their gut: the interview as most companies run it — unstructured, conversational, improvised — is one of the weaker predictors available.

## Structured beats unstructured, decisively

The single most important distinction in the literature is not interview versus test. It is **structured versus unstructured interviews**.

- An unstructured interview is a conversation. Questions vary by candidate, scoring is impressionistic, and rapport does most of the work.
- A structured interview asks the same questions in the same order, scored against a defined rubric, for every candidate.

Across the research, structured interviews predict job performance roughly twice as well as unstructured ones. The structure is not bureaucratic overhead. It is the mechanism that turns a conversation into a measurement.

## Why unstructured interviews fail

Unstructured interviews feel informative. That feeling is the problem. Research on the "interview illusion" shows that interviewers reliably overestimate how much they learned from a free-flowing chat.

- **Confirmation seeking.** Once a first impression forms, questions drift toward confirming it.
- **Noise, not signal.** When every candidate gets different questions, there is nothing to compare. Two interviewers can walk out with opposite conclusions about the same person.
- **Rapport masquerading as fit.** Warmth and similarity get scored as competence.

## What the strongest methods share

The high-validity methods in the research — structured interviews, work-sample tests, cognitive assessments — share three properties:

1. **Standardization.** Every candidate faces the same task under the same conditions.
2. **Observation over assertion.** They measure what a candidate does, not what they claim.
3. **Explicit scoring.** Judgments are recorded against a rubric, not stored as a vibe.

Combine a structured interview with a work sample and the predictive power climbs further than either alone.

## What the research does not say

The evidence does not say interviews are useless. It says *unstructured* interviews are weak. It also does not endorse hiring by algorithm alone. The most defensible processes use structure to discipline human judgment, not to replace it.

- Structure raises validity without removing the interviewer.
- Adding a second high-validity method beats polishing a single weak one.
- Coverage matters: measuring one narrow skill perfectly still misses the rest of the job.

## Turning the evidence into practice

The research has been stable for decades. The gap is adoption. Most teams still run the exact format the data warns against, because it is fast to set up and feels natural.

Closing that gap does not require a lab. It requires three commitments: fixed questions tied to the competencies the role demands, a rubric every interviewer scores against, and a debrief that reviews recorded evidence rather than reconstructed impressions. This is the core of what a platform like L3XY automates — consistent structured interviews that produce verified, comparable signals.

## The bottom line

A century of research points the same direction: **structure is the difference between an interview that predicts performance and one that predicts how much you liked the candidate.** Teams that adopt the evidence do not need a stronger opinion about candidates. They need a stronger process, and the process does the predicting.
`,
  },
  {
    slug: "predictive-hiring",
    category: "Evidence-Based Hiring",
    title: "Predictive Hiring: Choosing Selection Methods by Predictive Power",
    excerpt:
      "Every hiring step costs time and attention. The question that should decide which steps you keep is simple: how much does each one actually predict performance?",
    readTime: "7 min read",
    body: `
## The metric that should run your process

Most hiring processes are assembled by accretion. A step gets added after a bad hire, another because a competitor does it, a third because someone senior likes it. Rarely does anyone ask the only question that matters: **how much does this step improve our ability to predict who will succeed?**

Predictive hiring reframes the process as a portfolio of measurements, each with a known payoff. You keep the steps that add predictive power and cut the ones that only add delay.

## Predictive validity, briefly

Predictive validity is how strongly a method's results correlate with later job performance. It runs from zero (a coin flip) to one (perfect prediction). No real method reaches one, but the differences between methods are large and well documented.

From the selection research, a rough ordering emerges:

- **Higher predictive power:** work-sample tests, structured interviews, cognitive ability measures, job-knowledge tests.
- **Moderate:** integrity assessments, structured reference checks.
- **Low:** unstructured interviews, years of experience, education level, interests.

The exact numbers vary by study and role. The ranking is remarkably stable.

## Two methods beat one, if they are different

A single method — even a strong one — measures a slice of the job. The gain comes from **combining methods that measure different things.**

1. A structured interview probes reasoning, communication, and judgment.
2. A work sample shows execution on a realistic task.
3. Together they cover more of the role than either alone, and their errors are less correlated.

Stacking two weak, redundant steps adds cost without adding signal. Stacking two strong, complementary steps compounds.

## The cost of low-validity steps

Weak steps are not free. They carry three hidden costs:

- **Opportunity cost.** Time spent screening resumes is time not spent interviewing.
- **False confidence.** A low-validity step still produces a confident-looking output, which crowds out better evidence in the debrief.
- **Candidate attrition.** Every extra low-value step lengthens the process and loses strong candidates to faster competitors.

A step that predicts nothing but takes a week is worse than no step at all.

## Designing a predictive process

Build the process backwards from performance:

1. **Define what "good performance" means** for the role in observable terms.
2. **Pick two or three high-validity methods** that together cover the main competencies.
3. **Order them by cost.** Cheap, high-signal filters first; expensive deep assessments last.
4. **Score everything against a rubric** so results are comparable across candidates.
5. **Review predictive power over time** by tracking how early scores relate to later performance.

## Where structure multiplies power

The reason structured interviews rank so high is that structure converts a naturally low-validity format into a high-validity one. The content did not change; the discipline did. This is why automated structured interviewing is such a leverage point — it delivers the consistency that raises validity, at a scale humans struggle to sustain. L3XY exists to make that consistency the default rather than the exception.

## The bottom line

Predictive hiring is not more steps. It is **fewer, stronger, complementary measurements**, ordered by cost and scored consistently. Choose methods by what they predict, not by habit, and the process starts doing the work your intuition was never equipped to do.
`,
  },
  {
    slug: "evidence-based-hiring-framework",
    category: "Evidence-Based Hiring",
    title: "The L3XY Evidence-Based Hiring Framework: Principles and Stages",
    excerpt:
      "Evidence-based hiring is easy to endorse and hard to operationalize. This is the framework that turns the principle into a repeatable process.",
    readTime: "8 min read",
    body: `
## From slogan to system

Almost every hiring team says it wants to hire on evidence. Far fewer can describe what that means at each stage of their process. Evidence-based hiring becomes real only when it is a system — a set of principles applied consistently from job definition to decision.

This framework lays out both the principles that anchor the approach and the stages that put them to work.

## The four principles

**1. Measure capability, not proxies.** A proxy is anything that stands in for capability without demonstrating it: a school, a title, a years-of-experience count. Proxies are cheap and weakly predictive. The framework replaces them with direct measurement wherever possible.

**2. Standardize before you judge.** Judgment is fine. Inconsistent judgment is not. Every candidate should face the same questions and tasks, scored against the same rubric, so that differences in outcome reflect differences in candidates, not in interviewers.

**3. Observe, then record.** Evidence that lives only in memory decays and distorts. The framework insists on recorded observations — scores, notes, artifacts — captured at the moment, not reconstructed in a debrief.

**4. Defend every decision.** A decision is only as good as your ability to explain it. If you cannot point to the evidence behind a yes or a no, you have an opinion, not a decision.

## The stages

### Stage 1: Define the role in observable terms

Before any candidate is screened, translate the role into competencies that can be observed and scored.

- What problems will this person solve in their first ninety days?
- What does strong performance look like, in behavior, not adjectives?
- Which two or three competencies actually separate good from great?

Vague requirements produce vague evaluations. This stage is where most processes silently fail.

### Stage 2: Screen on signal, not documents

Replace resume-first screening with a short, standardized signal check. A brief structured screen produces more comparable information than any keyword scan, and it does not reward resume optimization.

### Stage 3: Assess with structured, scored methods

The core of the process is one or two high-validity assessments:

1. A **structured interview** covering the defined competencies, same questions for every candidate.
2. A **work sample** that mirrors real tasks, where the role allows it.

Both are scored against a rubric during or immediately after, never from memory days later.

### Stage 4: Decide from the evidence

The decision stage reviews recorded scores and artifacts, not vibes. A structured debrief asks: what did each candidate demonstrate, against which competency, and how strong was the evidence?

- Compare candidates on the same axes.
- Weight competencies by their importance to the role.
- Record the rationale for the final call.

### Stage 5: Close the loop

The final stage is the one most teams skip. Track how the people you hired actually perform, and compare it to what your process predicted.

- Which competencies predicted success? Which added noise?
- Where did strong performers score low, or weak performers score high?
- Feed those findings back into Stage 1.

## Why the loop matters most

Without the feedback loop, an evidence-based process is just a well-organized guess. The loop is what makes it *improve*. Over time, you learn which signals matter for your roles and your context, and the framework tightens.

## Where automation fits

Consistency at every stage is demanding to sustain by hand. Standardized questions drift, scoring slips, and debriefs revert to impressions under time pressure. Automating the structured interview and its scoring is how teams hold the line. L3XY is built to run this framework end to end — consistent interviews, verified signals, and a decision trail you can defend.

## The bottom line

Evidence-based hiring is not a philosophy you adopt. It is a **framework you run**: define in observable terms, screen on signal, assess with structure, decide from evidence, and close the loop. Do all five, consistently, and the quality of your hires stops depending on the quality of your instincts.
`,
  },
  {
    slug: "work-samples-in-hiring",
    category: "Evidence-Based Hiring",
    title: "Work Samples: The Most Underused High-Validity Signal",
    excerpt:
      "Work samples sit near the top of every selection-validity ranking, yet most teams still skip them. Here's how to use them without overburdening candidates.",
    readTime: "7 min read",
    body: `
## The signal hiding in plain sight

In study after study, work-sample tests rank among the strongest predictors of job performance available. The logic is almost too simple to argue with: the best way to find out whether someone can do the job is to watch them do a piece of it.

And yet work samples remain underused. Teams default to interviews and resumes, methods that are faster to run but weaker at predicting. The gap between what the evidence recommends and what teams actually do is wide, and it is costing good hires.

## What a work sample is — and isn't

A work sample is a task that faithfully represents the real work, performed under observation and scored against a rubric.

- A **good** work sample: a realistic slice of the job, scoped to an hour or two, evaluated on the same criteria for every candidate.
- A **bad** work sample: an unpaid multi-day project, a puzzle unrelated to the role, or a take-home so large it filters on free time rather than skill.

The difference between the two is why work samples get a bad reputation they do not deserve. The method is sound. The abuse of it is the problem.

## Why work samples predict so well

Three properties put work samples near the top of the validity rankings:

1. **Direct measurement.** There is no proxy between the candidate and the skill. They either produce the work or they do not.
2. **Job relevance.** A sample drawn from real tasks measures exactly what the role requires, with no transfer gap.
3. **Resistance to gaming.** You cannot keyword-optimize your way through demonstrating a capability you lack.

## Designing samples that respect candidates

The main objection to work samples is candidate burden. That objection is answerable with design discipline.

- **Time-box hard.** Ninety minutes, not a weekend. If it takes longer, you are testing endurance, not skill.
- **Use realistic, not exhaustive, scope.** One representative problem beats a full project.
- **Pay for substantial work.** If a sample is large enough to deliver real value, compensate for it.
- **Standardize the prompt.** Every candidate gets the same task and the same evaluation criteria.

## Scoring what you see

A work sample is only a measurement if it is scored consistently. Define the rubric before the first candidate submits:

- What does a strong solution demonstrate? A weak one?
- Which dimensions matter — correctness, reasoning, communication, judgment?
- How will two reviewers arrive at the same score?

Without a rubric, a work sample degrades into another impressionistic judgment, and the validity advantage evaporates.

## Combining samples with structure

Work samples are strongest paired with a structured interview. The sample shows execution; the interview probes the reasoning behind it.

- Have candidates walk through their solution and defend their choices.
- Ask what they would change with more time, or under different constraints.
- Score both artifacts on the same competency framework.

This pairing is one of the highest-validity combinations in the entire selection literature — and it is exactly the kind of realistic, scored assessment platforms like L3XY are designed to deliver at scale.

## The bottom line

Work samples are underused not because they fail, but because they take slightly more design effort than an interview. That effort buys one of the strongest predictive signals in hiring. **Show candidates the work, watch them do it, and score what you see** — the evidence has been pointing here all along.
`,
  },
  {
    slug: "years-of-experience-vs-performance",
    category: "Evidence-Based Hiring",
    title: "Do Years of Experience Predict Performance? What the Data Says",
    excerpt:
      "Experience requirements are the default filter in almost every job posting. The research on whether they predict performance is far less flattering than the practice assumes.",
    readTime: "6 min read",
    body: `
## The most common requirement in hiring

Open any job posting and the first hard filter is almost always a number of years. Three years for this, seven for that, ten for the senior role. It is the most universal screening criterion in hiring, and one of the least examined.

The assumption behind it is intuitive: more time in a role means more skill in the role. The data says that assumption holds early and then collapses.

## What the research actually finds

Studies of the relationship between job experience and job performance consistently reach the same conclusion: the correlation is real but weak, and it fades fast.

- In the **first year or two**, experience matters. Someone with genuine exposure outperforms a novice.
- Beyond a handful of years, the relationship **flattens dramatically.** The difference between five and fifteen years of experience predicts very little about who performs better today.

Meta-analytic reviews put the correlation between experience and performance well below that of structured interviews or work samples. Experience is not nothing, but as a predictor it is far weaker than the weight hiring gives it.

## Why experience misleads

Three mechanisms explain the gap between how much experience feels like it should matter and how little it does.

1. **Repetition is not growth.** Ten years can be one year of learning repeated ten times. Time served does not distinguish the two.
2. **Context does not transfer.** Experience is often specific to a company's tools, culture, and problems. Years elsewhere may build habits that are wrong in the new role.
3. **Plateaus are real.** Most skills reach diminishing returns. After the plateau, additional years add tenure, not capability.

## The cost of experience filters

Hard experience requirements do more than fail to predict — they actively distort the pipeline.

- They **exclude fast learners** with fewer years who would outperform the requirement.
- They **admit coasters** with many years and little growth.
- They **narrow diversity**, filtering out career changers, returners, and non-traditional paths that experience counts cannot capture.

A requirement that predicts weakly and excludes broadly is a bad filter by any standard.

## Using experience correctly

The fix is not to ignore experience. It is to demote it from a hard filter to a soft prior.

- Treat years as **context**, a reason to expect capability, not proof of it.
- Replace the hard cutoff with a **capability measurement**: a structured interview or work sample that tests what the candidate can do now.
- Let the measurement, not the math, drive the decision.

A candidate with six years who demonstrates strong capability should beat one with twelve who does not. An evidence-based process lets that happen; an experience filter prevents it.

## Measuring capability instead

Capability can be observed directly and quickly, where experience can only be counted and assumed. A structured, scored interview reveals in under an hour what a decade of job titles cannot confirm. This is the shift evidence-based hiring makes, and it is what tools like L3XY operationalize: measure the skill, do not infer it from tenure.

## The bottom line

Years of experience predict performance early and then stop. Used as a hard filter, the number excludes strong candidates and admits weak ones. **Treat experience as context, measure capability directly, and decide on what you can observe** — not on how long someone has been around.
`,
  },
  {
    slug: "degree-requirements-rethink",
    category: "Evidence-Based Hiring",
    title: "Rethinking Degree Requirements: Credentials vs Capability",
    excerpt:
      "Degree requirements filter enormous numbers of candidates for a signal the research shows is surprisingly weak. Here's how to rethink them without lowering the bar.",
    readTime: "7 min read",
    body: `
## The credential filter

For decades, the bachelor's degree served as a default gatekeeper — a quick way to shrink an applicant pool and signal a baseline of capability. The requirement spread far beyond the roles that genuinely need specific academic training, becoming a reflex rather than a decision.

The reflex is now under scrutiny, and for good reason. The research on degrees as a predictor of job performance is far weaker than the filter's ubiquity would suggest.

## What degrees do and do not measure

A degree reliably signals a few things: the ability to complete a multi-year program, exposure to a body of knowledge, and, for technical fields, some foundational skills.

What it does not reliably signal is job performance in most roles. Education level, on its own, sits low in the selection-validity rankings — well below structured interviews and work samples. For many jobs, the connection between the credential and daily performance is loose at best.

## The proxy problem

Using a degree as a filter is using a proxy, and proxies carry costs beyond weak prediction.

- **Access, not ability.** Degree attainment tracks family income, geography, and opportunity as much as capability. Filtering on it filters on background.
- **Excluded talent.** Self-taught practitioners, bootcamp graduates, career changers, and skilled workers without degrees get screened out before anyone measures what they can do.
- **False assurance.** A degree ten years old says little about current capability in a fast-moving field.

The result is a filter that narrows the pool along lines unrelated to performance while feeling rigorous.

## Skills-based hiring, done right

The alternative is not to drop standards. It is to raise them by measuring the thing the degree was standing in for.

1. **Identify the actual capabilities** the role requires. Not "computer science degree" but "can design and debug a data pipeline."
2. **Assess those capabilities directly** with structured interviews and work samples.
3. **Keep degree requirements only where genuinely necessary** — licensure, regulated professions, roles requiring specific accredited training.

This is the core of skills-based hiring: replace the credential proxy with a capability measurement.

## What changes when you drop the filter

Teams that have removed unnecessary degree requirements report a consistent pattern: the applicant pool widens, and the quality bar holds — because the bar moved from the credential to the demonstration.

- Stronger candidates surface who would have been filtered out on paper.
- Decisions become more defensible, grounded in demonstrated skill rather than assumed capability.
- The pipeline diversifies without any deliberate lowering of standards.

## Guarding against a lower bar

The legitimate fear behind degree requirements is dilution. The answer is rigorous measurement, not credential gates. When every candidate faces a structured, scored assessment of the actual competencies, the standard is higher, not lower — because it is tested rather than assumed. Platforms like L3XY make that measurement consistent enough to trust in place of the old proxy.

## The bottom line

Degrees measure the completion of a program, not performance in a role. As a filter, they exclude capable people for reasons unrelated to the job. **Keep degree requirements where they are genuinely required, and everywhere else, measure the capability directly.** The bar does not drop; it moves to where it can actually be tested.
`,
  },
  {
    slug: "reference-checks-evidence",
    category: "Evidence-Based Hiring",
    title: "Reference Checks: How to Make a Weak Signal Useful",
    excerpt:
      "Reference checks are nearly universal and nearly worthless as usually run. With structure, they can add real signal. Here's how to fix them.",
    readTime: "6 min read",
    body: `
## A ritual more than a measurement

Reference checks are one of the last steps in almost every hiring process, and one of the least rigorous. A recruiter calls a contact the candidate chose, asks a few open questions, hears predictably positive answers, and checks a box. As a measurement, this is close to worthless.

The selection research bears this out: unstructured reference checks rank low as predictors of performance. But the method is not beyond saving. Like interviews, references improve dramatically when you add structure.

## Why the default fails

The standard reference check has three built-in flaws.

- **Selection bias.** The candidate picks the references. Nobody offers a contact who will criticize them.
- **Positivity pressure.** References fear liability and want to help. The result is bland praise that discriminates between no one.
- **Unstructured questions.** "How were they to work with?" invites a generic answer that cannot be compared across candidates.

Run this way, a reference check confirms what everyone already assumed and distinguishes nobody.

## Making references structured

The same principle that rescues interviews rescues references: standardize the questions and score the answers.

1. **Ask the same questions for every candidate.** Consistency is what makes answers comparable.
2. **Ask behavioral, specific questions.** Not "were they good?" but "describe a time they had to handle a difficult deadline — what did they actually do?"
3. **Probe for gaps.** "What would this person need support with in a new role?" surfaces more than open praise ever will.
4. **Score against a rubric.** Convert the answers into ratings on the same competencies you assessed elsewhere.

## Getting past positivity

Structured questions naturally reduce the positivity problem, but a few techniques help further.

- **Ask for comparisons.** "Compared to others you've managed in this role, where did they rank?" forces differentiation.
- **Request examples, not adjectives.** Specific stories are harder to inflate than generic praise.
- **Listen for absence.** A reference who cannot produce a single concrete strength is telling you something.

## Where references fit in the evidence stack

Even structured, references are a supporting signal, not a primary one. They corroborate; they should not decide.

- Use references to **confirm or challenge** what your structured interview and work sample already showed.
- Weight them below direct capability measurements.
- Treat a reference that contradicts strong direct evidence as a prompt to investigate, not an automatic veto.

## The role of direct evidence

The reason references are demoted in an evidence-based process is that better signals exist. A structured interview and a work sample measure capability directly, under your control, scored consistently. References measure someone else's recollection, filtered through their incentives. When the direct evidence is strong — the kind L3XY produces through verified structured interviews — references become a useful check rather than a load-bearing decision.

## The bottom line

Reference checks are weak by default and useful with structure. **Ask the same behavioral questions of every reference, probe for gaps, and score the answers** — then use them to corroborate direct evidence, never to replace it. A weak signal, disciplined, is worth having. A weak signal, unexamined, is just a ritual.
`,
  },
  {
    slug: "gut-feel-vs-data",
    category: "Evidence-Based Hiring",
    title: "Gut Feel vs Data: Why Intuition Fails in Hiring and Where It Still Helps",
    excerpt:
      "Experienced hiring managers trust their instincts, and the research is blunt about how often those instincts are wrong. But intuition is not worthless — it just needs a job description.",
    readTime: "7 min read",
    body: `
## The most trusted tool is the least reliable

Ask an experienced hiring manager how they make decisions and many will say some version of "I know it when I see it." Years of interviews have built a confident instinct for talent. That confidence is one of the most consistently misplaced feelings in all of hiring.

The research on clinical versus statistical prediction — decades of it, across many fields — reaches a stark conclusion: structured, data-driven judgment beats expert intuition more often than not, and rarely loses to it. Hiring is no exception.

## Why intuition fails

Gut feel in hiring is not a mystical talent. It is a set of fast mental shortcuts, and each one has a well-documented failure mode.

- **First-impression anchoring.** Judgments form in the first minutes and then bias everything that follows.
- **Similarity bias.** Interviewers rate candidates who resemble them — in background, style, or interests — more favorably.
- **The halo effect.** One strong trait, like confidence or polish, inflates ratings on unrelated dimensions.
- **Narrative seduction.** A compelling story feels like evidence. It is not.

None of these are fixable by trying harder. They operate below awareness, which is exactly why they are so persistent.

## The illusion of interview skill

The most dangerous belief is that experience makes intuition reliable. It mostly makes it *confident*. Without feedback linking early judgments to actual performance, an interviewer cannot calibrate. They remember the hires who worked out and forget the strong candidates they rejected, because those never generate data.

This is why "I've been doing this for twenty years" is not the reassurance it sounds like. Twenty years of unmeasured guessing does not produce accuracy. It produces conviction.

## Where intuition still earns its place

Data-driven hiring does not mean removing human judgment. It means giving intuition a defined, defensible role.

1. **Generating hypotheses.** A skilled interviewer's hunch about a candidate's weakness is a great thing to *test* with a structured question — not to act on directly.
2. **Reading ambiguity.** When two candidates score identically on the evidence, informed judgment can break the tie.
3. **Sensing what the rubric missed.** Intuition can flag something worth investigating, which the process then examines with structure.

The principle: **intuition proposes, evidence disposes.** Instincts belong at the start of inquiry, not the end of a decision.

## Building a process that uses both

An evidence-based process channels intuition rather than banning it.

- Score the structured evidence **first**, before the group discusses impressions, so gut feel does not contaminate the record.
- Let interviewers voice hunches **as questions to test**, not as verdicts.
- Reserve human judgment for the genuine edge cases the data leaves open.

## The technology angle

Structure is what disciplines intuition without discarding it. When interviews are standardized and scored consistently — as they are in an automated structured interview platform like L3XY — the human contribution shifts to where it is actually reliable: interpreting strong evidence, not manufacturing weak evidence from a conversation.

## The bottom line

Gut feel in hiring is confident, fast, and frequently wrong. The research is clear that structured evidence outpredicts expert intuition. But intuition is not the enemy — **used to generate hypotheses and break genuine ties, it is valuable; used to make the decision, it is a liability.** Let the evidence decide, and give your instincts the job they are actually good at.
`,
  },
  {
    slug: "hiring-decision-frameworks",
    category: "Evidence-Based Hiring",
    title: "Hiring Decision Frameworks: Turning Evidence Into a Defensible Yes/No",
    excerpt:
      "Collecting good evidence is only half the job. The other half is combining it into a decision you can explain, defend, and repeat. Here are the frameworks that do it.",
    readTime: "7 min read",
    body: `
## The gap between evidence and decision

A team can run structured interviews, gather work samples, and score everything against a rubric — and still make the final call in a chaotic debrief where the loudest voice wins. All the discipline of the assessment stage evaporates at the moment of decision.

A hiring decision framework closes that gap. It defines, in advance, how evidence becomes a yes or a no. Without one, evidence is just decoration on a gut decision.

## Why the decision stage fails

The final debrief is where good processes most often collapse.

- **Impression laundering.** Interviewers arrive with conclusions and reverse-engineer justifications from the evidence.
- **Recency and volume.** The last candidate discussed, or the one with the most vocal advocate, gets the edge.
- **Anchoring on a single dimension.** One strong or weak moment dominates a decision that should weigh many.

The fix is structure at the decision stage, the same principle that rescues interviews and references.

## The core frameworks

### 1. The weighted scorecard

Assign each competency a weight reflecting its importance to the role. Score every candidate on each competency from the collected evidence. Combine into a weighted total.

- Forces every dimension to be considered, not just the memorable ones.
- Makes trade-offs explicit: a candidate strong on a low-weight competency does not automatically beat one strong on a high-weight one.
- Produces a comparable number across candidates, defensible on its face.

### 2. The must-have threshold

Some competencies are non-negotiable. Define minimum acceptable scores on those before any weighting happens.

- A candidate below threshold on a critical competency is out, regardless of total.
- Prevents a high average from masking a fatal gap.
- Keeps the bar from drifting under the pressure of a likable candidate.

### 3. Structured consensus

Instead of an open discussion, each interviewer submits scores and rationale independently, before the group talks.

- Prevents the first opinion from anchoring the rest.
- Surfaces genuine disagreement, which is where the useful conversation lives.
- The debrief then focuses on reconciling evidence, not persuading peers.

## Combining the frameworks

The strongest decision process layers all three:

1. Apply **must-have thresholds** to screen out fatal gaps.
2. Collect **independent scores** before any group discussion.
3. Combine into a **weighted scorecard** and discuss only the genuine disagreements and edge cases.

This sequence removes the most common failure modes and leaves human judgment for the decisions that actually need it.

## Defensibility as a design goal

A defensible decision is one you can reconstruct and justify later — to leadership, to a rejected candidate, or to a regulator.

- Every score traces to specific, recorded evidence.
- The weighting and thresholds were set before candidates were seen, not after.
- The rationale for the final call is written down, not just felt.

"We scored them against this rubric, here are the responses, and here is how the weights produced the decision" is defensible. "The team agreed she was the best fit" is not.

## Where the system helps

Decision frameworks depend on consistent, well-recorded evidence flowing into them. When structured interviews and scoring are automated and captured — the way L3XY captures verified signals and a full decision trail — the scorecard fills itself with defensible inputs, and the framework does its job instead of fighting missing data.

## The bottom line

Good evidence poorly combined still produces bad decisions. **Set weights and thresholds in advance, score independently, and combine through an explicit framework** — then write down the rationale. That is how evidence becomes a yes or no you can defend, repeat, and trust.
`,
  },
];
