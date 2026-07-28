---
pdf_options:
  format: Letter
  margin: 24mm 18mm
  printBackground: true
  headerTemplate: |-
    <style>section { margin: 0 auto; font-family: -apple-system, system-ui, sans-serif; font-size: 9px; color: #6b7280; width: 100%; padding: 0 24px; display:flex; justify-content: space-between; }</style>
    <section><span>L3xy — The AI Hiring Platform</span><span>Overview Guide</span></section>
  footerTemplate: |-
    <style>section { margin: 0 auto; font-family: -apple-system, system-ui, sans-serif; font-size: 9px; color: #6b7280; width: 100%; padding: 0 24px; display:flex; justify-content: space-between; }</style>
    <section><span>© L3xy Inc. — Confidential preview material</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></section>
  displayHeaderFooter: true
stylesheet_encoding: utf-8
body_class: l3xy-doc
css: |-
  .l3xy-doc { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; color: #0f172a; line-height: 1.55; font-size: 11pt; }
  .l3xy-doc h1 { color: #0e7490; font-size: 26pt; border-bottom: 3px solid #06b6d4; padding-bottom: 6px; margin-top: 28px; }
  .l3xy-doc h2 { color: #0891b2; font-size: 17pt; margin-top: 26px; border-left: 4px solid #06b6d4; padding-left: 10px; }
  .l3xy-doc h3 { color: #0f172a; font-size: 13pt; margin-top: 18px; }
  .l3xy-doc table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 10pt; }
  .l3xy-doc th { background: #ecfeff; color: #0e7490; text-align: left; padding: 8px 10px; border-bottom: 2px solid #06b6d4; }
  .l3xy-doc td { padding: 7px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .l3xy-doc blockquote { background: #f0fdfa; border-left: 4px solid #14b8a6; padding: 10px 14px; color: #134e4a; margin: 14px 0; }
  .l3xy-doc code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 9.5pt; }
  .l3xy-doc hr { border: none; border-top: 1px dashed #cbd5e1; margin: 28px 0; }
  .l3xy-doc .cover { text-align: center; padding: 60px 0 30px; }
  .l3xy-doc .cover h1 { border: none; font-size: 44pt; color: #06b6d4; margin: 0; }
  .l3xy-doc .cover .subtitle { font-size: 14pt; color: #475569; margin-top: 8px; letter-spacing: 1px; text-transform: uppercase; }
  .l3xy-doc .cover .tag { display:inline-block; margin-top: 24px; background: #06b6d4; color:white; padding: 6px 14px; border-radius: 999px; font-size: 10pt; }
---

<div class="cover">

# L3xy

<div class="subtitle">The Autonomous AI Hiring Platform</div>

<div class="tag">Overview Edition · 2026</div>

<!--COVER-->

</div>

---

## Why L3xy exists

Hiring is broken. Recruiters spend 70% of their week on tasks a machine can do better — keyword-searching LinkedIn, screening resumes, chasing replies, scheduling interviews, and re-reading the same five candidates wondering who to advance.

Worse, the data they work with is **dead the moment it's collected**. Resumes go stale. Sourcing lists rot. ATS records become digital graveyards where qualified people are lost forever after one "no" or one missed reply. Recruiters re-source the same humans every six months because no one remembered they existed.

L3xy fixes both problems. It replaces the manual grind with a team of specialized AI agents working as a single coordinated pipeline — and it puts every candidate at the center of a **living talent graph** where data, signals, and relationships stay fresh forever.

> **The pitch in one line:** Tell L3xy what you're hiring for. It finds the people, qualifies them, talks to them, books the interviews, and tells you exactly who to hire — with the receipts. And every candidate it touches stays warm, ranked, and ready for the *next* role too.

---

## The Candidate is the Center

<!--CANDIDATE-->

Most hiring tools treat candidates as rows in a table. Sourced once, screened once, scored once, forgotten.

**L3xy is built around the candidate, not the requisition.** Every person who enters the platform gets a single living profile that grows richer with every interaction — and that profile is continuously, automatically re-evaluated against every open role across your company.

### What "living" actually means

- **Signals refresh themselves.** Every reply, no-show, interview score, proctoring flag, or schedule change writes back to the candidate's profile in real time. Their hire probability updates the same minute it changes.
- **Stale data loses weight automatically.** A candidate who was a 95% match six months ago doesn't keep that score forever — the engine knows fresh signals are worth more than old ones, and it down-weights anything past its useful life.
- **No one ever falls out of the funnel.** A candidate who said "not right now" in March doesn't disappear. They sit in the talent graph and re-surface the moment a role opens that fits them better — with their full conversation history, prior scores, and stage progress intact.
- **Profiles deepen over time.** Each agent that touches a candidate adds another dimension: the Sourcing agent contributes profile data, Screening adds skill structure, Verify adds trust signals, Interview adds behavioral evidence, Outreach adds engagement patterns. By the third role you consider them for, the profile is 10× richer than the day they were sourced.
- **Cross-role intelligence.** A candidate who was a 70% fit for the Product Marketing role is automatically re-scored against your new Growth role the day it opens. You never re-source the same human twice. Your talent pool is a *compounding asset*, not a depreciating one.

### The pool is *always* on

Most "talent pools" are storage. L3xy's pool is **operationally live** — six background workers run continuously, even when you're asleep:

- **Every 15 minutes** — outreach sequences advance to the next step for any candidate who didn't reply
- **Every 30 minutes** — four ghosting detectors scan for interview no-shows, dropped conversations, stalled pipelines, and offers stuck in limbo
- **Every 6 hours** — the nurture engine generates personalized re-engagement emails for at-risk candidates
- **Every 24 hours** — every candidate silent 30+ days gets categorized as Passive (30-89d) or Inactive (90+d) and offered a soft "are you still open?" check-in
- **Every 24 hours** — every candidate is re-evaluated against every open role across the platform; new matches surface as Recommended Actions on your dashboard
- **Every 24 hours** — the LinkedIn Drift Monitor checks candidates whose Lexy profile is 6+ months old, detects job changes via Enrich Layer, and sends a "congrats on the new role — want to update your profile?" email

### "Hey, companies are looking for you"

When a strong cross-tenant match is found (AI fit score ≥ 75), L3xy automatically emails *the candidate* a heads-up: *"A company has shown interest in your profile — our AI matching engine identified you as a strong fit for a [Job Title] role. Want me to make the introduction?"* This is the inverse of every other recruiting tool — the platform is selling **opportunities to the candidate**, not just candidates to the recruiter.

### The 6-month wellness check

Even candidates who *aren't* matched to a current role get a periodic, calendar-based wellness check: *"Has something exciting happened lately? New job, promotion, move, certification?"* The Enrich Layer probe runs first to detect any LinkedIn job change automatically; if nothing changed (or the data isn't available), the soft check-in mailer goes out. A 90-day cooldown prevents over-contact.

Nobody falls through the cracks. Nobody gets cold. Nobody is "lost in the database."

### Why this is the real moat

Every other "AI recruiting" platform is a workflow on top of a static database. They source, score, then go stale. L3xy is a workflow on top of a *living* candidate graph — and the graph gets smarter every day, with every interaction, across every role you ever post.

Six months in, your competitors are still cold-sourcing strangers. You're working a warm, ranked, self-updating pool of humans who already know your brand.

> **L3xy doesn't store candidates. It keeps them alive.**

---

## What L3xy does, end to end

L3xy runs a **9-stage autonomous pipeline** for every open role. Each stage is a specialized AI agent that hands its output to the next.

<!--PIPELINE-->

### The pipeline

| # | Stage | What happens |
|---|---|---|
| 1 | **ICP** | Reads your job description and builds an Ideal Candidate Profile — the must-haves, the nice-to-haves, the seniority, the domain. |
| 2 | **Sourcing** | Searches the open web and major candidate databases in parallel to surface qualified people you don't already have. |
| 3 | **Screening** | Reads every resume, scores skill alignment, and writes a recruiter-friendly summary. |
| 4 | **Verify** | Confirms the candidate is real — identity, profile consistency, and burner-account detection. |
| 5 | **Outreach** | Writes personalized first-touch messages and runs multi-step follow-up sequences. |
| 6 | **Schedule** | Books interview slots across timezones, sends invites, manages reminders. |
| 7 | **Interview** | Conducts AI-led video interviews with adaptive questioning across behavioral, cultural, technical, and programming tracks. |
| 8 | **Proctoring** | Monitors live interviews for integrity issues — multiple faces, gaze drift, off-screen prompts. |
| 9 | **Anti-Ghost** | Detects when a candidate goes silent and re-engages them before they're lost. |

Recruiters can run the full pipeline or pick any subset — the dependency graph automatically pulls in the prerequisite steps so the run is always valid.

---

## The Intelligence Engine

Every agent produces signals. The Intelligence Engine merges them into one number every recruiter actually wants:

> **"How likely is this person to get hired — and what should I do with them next?"**

For every candidate you see:

- A **single Hire Probability gauge** (0–100%)
- A **Next Best Action** recommendation: *Advance, Schedule, Verify, Re-engage,* or *Reject*
- The **strengths and risks** that drove the recommendation
- A **plain-English prediction** of the candidate's likely trajectory

The engine ranks every candidate in your pipeline so you always know who to look at first. No more guessing. No more "which of these 80 people should I call back."

---

## What recruiters see

### Job dashboard
- One-click pipeline launch with real-time progress
- Live count of candidates flowing through each stage
- Hire-probability ranking across the full talent pool

### Candidate profile
- The Intelligence Card with composite scores, hire gauge, and Next Best Action
- A complete decision audit trail — every signal that contributed, every agent that touched the candidate
- Stage-transition forecasts: probability of passing the next stage, accepting an offer, or going dark

### Outreach inbox
- Unified view of every conversation across every channel
- AI-drafted replies tuned to each candidate's tone and history
- Sentiment monitoring that flags at-risk threads before they ghost

### Interview rooms
- Live AI interviewer with adaptive question selection
- Real-time transcript and behavioral evaluation
- Integrity flags surfaced inline as the interview happens

### Analytics view
- Funnel breakdown across all 9 stages
- Bottleneck detection — where are candidates stalling?
- Calibration tracking — how accurate is the AI's hire prediction over time?

---

## What makes L3xy different

**It's a team, not a tool.** Most "AI recruiting" products are a single feature bolted onto an ATS — a resume parser, a chatbot, a scheduler. L3xy is a coordinated team of agents that work together with shared memory and a shared decision model.

**Decisions are explainable.** Every recommendation comes with the signals that produced it. Recruiters can override anything, and the system learns from the override.

**Fresh signals win.** The engine knows that a 30-day-old skill match is still useful but a 30-day-old "responsive to outreach" signal is meaningless. It re-weights signals by how recent and how relevant they are.

**It learns from your hires.** Every outcome — hired, ghosted, rejected — feeds back into the model so predictions get sharper for *your* roles, *your* market, *your* bar.

**It respects your policy.** Set the rules ("never auto-advance below 80% hire probability", "always require verification for finance roles") and the system enforces them.

---

## Built for teams of every size

| Role | What they get |
|---|---|
| **Recruiters** | A ranked queue. Action items. No more cold-search sessions. |
| **Hiring managers** | A short list of decision-ready candidates with the full evidence trail. |
| **Talent leaders** | Funnel analytics, calibration data, and a defensible hiring audit log. |
| **Founders** | Hire faster, hire better, without growing the recruiting team. |

The platform is fully multi-tenant with role-based access and tenant-level policy controls.

---

## What's coming next

We are actively expanding L3xy with:

- Deeper ATS integrations (Greenhouse, Lever, Ashby)
- Calendar-native scheduling for Google, Microsoft, and Apple
- A mobile recruiter app
- Custom agent SDK so teams can plug in their own specialized evaluators
- Continuously improving interview formats — case studies, take-home reviews, system-design rooms

---

## Want to see the engine room?

This document is the public overview. The full technical guidebook covers the scoring formulas, weighting models, decay constants, integration architecture, learning loop math, and exact agent prompt strategies that make L3xy work.

That version is shared **only with partners under an NDA**. If you're evaluating L3xy for your team and want to dig into how it really works under the hood, get in touch.

> **L3xy** — *Hire the right person. Faster than you thought possible.*

**Contact:** hello@l3xy.io · l3xy.io
