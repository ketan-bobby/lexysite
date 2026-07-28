# Lexy — AI System Card

**Version:** 1.0
**Last updated:** 16 May 2026
**Owner:** founder / eng-lead
**Status:** Draft — pending external review

This document is Lexy's lightweight AI System Card. It maps to the
information required by the EU AI Act for a high-risk AI system
(Annex IV, "Technical documentation") and serves as the public-facing
explanation of how Lexy uses AI to evaluate candidates.

It deliberately covers the same ground as a model card, but at the
**system** level — i.e., the composite of Lexy's prompts, model choices,
and post-processing, not the underlying LLM weights (which Lexy does not
train).

## 1. Intended purpose

Lexy assists employers ("deployers" in EU AI Act terms) in the recruiting
process. The AI components:

* **Resume parsing** — extract structured fields from uploaded resumes.
* **Job-fit summarisation** — write a recruiter-facing summary comparing a
  candidate's resume to the job description.
* **Interview generation** — generate role-specific interview questions
  from the JD + candidate background.
* **Interview conduct** — conduct a structured screening interview with
  the candidate, recording the conversation.
* **Interview scoring** — produce a structured assessment of the
  recorded interview against pre-defined competencies.

Lexy is **not** the decision-maker: every hire/reject decision is made by
a named human recruiter or hiring manager in the customer's
organisation. Lexy's outputs are inputs to a human-in-the-loop workflow.

This classifies Lexy as a high-risk AI system under EU AI Act
Annex III §4 ("AI systems intended to be used for the recruitment or
selection of natural persons").

## 2. Provider and deployer

* **Provider** (EU AI Act Article 3(3)): Lexy Inc. (Delaware, USA).
* **Deployer** (Article 3(4)): each Customer using Lexy to fill its own
  open roles. Deployers have separate obligations under Article 26.

## 3. Model inventory

| Function | Provider | Model | Version pinning | Training-data opt-out |
|---|---|---|---|---|
| Resume parsing | OpenAI | gpt-4o-mini | Pinned by API parameter | Zero-retention API contract |
| JD/fit summary | Anthropic | claude-3-5-sonnet | Pinned by API parameter | Zero-retention contract |
| Interview generation | OpenAI | gpt-4o | Pinned by API parameter | Zero-retention API contract |
| Interview conduct (voice + reasoning) | OpenAI | gpt-4o-realtime | Pinned by API parameter | Zero-retention API contract |
| Interview scoring | Anthropic | claude-3-5-sonnet | Pinned by API parameter | Zero-retention contract |

Lexy does **not** fine-tune or train on Customer Data. All inference
calls are made with the provider's zero-retention setting where
available.

## 4. Inputs and outputs

| Stage | Inputs | Outputs |
|---|---|---|
| Resume parsing | Resume text/PDF | Structured fields (name, contact, skills, work history) |
| Fit summary | Resume fields, JD text | Free-text summary + 0-100 fit score |
| Interview generation | JD, interview-plan template, resume highlights | Ordered list of 3-12 questions |
| Interview conduct | Live candidate audio + previous turns | Spoken follow-ups, transcript |
| Scoring | Transcript, JD, scoring rubric | Per-competency score + free-text rationale |

The score and rationale outputs are surfaced to the recruiter alongside a
prominent "AI-generated — review carefully" affordance.

## 5. Evaluated characteristics

Lexy evaluates candidates **only** on:

* Role-relevant skills, knowledge, and experience as expressed in the
  resume and during the interview.
* Communication clarity, structured thinking, and demonstrated reasoning
  in the candidate's own answers.

Lexy does **not** evaluate, infer, or use:

* Race, ethnicity, national origin (beyond work authorisation, which the
  candidate self-reports).
* Age, religion, sexual orientation.
* Disability or family / marital status.
* Gender identity.
* Pitch, accent, or speech characteristics as a proxy for ability.
* Facial expressions, micro-expressions, or any video-based personality
  inference.

The interview system prompt explicitly forbids the AI from asking
questions about any of these topics (see
`artifacts/api-server/src/routes/interviews.ts`).

## 6. Known limitations and risks

* **LLM hallucination.** Outputs can be plausible but incorrect; the
  human-in-the-loop is the mitigation.
* **Score sensitivity to phrasing.** Two paraphrasings of the same answer
  may receive different scores. Mitigation: scoring is paired with
  free-text rationale so reviewers can sanity-check.
* **Language bias.** The underlying models are stronger in English than
  in other languages. Lexy supports multiple languages but accuracy in
  English is highest. Customers operating outside English should review
  outputs more carefully.
* **Disparate-impact risk.** AI hiring tools have historically shown bias
  against protected groups. Lexy mitigates by (a) decoupling
  demographics from the recruiter view, (b) forbidding the AI from
  evaluating demographic traits, and (c) providing an aggregate
  diversity dashboard with k-anonymity ≥ 5 so customers can detect
  imbalance. Customers using Lexy in NYC must additionally run an
  independent bias audit per Local Law 144; Lexy captures the
  underlying decision-log data today (`ai_decision_log` table) and
  provides an auditor-formatted CSV on request — a self-serve
  `/analytics/aedt-export` endpoint is a near-term follow-up.

## 7. Human oversight design

* Every AI score is displayed alongside a "Why this score?" rationale.
* No AI-only auto-reject: rejection requires a named recruiter to click
  "Reject" with a reason.
* Recruiters can override or hide any AI output without affecting the
  underlying candidate record.
* The audit log records every AI recommendation and every human
  decision so the chain of responsibility is reconstructible.

## 8. Post-market monitoring plan

* Weekly: review the rate of AI-recommended rejections by demographic
  bucket (where the customer has the aggregated demographics dashboard
  enabled). Flag any bucket below 0.8× the highest bucket as candidate
  for investigation (4/5ths rule).
* Monthly: sample 20 transcripts × score pairs and have a human reviewer
  rate inter-rater agreement with the AI.
* Quarterly: re-run the bias audit on a fresh sample for any customer
  hiring into NYC.
* On regulator request: the `ai_decision_log` table provides
  auditor-reproducible records per Local Law 144 (CSV export of the
  joined decision-log + demographics view with k-anonymity ≥ 5 is a
  near-term follow-up — the underlying data is captured today).

## 9. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-05-16 | Initial draft |
