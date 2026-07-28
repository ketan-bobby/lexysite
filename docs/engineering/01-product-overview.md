# Lexy — Product Overview & North Star

> Engineering documentation set · Doc 1 of 9
> Audience: anyone joining the project — engineers, PMs, founders. Read this first.

## 1. What Lexy is

**Lexy is a multi-tenant, AI-native hiring platform.** It runs the entire hiring
workflow end to end — sourcing → screening → verification → outreach →
interviewing → scheduling → analytics — and threads a single **Intelligence
Engine** through all of it that scores every candidate against every job and tells
the recruiter what to do next.

The product is not "an ATS with some AI features bolted on." The AI scoring layer
(`candidate_job_intelligence`) is the spine. The workflow tools exist to feed it
signals and to act on its recommendations.

## 2. The North Star

> **Get the right candidate in front of the right recruiter for the right job,
> with a defensible reason, faster than a human team could — and get more accurate
> the more it is used.**

Three words in that sentence carry the whole strategy:

- **Defensible** — every recommendation is explainable, fairness-checked, and
  audit-logged. This is what lets the product be sold into regulated/enterprise
  hiring where "the algorithm said so" is a legal liability.
- **Faster** — agents do the sourcing, screening, first-touch outreach and even
  the first interview, so a recruiter's time is spent only on judgment calls.
- **More accurate the more it is used** — the scoring model learns from each
  tenant's own hire/reject outcomes, and thin-data tenants borrow strength from a
  privacy-preserving, cross-tenant prior (the network effect / moat).

## 3. Who it is for

| Persona | What they get |
| --- | --- |
| **Recruiters / hiring managers** (primary) | A pipeline that fills itself, ranked candidates with a "why", one-click next-best-actions, and an inbox that triages candidate replies. |
| **Staffing agencies** (multi-tenant power users) | A 3-level tenant hierarchy (agency → client → branch) where a parent can see and operate across all children, but children are isolated from each other. |
| **Candidates** | A career portal: profile, AI conversation, chat/voice interviews, and a candidate-side "co-pilot" showing their hiring momentum. |
| **Platform admins** (Lexy staff) | Cross-tenant visibility, tenant provisioning, billing, fairness/audit dashboards, and system-health tooling. |

> **Note for new engineers:** "Platform admins / Lexy staff" is a *product role*, not a separate team. Today, Lexy staff and the engineering team are the same people — so when you build for this persona, you are building tooling for yourselves. As the company grows, this role is expected to become a dedicated ops/admin function distinct from engineering.

## 4. The problem it solves

Traditional hiring tooling is **passive record-keeping** (an ATS stores
applications) plus **disconnected point tools** (a sourcing tool, a scheduling
tool, an assessment tool). The recruiter is the integration layer — they copy
data between tools and hold the "who is actually good" judgment in their head.

Lexy collapses that. The signals from every stage (resume screen, identity
verification, interview performance, outreach engagement, proctoring integrity)
flow into **one composite score per candidate-per-job**, with a confidence level
and a recommended action. The recruiter stops being the integration layer and
becomes the decision-maker on a pre-ranked, pre-reasoned shortlist.

## 5. The moat (say this out loud in every design review)

Two things are intentionally hard to copy and should be protected in every
architectural decision:

1. **The Intelligence Engine** — the composite multi-signal scoring with
   per-tenant learned calibration and a cross-tenant global prior. Each hire
   outcome makes the model better; thin tenants benefit from the whole network
   without their raw data ever leaving their boundary.
2. **Internal-first sourcing** — Lexy searches the tenant's *own* talent pool
   (current/past candidates, employees) **before** spending money on external
   providers, and surfaces internal matches first. This is both cheaper and a
   genuinely better candidate experience.

> ⚠️ Per project convention, the Intelligence Engine and internal-first sourcing
> must be prominently featured in every product/recruiter/sales guide. They are
> the differentiators — treat them as load-bearing, not as features.

## 6. Surfaces (what actually ships)

| Artifact | Package | What it is |
| --- | --- | --- |
| Hiring platform | `@workspace/lexy` | The main recruiter + candidate React app. |
| Public website | `@workspace/lexy-site` | Marketing site. |
| API server | `@workspace/api-server` | Express backend + 16 background schedulers + AI agents + AI job queue. |
| Sales brochures | `@workspace/lexy-brochure`, `@workspace/lexy-candidate-brochure` | Slide/presentation tools. |
| Mockup sandbox | `@workspace/mockup-sandbox` | Component preview/dev surface. |

## 7. How to read the rest of this set

- **Doc 2 — Architecture overview**: how the pieces fit together.
- **Doc 3 — Developer onboarding**: set up, run, test, deploy.
- ⭐ **Doc 4 — System design & decisions (the "why") — START HERE AFTER THIS DOC. THE MOST IMPORTANT ONE.**
  Intelligence engine, RLS tenant isolation, agent orchestration — and why each
  is shaped the way it is. If you read only one doc beyond this overview, read Doc 4.
- **Doc 5 — API documentation**: route inventory + auth model.
- **Doc 6 — Engineering principles**: how we work and what the guardrails are.
- **Doc 7 — Roadmap** · **Doc 8 — Changelog** · **Doc 9 — Tech debt/backlog**.
