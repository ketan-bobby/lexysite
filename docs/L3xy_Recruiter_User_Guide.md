---
title: L3xy — Recruiter User Guide
---

<div class="cover">

# L3xy

<div class="subtitle">Recruiter User Guide</div>

<div class="tag">Your complete day-to-day playbook · 2026 Edition</div>

<!--USERCOVER-->

</div>

---

## Welcome

You've just been handed an AI hiring team. Nine specialized agents that source, screen, verify, message, schedule, interview, and protect your pipeline against ghosting — all running in the background while you focus on the decisions only a human should make.

This guide walks you through your day with L3xy: how to get into the product, what each screen does, what every button means, and how to get from "open requisition" to "signed offer" with the least possible busywork. It is meant to be **complete** — read it once front to back, then keep it open as a reference.

> **Read time:** about 40 minutes for the full guide. If you just want to start working today, read *Welcome*, *Getting Started*, *Your Dashboard*, *Creating a Work Order*, and *Reading a Candidate Card* — then come back for the rest.

### The mental model

Stop thinking of L3xy as an ATS. Think of it as a **decision cockpit**.

- The **agents** do the work — sourcing, outreach, screening, scheduling, interviewing.
- The **Intelligence Engine** scores every candidate and tells you *exactly* what to do next.
- **You** approve, override, and push humans across the finish line.

Your time is now spent on three things: defining good roles, reviewing flagged candidates, and closing the ones the system surfaces. Everything else runs itself.

### How this guide is organized

| Part | Chapters | What it covers |
|---|---|---|
| **Get in & oriented** | 1–2 | Logging in, your role, the dashboard |
| **Run a role end-to-end** | 3–9 | Jobs, sourcing, candidate cards, scoring, next actions |
| **The automated layer** | 10–13 | Screening, verification, outreach, interviews |
| **Work smart** | 14–17 | Decision queue, the always-on pool, talent pool, client portals |
| **Measure & manage** | 18–21 | Analytics, your team, billing, settings |
| **Reference** | 22–24 | Best practices, FAQ, quick-reference card |

---

## Chapter 1 · Getting Started

### Signing in

L3xy lives in your browser — no install. Open your organization's L3xy URL and you'll land on the **Login** page (`/login`). Enter your email and password and you're in.

- **Forgot your password?** Use the reset link on the login screen.
- **First time here?** You were almost certainly invited by a teammate (see *Accepting an invite* below) or you started a trial.

### Starting a trial

If your company is evaluating L3xy, someone can request a trial from the **Trial Setup** page (`/auth/trial-setup`). You fill in your company details, and a L3xy platform administrator reviews and activates the workspace. Once approved, you'll receive your login and land straight on the dashboard.

### Accepting an invite

When a teammate adds you to an existing workspace, you'll get an email with a link. Click it to reach the **Accept Invite** page (`/accept-team-invite` or `/accept-invite`), set your password, and you're in with the role your admin assigned.

### Your role decides what you see

L3xy uses role-based access. The same product shows different controls depending on who you are:

| Role | Who it's for | What it unlocks |
|---|---|---|
| **Recruiter** | Day-to-day sourcing and hiring | Jobs, candidates, outreach, interviews, decisions — everything in this guide |
| **Tenant Admin** | Team leads / agency owners | Everything a recruiter has, **plus** team management, client/branch setup, billing, and policy thresholds |
| **Platform Admin** | L3xy operators | Cross-workspace administration, trial approvals, and bulk import |

> If you don't see a screen mentioned in this guide, it's almost always a permissions thing — ask your Tenant Admin to adjust your role.

### Finding your way around

The top navigation is your home base. The core destinations:

| Nav item | Route | What's there |
|---|---|---|
| **Dashboard** | `/dashboard` | Mission control — KPIs, recommended actions, hire-ready list |
| **Jobs** | `/jobs` | Your open roles (work orders) |
| **Candidates** | `/candidates` | The full talent pool |
| **Inbox** | `/outreach/inbox` | Candidate replies that need you |
| **Interviews** | `/interviews` | AI interview sessions and reports |
| **Decisions** | `/decision-queue` | Candidates ready for a human call |

Admins also see **Team** (`/team`), **Clients** (`/clients`), **Analytics** (`/analytics`), and **Billing** (`/subscription`).

---

## Chapter 2 · Your Dashboard

When you log in, you land on the **Dashboard** (`/dashboard`). It's the mission-control view of every role and every candidate in motion.

<!--DASHBOARD-->

### What you're looking at

| Section | What it tells you | When to act |
|---|---|---|
| **Roles in Motion** | How many work orders are live | Click any number to drill in |
| **Total Candidates** | Size of your living talent pool | Trends matter more than the absolute number |
| **AI Interviews** | Sessions completed in the last period | Spike = lots of decisions coming |
| **Offers & Hires** | Closed-won outcomes | Your scoreboard |
| **AI Pipeline Funnel** | Where candidates sit by stage | Spot bottlenecks instantly |
| **Recommended Actions** | Things L3xy thinks you should do *right now* | Always start your day here |
| **Agent Activity Feed** | What the AI is doing in real time | Background context — peek if curious |
| **Hire-Ready Candidates** | Top of the queue, ranked | One-click into the candidate card |

### Your daily routine (5 minutes)

1. Open the dashboard.
2. Skim **Recommended Actions** — clear the high-priority items first.
3. Glance at **Hire-Ready Candidates** — anyone above 85% probability deserves a look.
4. Check the **Pipeline Funnel** for bottlenecks (e.g., 40 candidates sourced but 0 verified means Verify is stuck — go check).
5. Done. Most days, that's it. The pipeline runs itself.

---

## Chapter 3 · Creating a Work Order

A **Work Order** is L3xy's name for an open requisition. Create one and the entire 9-agent pipeline wakes up for that role.

Go to `/jobs` and click **+ Create Work Order**. You'll see a 3-step wizard.

### Step 1 — Client & Branch

Pick the company and team. (Skip this if you're an in-house recruiter — your own org is pre-selected.)

### Step 2 — Job Basics

Title, location, employment type, seniority, salary band. The standard stuff. Take 30 seconds — these become hard filters for the Sourcing agent, so accuracy matters.

> **Tip:** Use seniority levels like *IC4 / Senior / Staff* if your company has them. The ICP agent reads them and adjusts experience expectations automatically.

### Step 3 — Job Description

You have three ways to give L3xy the JD:

1. **Paste it** — works fine, what most people do.
2. **Upload a doc** (PDF, Word) — the **JD Parser** extracts everything cleanly.
3. **Generate it** — click **AI JD Generator**, give it a one-line role brief, and it drafts a full description you can edit.

When you save, the **ICP agent** kicks off automatically and produces an *Ideal Candidate Profile* — a structured persona with must-haves, nice-to-haves, target seniority, and domain. **Read it before launching.** If something looks off (e.g., it locked onto Python when you wanted Go), edit the ICP directly. Everything downstream depends on it.

---

## Chapter 4 · Launching the Pipeline

On the work order detail page (`/jobs/:id`), you'll see the **Agent Configuration** panel — nine toggles for the nine agents.

<!--PIPELINE-->

The default is sensible: all nine on, in canonical order. You only need to touch this if:

- **You don't want outbound sourcing** — turn off Sourcing if you only want to evaluate inbound applicants.
- **You're skipping live AI interviews** — turn off Interview if your team prefers human screens only.
- **You don't need proctoring** — turn off Proctoring for non-technical or junior roles.

Click **Launch** and the pipeline begins. The Agent Activity feed will start filling up. Within minutes you'll see your first candidates appear in the work order's Candidate Pipeline.

> **Don't watch the pot boil.** Close the tab and come back in an hour. By then you'll have dozens of scored candidates ready to review.

### The nine agents at a glance

| # | Agent | What it does for you |
|---|---|---|
| 1 | **ICP** | Turns your JD into a structured ideal-candidate profile |
| 2 | **Sourcing** | Finds matching people from the pool and external sources |
| 3 | **Screening** | Reads every resume against the ICP and scores fit |
| 4 | **Verification** | Checks identity, employment, and risk signals |
| 5 | **Outreach** | Writes and sends personalized messages, classifies replies |
| 6 | **Scheduling** | Coordinates interview timing without back-and-forth |
| 7 | **Interview** | Runs autonomous AI video interviews and scores them |
| 8 | **Proctoring** | Monitors interviews for integrity issues |
| 9 | **Anti-Ghost** | Detects and re-engages candidates at risk of going dark |

---

## Chapter 5 · Sourcing Candidates

Once a role is launched, the **Sourcing agent** goes to work. You don't have to do anything — but here's how to steer it and how to source manually when you want to.

### How automatic sourcing works

The Sourcing agent reads the ICP and searches **two places**:

1. **Your talent pool first** — everyone L3xy has ever touched on your behalf is re-evaluated against this new role.
2. **External sources** — to fill gaps the pool can't.

Matches flow into the work order's pipeline as **Sourced** candidates, each with an initial fit score. Watch them appear in the Agent Activity feed.

### Searching on your own

Open **Sourcing** (`/sourcing`) to run an ad-hoc search in plain language — for example, *"senior Go engineers in Berlin with distributed-systems experience."* The engine ranks results and lets you add anyone interesting to a role.

### Talent Match — rank the pool against a role

**Talent Match** (`/talent-match`) answers the question *"who in my warm pool fits this role?"* It ranks your entire pool against any job's ICP in seconds. Use it **before** launching outbound sourcing — you're often sitting on the perfect candidate already.

### Adding a candidate by hand

Go to `/candidates → + Add Candidate`. Paste a LinkedIn URL or upload a resume. They enter the pool and get scored exactly like a sourced candidate.

> **If sourcing finds nobody:** the ICP is usually too narrow, the location filter too tight, or the salary band below market. Open the work order, loosen one constraint, and relaunch.

---

## Chapter 6 · Reading a Candidate Card

This is the screen where you'll spend most of your day. Click any candidate name (from the dashboard, the talent pool, or a work order) to open their card at `/candidates/:id`.

<!--CARD-->

The candidate card has five tabs and one big number at the top: the **Hire Probability**.

### The header

- **Name, current title, photo, contact links.**
- **Hire Probability gauge** — the headline number. 0–100%. This is the Bayesian composite of Fit, Quality, Trust, and Conversion. Hover for the breakdown.
- **Lexy Candidate Prediction** — a one-paragraph plain-English summary written by the Intelligence Engine. *"Sarah is a strong fit for this Staff Engineer role. Skills align across distributed systems and Go. Trust verified. She's responsive and likely to advance."* Read this first.
- **Action buttons:** *Push to Client*, *Advance Stage*, *Reject*, *Send Message*.

### Tab 1 — Intelligence

The full scoring breakdown across six dimensions: Skills, Experience, ICP fit, Engagement, Trust, and Quality. Each shows a sub-score plus the signals that drove it. This is what you show the hiring manager when they ask *"why this person?"*

### Tab 2 — Timeline

Every event in chronological order: sourced from X, screened on Y, replied on Z, interviewed at T. Conversation history, agent actions, status changes. If something feels off, the Timeline tells you exactly what happened.

### Tab 3 — Interviews

The full record of every AI video interview. Watch the playback, read the transcript, see the per-question scores, and review proctoring flags (if any). Click into a question to see the AI's evaluation rubric.

### Tab 4 — Resume / Screening

Original resume on one side, the **AI Recruiter Summary** on the other. Below: extracted skills, missing skills, and a flag if anything in the resume contradicts a verification signal.

### Tab 5 — Verification

Identity check status, document review, employment verification, fraud signals. Green = clear, amber = needs review, red = blocked. Click any flag for the underlying evidence.

---

## Chapter 7 · Understanding the Score

Every candidate carries a **Hire Probability** — the single number you triage on. It's worth understanding what's behind it so you trust it (and know when to override it).

<!--SCORING-->

### Four composites, many signals

Hire Probability is a Bayesian blend of four weighted composites:

- **Fit** — skills, experience, and ICP alignment.
- **Quality** — screening result, interview performance, sourcing strength.
- **Trust** — verification, proctoring, fraud checks.
- **Conversion** — engagement, anti-ghost signals, scheduling responsiveness.

Each composite is fed by independent signals from the agents, and **fresher signals count more** — a reply from yesterday outweighs a resume keyword from last year. That's why a score can move on its own: a new signal arrived and the engine re-weighed everything.

<!--ENGINE-->

> **The takeaway:** the score is an *input*, not a verdict. It's the engine's best estimate from the data so far. Your judgment, the transcript, and the conversation are where you make the real call.

---

## Chapter 8 · Acting on Next Best Action (NBA)

Above every candidate card and in your Recommended Actions list, you'll see an **NBA chip** — L3xy's recommendation for what to do next with this person.

<!--NBA-->

There are five possible NBAs. Treat them like guardrails, not commands — you can always override.

| NBA | What it means | Default action |
|---|---|---|
| **Verify** | Trust score is below your tenant's policy floor | Trigger an extra verification check |
| **Re-engage** | This candidate is at risk of ghosting | Send the AI-drafted nudge, or write your own |
| **Advance** | Hire probability is above your advance threshold | Move to the next stage |
| **Reject** | Quality is below floor and screening is complete | Send the polite rejection (templated) |
| **Schedule** | Default — keep moving the pipeline forward | Book the next interview |

Each NBA is recorded in the audit trail with the policy snapshot that produced it. If a hiring manager later asks *"why did we reject this person?"* you can show them the exact decision and the data behind it.

---

## Chapter 9 · The Candidate Pipeline (Kanban)

Each work order has a **pipeline board** that shows where every candidate sits. Candidates move left to right as agents (and you) act on them.

| Stage | How candidates arrive | What's happening |
|---|---|---|
| **Sourced** | Sourcing agent or manual add | Initial fit score assigned |
| **Screening** | Auto, on link to the role | Resume scored against the ICP |
| **Verification** | Auto, on entering the stage | Identity & employment checks run for *every* candidate |
| **Outreach** | After verification clears | Personalized messages sent; replies classified |
| **Interview** | After a positive reply | AI interview invited, run, and scored |
| **Decision** | After interview | Waiting for your push-to-client or advance call |
| **Hired / Rejected** | Your decision | Closed; the candidate stays in your pool |

### Moving candidates yourself

Drag a card to a new stage, or use **Advance** / **Reject** on the card. A manual move is always respected — if you push someone forward, the system trusts your call and won't silently pull them back.

> **Watch for stalls.** If a column is full but the next one is empty (e.g., lots Sourced, nothing Screened), open a card in that column — there's usually a flag or a missing input explaining the holdup.

---

## Chapter 10 · Screening & Verification

Two agents quietly do the work that used to eat your mornings. You mostly just review their output on the candidate card — but here's what's happening under the hood.

### Screening

The **Screening agent** reads each resume the moment a candidate is linked to a role and scores it against the ICP. On the **Resume / Screening** tab you get:

- An **AI Recruiter Summary** — the "why this person, in plain English."
- **Extracted skills** and **missing skills** versus the ICP.
- A contradiction flag if the resume conflicts with a verification signal.

Screening is automatic — you never trigger it. While it's running you'll see a brief "screening…" indicator on the card; results usually land in seconds.

### Verification

When a candidate enters the **Verification** stage, the **Verification agent** runs automatically for *everyone* in that stage — sourced, applied, or manually added. It checks identity, employment history, and risk/fraud signals, and writes a verdict to the **Verification** tab:

- 🟢 **Green** — clear, nothing to see.
- 🟠 **Amber** — needs a human review; click for the evidence.
- 🔴 **Red** — blocked; a serious flag.

> **Don't ignore amber.** A five-minute review now prevents an embarrassing reversal later. The flag is amber for a reason — the system isn't sure, so it's asking you.

You can also re-run verification on demand from the candidate card if new information arrives.

---

## Chapter 11 · The Outreach Inbox

When candidates reply to L3xy's messages, the responses land in `/outreach/inbox`. This is your second-most-visited screen.

### How it's organized

- **Grouped by Work Order** — keeps the noise down.
- **Each message has a classification badge** assigned by AI:
  - **Positive Reply** — they're interested, no action needed (auto-progressed)
  - **Question** — they asked something, needs your touch
  - **Not Interested** — politely declined, auto-marked DNC for this role
  - **DNC** — Do Not Contact (also blocks future cross-role outreach unless overridden)

### Campaigns & autopilot

Outreach runs as a **campaign** — a first touch, a second touch, and follow-ups, each personalized from the candidate's profile and your brand voice. With **autopilot** on, the agent advances the sequence on its own (sending the next nudge only if there was no reply), so warm candidates never go cold while you sleep.

### The AI-drafted reply

For "Question" and other "Needs Review" messages, you'll see an **AI Reply Draft** below the candidate's message. You have three buttons:

- **Approve** — sends it as-is.
- **Edit** — opens the editor with the draft pre-loaded; tweak and send.
- **Discard** — write your own from scratch.

> **Tip:** Approve drafts liberally. The AI's tone matches your campaign settings, and edits should only be needed for genuinely tricky asks. Trust the system; review the outputs.

### The Do Not Contact list

Manage your **DNC** list at `/dnc`. Anyone here is excluded from every message, every cadence, every worker, and every future scan — universally and permanently. When a candidate says "please stop," that promise is non-negotiable and honored across all roles.

---

## Chapter 12 · AI Interviews

L3xy can run **autonomous video interviews** — the candidate joins a room, the AI conducts the session, scores it, and writes you the report. No scheduler needed (the candidate self-books from the link they receive).

### Setting up an interview

From a candidate card, click **Schedule Interview**. You'll see the configurator:

- **Interview type:** Technical, Behavioral, System Design, Cultural Fit, or Custom.
- **Question count:** 5 / 8 / 12.
- **Language:** 30+ supported. Defaults to the candidate's apparent language but you can override.
- **Proctoring:** On by default for technical interviews.

Click **Send Invite** and the candidate gets a self-scheduling link. They book a time, the AI runs the session, and you get a notification when the report is ready.

### What the candidate experiences

Candidates take the interview from their **portal** (`/portal/career`). The AI interviewer — always named **Lexy** — greets them, asks one question at a time, listens, and responds naturally. It's a real conversation, not a form.

### Reviewing an interview

From `/interviews/:id` you'll see:

- **Score Badge** — overall AI evaluation (0–100).
- **Per-question breakdown** with transcript, evaluation rubric, and the AI's reasoning.
- **Proctoring report** (if enabled) — see below.
- **Playback** — watch the actual session.

> Treat the AI score as one input, not the verdict. The transcript and the playback are where you make the real call.

### Proctoring

When proctoring is on, L3xy monitors the session for integrity and produces a **proctor report** (`/interviews/:id/proctor-report`): environmental analysis, identity confirmation, and behavioral flags such as additional voices, tab-switching, or screen-sharing. Flags are signals for your judgment — not automatic disqualifications.

### Scoring fairly

Interviews are scored on the **substance** of the answers — relevance, depth, correctness, specific examples. The engine is explicitly instructed *not* to reward or penalize accent, dialect, grammar, or speaking style except where it genuinely blocks job-relevant communication.

---

## Chapter 13 · The Decision Queue

`/decision-queue` is where L3xy puts candidates that are *ready for a human decision* — usually because they've cleared every automated gate and are waiting for either a "push to client" or an "advance to onsite" call.

Work the queue top-down. Each card has the candidate's photo, hire probability, the NBA, and a one-line summary. Click to open the full card; act; repeat.

> Power-user tip: Set yourself a 15-minute timer twice a day to clear the Decision Queue. That's usually enough to keep every role moving without it consuming you.

---

## Chapter 14 · The Always-On Pool

Here's a thing nobody tells you about most recruiting tools: when you log out, the system goes to sleep. Sequences pause. Cold candidates stay cold. New roles don't surface old people.

**L3xy is different.** Six background workers run 24/7 on your behalf, even on weekends and holidays. You don't configure them. You don't schedule them. They just run.

<!--LIVING-->

| What runs | How often | What it does |
|---|---|---|
| Outreach autopilot | every 15 min | Advances campaign sequences — sends the next nudge if a candidate didn't reply |
| Ghosting detectors | every 30 min | Scans for interview no-shows, dropped conversations, stalled pipelines, offers in limbo |
| Nurture re-engagement | every 6 hours | Generates personalized "stay warm" emails for at-risk candidates |
| Pool revival | every 24 hours | Mails dormant candidates: Passive (30-89d quiet) and Inactive (90+d quiet) |
| Cross-role re-scan | every 24 hours | Re-evaluates every pool candidate against every open role; strong matches (≥75) get a heads-up email — *"a company is interested in you, want me to introduce you?"* |
| LinkedIn drift monitor | every 24 hours | For candidates 6+ months stale, checks LinkedIn for job changes; sends either a "congrats on the new role" email or a calendar-based wellness check-in |

### What the candidate sees

Three of these workers send candidate-facing emails automatically. Here's the plain-English version of each:

| When this happens | The candidate gets | Why it's powerful |
|---|---|---|
| They've been silent 30-89 days | *"Are you still looking? Anything you'd like us to know?"* | Soft, low-pressure — invites them back into the conversation |
| They've been silent 90+ days | *"Your profile is losing visibility — quick check-in?"* | Honest about what's at stake — drives a refresh |
| Their Lexy profile is 6+ months old AND LinkedIn shows a new job | *"Congrats on the new role at [Company]! Want to update your profile?"* | Catches the candidates who got promoted and forgot to tell us — without anyone having to ask |
| Their Lexy profile is 6+ months old AND LinkedIn shows no change (or no data) | *"Has something exciting happened lately? New job, promotion, relocation?"* | The 6-month wellness check that other platforms simply don't do |
| A new role opens that scores them ≥ 75 | *"A company has shown interest in you — want me to make the intro?"* | The reverse pitch: the platform is selling **opportunities to candidates**, not just candidates to recruiters |

### What this means for your day

When you open the dashboard each morning, the **Recommended Actions** list is *not* the leftover work from yesterday. It's the result of overnight activity:

- Candidates who replied to a 2 a.m. nurture email and need your touch.
- Candidates who got auto-matched to a new role overnight and are waiting for your "yes."
- Candidates the ghosting detectors flagged who need a 30-second decision from you.
- Candidates from 6 months ago who just re-engaged because the pool revival worker reached them.

> **The discipline:** trust the overnight queue. If you find yourself manually scrubbing the talent pool for "people who might be a fit," you're doing the job the system already did while you slept.

### The DNC promise

Every re-engagement respects the **Do Not Contact** flag — universally and forever. If a candidate says "please stop," the DNC marker is honored across every role, every cadence, every worker, and every future scan. This is non-negotiable.

---

## Chapter 15 · The Talent Pool — Your Warm Asset

`/candidates` is the full list of every person L3xy has ever touched on your behalf. **This is the most underused page in the product, and it shouldn't be.**

<!--CANDIDATE-->

### Why it matters

Every candidate here is a **living node** — their profile is automatically re-scored against every new role you open. Someone who wasn't right for last quarter's Senior PM role might be a perfect fit for this quarter's Director role, and L3xy will tell you so without you lifting a finger.

### How to use it

1. Open `/candidates`.
2. Filter by skill, location, or **Talent Match Score** for any specific job.
3. Use **Talent Match** (`/talent-match`) when you want to ask "find me everyone in the pool who fits this new role" — the engine ranks the entire pool against the new ICP in seconds.
4. Reactivate anyone interesting with a single click — their full history, prior conversations, and stage progress carry over.

> **The discipline:** Before you launch outbound sourcing for a new role, *always* check the talent pool first. You're sitting on a compounding asset. Use it.

---

## Chapter 16 · Pushing to Client (Agency Recruiters)

If you're an agency, the **Push to Client** action sends a candidate's curated profile to your client portal — sanitized, branded, and with the AI Recruiter Summary front and center.

The client sees what you want them to see. They don't see proctoring flags, raw scores, or internal notes unless you explicitly enable that share.

You'll get a notification when the client views, comments, or moves the candidate forward.

---

## Chapter 17 · Analytics & Reporting

Open **Analytics** (`/analytics`) for the numbers that tell you whether your hiring engine is healthy.

### What you can see

| Metric | What it answers |
|---|---|
| **Time-to-hire** | How long candidates take to move from sourced to hired |
| **Funnel conversion** | Where candidates drop off, stage by stage |
| **Source effectiveness** | Which sources produce the candidates who actually convert |
| **Agent performance** | How much work each agent is doing and how well |

### Engagement

The **Engagement** view (`/engagement`) zooms in on candidate responsiveness — reply rates, time-to-first-response, and portal activity. Use it to spot campaigns that aren't landing and roles where candidates are going quiet.

> **How to read a funnel:** a healthy funnel narrows smoothly. A sharp cliff between two stages is a process problem — for example, lots of outreach but few replies means your messaging or targeting needs a look, not more volume.

---

## Chapter 18 · Team & Tenant Management

*(Tenant Admins)*

### Managing your team

Go to **Team** (`/team`) to manage seats and roles:

- **Invite a teammate** — enter their email and choose a role (Recruiter or Tenant Admin). They get an invite link to accept.
- **Change a role** — promote a recruiter to admin, or vice versa.
- **Remove a member** — revoke access when someone leaves.

### Agencies: clients & branches

If you run an agency or a multi-team org, **Clients** (`/clients`) lets you manage sub-clients and branches. L3xy supports a hierarchy:

**Platform → Agency → Sub-client / Branch**

Visibility flows down the tree: a parent can see its children's work, but siblings stay separate. When you create a work order, you choose which client/branch it belongs to (that's Step 1 of the wizard).

> **Tip:** Keep your client/branch structure tidy from the start. It drives who can see which roles and candidates, and it's what your analytics roll up by.

---

## Chapter 19 · Billing & Subscription

*(Tenant Admins)*

Manage your plan from **Billing** (`/subscription`).

### Plans

| Plan | Best for |
|---|---|
| **Starter** | Smaller teams getting going — core agents and a starting set of seats and usage |
| **Growth** | Scaling teams — higher limits and more room across seats, usage, and advanced agent use |

### Credits & usage

L3xy meters the work the AI does for you — things like AI generations, outreach messages, and interview sessions — as **credits**. The Billing page shows your current usage against your plan so there are no surprises. If you're approaching a limit, that's your cue to review usage or upgrade.

### Payment

Payment and invoices are handled securely through **Stripe**. From the Billing page, click through to the **Stripe customer portal** to update your card, download invoices, or change your plan. L3xy never stores your card details directly.

> **Watch your usage trend, not just the total.** A steady climb in interview or outreach credits is a good sign your pipeline is busy — plan your upgrade before you hit the ceiling, not after.

---

## Chapter 20 · Settings & Your Account

Beyond the big screens, a few settings shape how L3xy behaves for you and your team.

- **Your profile** — name, photo, and contact details that appear to teammates and (where relevant) candidates.
- **Notifications** — choose what reaches you in-app and by email: new replies, interview reports, verification flags, and ghosting alerts. Tune these so the dashboard's Recommended Actions stay signal, not noise.
- **Policy thresholds** *(Tenant Admins)* — the floors and thresholds that drive Next Best Action: the trust floor that triggers **Verify**, the probability that triggers **Advance**, and the quality floor that triggers **Reject**. Every NBA records the policy snapshot that produced it, so changes here are fully auditable.

> **The system learns from you.** When you override an AI suggestion, that disagreement feeds a closed-loop learning system that gradually tunes your tenant's policy to match how *you* actually decide.

---

## Chapter 21 · Tips, Tricks, and Best Practices

### Do

- **Read the ICP before launching.** Five seconds of review saves an hour of bad sourcing.
- **Mine the talent pool before every new role.** Cross-role intelligence is the moat — use it.
- **Approve AI replies liberally.** That's the productivity win. Don't second-guess every draft.
- **Work the Decision Queue twice a day.** It's the highest-leverage 30 minutes you'll spend.
- **Trust the NBA recommendations** unless you have a specific reason not to. They're built from your tenant's policy + the math.

### Don't

- **Don't disable agents to "have more control."** You'll just create blind spots. The system is designed to run end-to-end.
- **Don't manually re-score candidates.** Decay is automatic; the engine knows fresh signals are worth more than old ones.
- **Don't ignore amber verification flags.** They're amber for a reason. Five-minute review now saves an embarrassing reversal later.
- **Don't write outreach from scratch when an AI draft is sitting there.** Edit it instead. Save your writing time for the messages that actually need a human voice.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `g d` | Go to Dashboard |
| `g j` | Go to Jobs |
| `g c` | Go to Candidates |
| `g i` | Go to Inbox |
| `n` | New Work Order (from Jobs page) |
| `j / k` | Next / previous candidate in any list |
| `a` | Advance current candidate |
| `r` | Reject current candidate |
| `?` | Show all shortcuts |

---

## Chapter 22 · FAQ

**Why is my Hire Probability changing without me doing anything?**
Because new signals arrived (a reply, a verification result, an interview score) and the engine re-scored. That's the system working as designed. Open the Timeline tab to see what changed.

**A candidate I rejected six months ago is showing up as a "match" for a new role. Is this a bug?**
No, it's the feature. They were rejected for *that* role, not banned from your pool. If they're a fit for the new role, L3xy will surface them. Reactivate or ignore — your call.

**The Sourcing agent isn't finding anyone.**
Three usual causes: (1) the ICP is too narrow — relax must-haves, (2) the location filter is too tight, (3) the salary band is below market. Check the work order, edit, relaunch.

**Can I add a candidate manually?**
Yes — `/candidates → + Add Candidate`. Paste a LinkedIn URL or upload a resume. They enter the pool just like a sourced candidate.

**Can I export candidate data?**
Yes — every list view has an Export button (CSV). Compliance: respect your tenant's data retention policy.

**Can I turn off the AI interview and just use human screens?**
Yes. Disable the Interview agent on a per-work-order basis in Agent Configuration.

**How do I add a teammate?**
Tenant Admins go to `/team`, click invite, enter the email, and pick a role. The teammate accepts via the emailed link.

**Where do I change my plan or update my card?**
Tenant Admins open `/subscription` and use the Stripe customer portal link to manage payment and plan.

**A candidate is asking who's actually messaging them. What do I say?**
Be transparent: *"I'm using an AI assistant to coordinate scheduling and initial outreach. Everything substantive comes through me."* Honesty wins.

**I disagreed with an AI-suggested rejection. What happens to that signal?**
Your override is logged and feeds the closed-loop learning system. Over time, the engine adjusts its policy for your tenant to match how *you* actually decide. The system gets smarter from disagreement, not just agreement.

---

## Chapter 23 · Quick Reference Card

| You want to... | Go to... |
|---|---|
| See what's hot today | `/dashboard` |
| Open a new role | `/jobs` → **+ Create Work Order** |
| Run an ad-hoc search | `/sourcing` |
| Rank your pool for a role | `/talent-match` |
| Review a candidate | `/candidates/:id` |
| Reply to a candidate | `/outreach/inbox` |
| Manage the Do Not Contact list | `/dnc` |
| Schedule an AI interview | Candidate card → **Schedule Interview** |
| Review an interview | `/interviews/:id` |
| Clear ready-to-decide candidates | `/decision-queue` |
| Find people in your warm pool | `/candidates` |
| Watch what the agents are doing | Dashboard → **Agent Activity Feed** |
| See who's at risk of ghosting | Dashboard → **Recommended Actions** |
| Check funnel & time-to-hire | `/analytics` |
| Manage your team | `/team` |
| Manage clients / branches | `/clients` |
| Change plan or payment | `/subscription` |
| Push to a client portal | Candidate card → **Push to Client** |

---

## Welcome to the team

L3xy isn't trying to replace you. It's trying to delete the parts of your job you hate so you can focus on what you're actually good at — judging humans, building relationships, and closing offers.

Use it boldly. Trust the math. Override when your gut says otherwise. And every override teaches the system to recruit more like *you*.

Now go open your dashboard and let's hire someone.

— *The L3xy Team*
