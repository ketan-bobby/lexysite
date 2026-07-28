---
title: L3xy — Unit Economics & Pricing Strategy
---

<div class="cover">

# L3xy

<div class="subtitle">Unit Economics & Pricing Strategy</div>

<div class="tag">Confidential · Internal & Board · 2026 Edition</div>

<!--ECONCOVER-->

</div>

<div class="nda">

**CONFIDENTIAL — INTERNAL ONLY.** This document contains L3xy's cost model, gross-margin analysis, and pricing strategy. Distribution is limited to L3xy employees, board members, and prospective investors under NDA. Do not share with prospects, customers, or competitors.

</div>

---

## Executive summary

L3xy's marginal cost to deliver a hire ranges from **~$45 (mature tenant) to ~$90 (new tenant)**. Industry average cost-per-hire for in-house recruiters is **~$4,700** (SHRM, 2023); for agencies it's **15-25% of first-year salary** ($12,000-$25,000+ on tech roles).

Even at a conservative $300-$500 per-hire price point, gross margins land north of **85%**. At our recommended hybrid pricing — **$799/mo platform fee + $250 per successful hire** — a typical 5-seat customer producing 30 hires/year generates **~$57K ARR at ~88% gross margin**.

The most important number in this document is not a single cost figure — it's the **cost trajectory**. Because every Tier-3 (paid external) candidate that passes screening is promoted into the warm pool (Tier 1), our marginal cost per hire **trends down** as a tenant matures. By month 12 we should be filling 60-80% of pipelines from Tiers 1+2 with **zero external API spend**. This compounding margin is the financial expression of the Living Talent Graph thesis.

> **The headline:** sub-$100 cost-per-hire vs. $5K-$25K market price. Pick any pricing model and we win on margin. The strategic question is which model maximizes the *flywheel*, not which maximizes per-hire margin in year one.

---

## 1. Cost components — the full breakdown

Costs fall into five categories. All figures are estimates based on 2026 published API pricing and industry-standard infrastructure rates. Every number is sensitivity-tested in §6.

### 1.1 LLM inference (per agent)

The single largest variable cost. We assume Anthropic Claude Sonnet 4 (or comparable) at **~$3 / MTok input · $15 / MTok output**, routed through the Replit AI integrations proxy.

| Agent | Token profile (avg) | Per-candidate cost |
|---|---|---|
| **ICP** | 8K in · 1.5K out, **once per job** (amortized over ~50 candidates) | $0.001 |
| **Screening** | Two-pass: 9K in · 1.5K out total | **$0.050** |
| **Verify** | 2K in · 300 out + email/phone validator lookups | $0.020 |
| **Outreach** | 6K in · 1.2K out (3 messages avg) | $0.040 |
| **Schedule** | 1K in · 200 out + calendar API | $0.010 |
| **Interview** (realtime voice) | 20-min session, OpenAI Realtime ($0.06/min in, $0.24/min out) + scoring pass | **$3.50** |
| **Proctoring** | Vision inference, ~$0.02/min × 20 min | $0.40 |
| **Anti-Ghost** | 1K in · 300 out per nudge × ~2 nudges | $0.020 |
| **LinkedIn Drift Monitor** | Enrich Layer call ($0.08) × ~4 checks/yr (180d stale + 90d cooldown) per pool candidate | $0.32 / candidate / yr |
| **Reverse-pitch notification** | template + light LLM personalization, ~1K in · 300 out | $0.005 / sent alert |

### 1.2 External data sources (Tier 3 only)

Sourcing budget consumed *only* when Tiers 1 and 2 (warm pools) cannot satisfy the job's target candidate count.

| Source | Rate (2026) | Per-candidate cost |
|---|---|---|
| **PDL** (People Data Labs) | ~$0.15 / profile retrieved | $0.15 |
| **EnrichLayer** (LinkedIn enricher) | ~$0.08 / profile resolved | $0.08 (top ~50% of pool) |
| **SerpAPI** | ~$0.01 / search query (~10 results each) | $0.002 |
| **GitHub API** | Free (rate-limited) | $0.00 |

**Tier-3 blended cost per sourced candidate: ~$0.24** (assuming PDL on all + EnrichLayer on top 50%).

> **Key dynamic:** A new tenant pays ~$0.24/sourced for 100% of their candidates. A mature tenant pays it for ~20-40% of their candidates. The other 60-80% come from warm pools at **$0**.

### 1.3 Infrastructure

| Component | Rate | Per-candidate cost |
|---|---|---|
| Postgres storage (~50KB/candidate signals) | $0.10 / GB·mo | <$0.001 |
| Compute (orchestrator, API workers) | amortized, ~$0.02/candidate lifetime | $0.020 |
| Vector embeddings (ICP matching) | text-embedding-3-small @ $0.02 / MTok | $0.0001 |
| Object storage — resumes | $0.023 / GB·mo | $0.001 |
| Object storage — interview recordings (2GB × 6mo retention) | $0.023 / GB·mo | **$0.28 per interview** |
| TURN/STUN servers (interview WebRTC) | ~$0.10 per interview | $0.10 per interview |

### 1.4 Communications

| Channel | Rate | Per-candidate cost |
|---|---|---|
| Email (SendGrid / equivalent) | $0.0006 / send × ~5 sends | $0.003 |
| SMS (Twilio) | $0.008 / msg × ~2 msgs (subset only) | $0.008 |
| Calendar API (Google/Microsoft Graph) | Free | $0.00 |

### 1.5 Platform & overhead (allocated)

These don't scale with per-candidate volume but must be allocated to compute true gross margin.

| Item | Annual cost (early-stage estimate) | Notes |
|---|---|---|
| Replit hosting + autoscale | ~$3,000 | Scales with ~$0.30 per active customer/mo at scale |
| Monitoring (Sentry, Datadog-equivalent) | ~$2,000 | Flat |
| Background job infrastructure | ~$1,500 | Included in Replit autoscale |
| AI integrations proxy markup | ~5-10% on LLM spend | Already priced into §1.1 |

At scale (100+ tenants), allocated overhead per hire is **<$5**.

---

## 2. Per-stage funnel cost waterfall

To produce **one hire**, a typical role moves the following number of candidates through each stage. Conversion rates are industry baselines for tech roles, calibrated to L3xy's funnel design.

<!--FUNNEL-->

| Stage | Candidates | Per-candidate cost | Stage subtotal |
|---|---:|---:|---:|
| Sourced (Tier 3 worst case) | 200 | $0.24 | $48.00 |
| Screened | 100 | $0.05 | $5.00 |
| Verified | 50 | $0.02 | $1.00 |
| Outreached (incl. emails) | 40 | $0.043 | $1.72 |
| Replied positively | 12 | — | — |
| Scheduled | 8 | $0.01 | $0.08 |
| Interviewed (incl. proctoring + storage + TURN) | 6 | $4.28 | $25.68 |
| Anti-ghost (across all outreached) | 40 | $0.02 | $0.80 |
| ICP setup (amortized) | 1 job | $0.05 | $0.05 |
| Comms & infra overhead | — | — | ~$3.00 |
| **TOTAL — new tenant (100% Tier 3)** | | | **~$85.33** |

### Mature-tenant case (50% Tier 1, 30% Tier 2, 20% Tier 3)

| Source | Candidates | Per-candidate cost |
|---|---:|---:|
| Tier 1 (warm pool) | 100 | $0.00 (no external sourcing) |
| Tier 2 (platform pool) | 60 | $0.00 (intro infrastructure already paid) |
| Tier 3 (external) | 40 | $0.24 = $9.60 |

Replace the $48 sourcing line with $9.60. Total drops to **~$47**.

### Network-mature case (year 2+, 70% Tier 1+2)

Sourcing collapses to ~$5 in external spend. Total: **~$42**.

---

## 3. Cost-per-hire trajectory

This is the chart that matters for the investor narrative.

<!--TRAJECTORY-->

| Tenant maturity | Tier-3 share | Cost per hire | YoY change |
|---|---:|---:|---:|
| Month 1 (cold start) | 100% | **$85** | — |
| Month 6 | 50% | **$57** | -33% |
| Month 12 | 25% | **$47** | -45% from start |
| Month 24 (network-mature) | 10% | **$42** | -51% from start |

Compare this to LinkedIn Recruiter, HireEZ, Eightfold — all of whose marginal sourcing cost **rises** with usage because every search hits paid external APIs. L3xy's curve goes the other way. **This is the moat in financial form.**

---

## 4. Market price reference (US baseline)

What does the customer pay today, with whom, for what? **The numbers below are US-centric.** See §9 for regional benchmarks and pricing (and §7 for the hire-attribution layer that makes any of this billable in the first place) — customer willingness-to-pay swings 10-50× across markets.

| Solution | Price | Per-hire cost to customer |
|---|---|---|
| **In-house recruiter** (loaded) | ~$120K/yr salary + tools | ~$4,700/hire (SHRM 2023) |
| **Agency / contingency** | 15-25% of first-year salary | $12K-$25K (tech roles) |
| **LinkedIn Recruiter Lite** | $1,680/seat/yr | Sourcing only |
| **LinkedIn Recruiter Corporate** | $10K-15K/seat/yr | Sourcing only |
| **Greenhouse ATS** | $6K-$25K/yr | Workflow only |
| **HireEZ / Eightfold** | $12K-$50K/seat/yr | AI-assisted sourcing |
| **Paradox** | $25K-$100K+/yr enterprise | Conversational AI |

**Customer willingness-to-pay framing:** if L3xy reduces a customer's per-hire cost from $4,700 to $1,500 (still saving them $3,200), they will gladly pay us $1,500. Our cost is $50. Margin: ~97%.

The strategy isn't to capture all the value — it's to price aggressively, win the network, and let the platform pool become the moat that prevents anyone from undercutting us.

---

## 5. Pricing strategy — three models

### Model A · Per-seat SaaS (familiar, slow growth)

| Tier | Price | Includes |
|---|---|---|
| Starter | $499 / seat / mo | 5 active jobs · 50 AI interviews/mo · email outreach |
| Pro | $999 / seat / mo | Unlimited jobs · 200 interviews/mo · SMS · platform pool consume |
| Enterprise | Custom (~$2K+ /seat /mo) | SSO, custom proctoring, white-label client portal, SLA |

**Pros:** Predictable revenue. Familiar buying motion. Easy to forecast.
**Cons:** Caps growth. Doesn't reward heavy users. Doesn't accelerate the platform pool flywheel.

### Model B · Per-hire success fee (sales-friendly, variable)

- **$500-$2,000 per successful hire** (~15-25% of typical agency fee)
- Free pipeline. You pay when they sign the offer letter.
- Tier by company size or salary band.

**Pros:** Magical sales pitch ("only pay when you win"). Easy to displace agencies.
**Cons:** Cash-flow drag. Hard to forecast. Customers game it (e.g., contractor extensions to dodge fee).

### Model C · Hybrid (recommended) ★

| Component | Price | Why |
|---|---|---|
| **Platform fee** | $799 / mo per organization | Covers infra + warm pool access; signals commitment |
| **Per-seat add-on** | $199 / mo per recruiter seat | Soft cap on scale |
| **Per-hire success bonus** | $250 per signed offer | Aligns incentives, low friction |
| **AI interview overage** | $15 each above 100/mo included | Variable matches our variable cost |
| **Cross-tenant platform-pool consume** | Pro tier only ($1,499/mo platform fee) | Network effect gating |

**Example customer P&L (mid-market):**
- 1 organization, 5 recruiters, 30 hires/year, 800 AI interviews/year
- Revenue: $799×12 + $199×5×12 + $250×30 + $15×(800−1200, capped at 0) = **$9,588 + $11,940 + $7,500 + $0 = $28,528 / year**
- Our cost (mature tenant): 30 hires × $47 = $1,410 + interview overhead amortized ≈ **$3,200**
- **Gross margin: ~89%**

**Pros:** Captures recurring base + usage upside. Aligns with customer success. Doesn't punish heavy or light users disproportionately.
**Cons:** Three line items requires a clean billing surface.

### Model D · Free → paid funnel (growth play)

| Tier | Price | Includes |
|---|---|---|
| Free | $0 | 1 active job · 50 candidates/mo · platform pool **share required** |
| Growth | $799 / mo | 10 active jobs · 500 candidates/mo · platform pool consume |
| Scale | $2,499 / mo | Unlimited · priority support · custom branding |
| Enterprise | Custom | Full white-label, SLA, on-prem option |

The key strategic move: **Free tier requires opting into the platform pool (Tier 2 sharing).** Free tenants donate their warm pool to the network in exchange for using L3xy. Growth+ tenants get to consume that pool.

**Pros:** Maximum platform-pool growth velocity. Aggressive land-and-expand. Compounds the moat fastest.
**Cons:** Free-tier abuse risk. Slower revenue ramp. Sales motion harder.

---

## 6. Recommended pricing — Hybrid (Model C) with Free-tier on-ramp

Combine the best of C and D:

| Tier | Monthly | Per Seat | Per Hire | Platform Pool |
|---|---|---|---|---|
| **Free** | $0 | $0 | $0 | Share required, no consume |
| **Starter** | $399 | $99 | $250 | Share + consume |
| **Pro** ★ | $799 | $199 | $250 | Share + consume + priority |
| **Scale** | $1,999 | $149 | $150 | Full + cross-org analytics |
| **Enterprise** | Custom | Custom | Negotiated | Custom + on-prem option |

**Why this wins:**
1. Free tier acquires tenants and grows the platform pool — the moat compounds at zero CAC.
2. $250/hire success fee aligns to outcomes without spooking buyers (vs. $2,000+ agency fees).
3. Per-seat add-on captures scale-up revenue without punishing single-recruiter shops.
4. Volume discount at Scale tier (per-hire drops to $150) keeps enterprise customers from feeling penalized.
5. Platform pool gating (Pro+) makes the Pro tier the natural upgrade target.

---

## 7. Hire attribution & billing — the integrity layer

> **Brutal honest assessment (May 2026):** L3xy today **cannot reliably bill per hire.** We have a `hired` pipeline stage and a state machine that prevents skipping it, but no `hired_at` timestamp, no offer letter capture, no candidate-side confirmation, no Stripe integration, no invoicing, no ATS-sync verification, and no fraud-detection layer. A dishonest customer who hires a candidate we sourced and quietly moves them to "rejected" in our UI gets the hire for free. This section is the blueprint to close that gap.

The per-hire success-fee model is what makes our unit economics work. It is also the highest-fraud-risk billing model in B2B SaaS — recruiters are commercially incentivized to under-report, and "we hired them through another channel" is the world's most common dispute. **Solving this is existential, not optional.**

### 7.1 The "people lie" problem — categorized

| Failure mode | What happens | Frequency we should assume |
|---|---|---|
| **Silent hide** | Recruiter moves a candidate we sourced to "rejected" or just stops engaging, then hires them off-platform | High |
| **Channel-shopping** | Recruiter claims "they applied directly via our careers page after seeing your email" — technically true, attribution disputed | Very high |
| **Delayed hide** | Candidate gets hired but Mark Hired is delayed 90+ days "until they pass probation" | High |
| **Stage downgrade** | Application moves to `offer`, then back to `interview`, then quietly disappears | Moderate |
| **Tenant-side outage** | Tenant team doesn't update L3xy for weeks; hires happen, we don't know | Universal |
| **Cross-tenant theft** | Agency tenant places candidate at *their* client, claims it wasn't a placement *they* did | Moderate |
| **Renegotiation lever** | Customer disputes a perfectly real hire to negotiate down fees | Frequent at renewal |

**Mitigation principle:** No single "Mark Hired" event can be ground truth. Attribution must be **triangulated from many independent signals**, most of them outside the customer's control to manipulate.

### 7.2 The multi-signal attribution model

<!--ATTRIBUTION-->

We treat hire detection as a **confidence score**, not a binary. A score of ≥ 80 auto-bills. Scores 50-79 surface a manual confirmation dialog (Stripe-style "we noticed activity that looks like a hire — confirm or dispute within 14 days"). Below 50, we flag for sales-ops human review.

| Signal | Confidence weight | Source | Customer-controllable? |
|---|---:|---|---|
| **Recruiter clicks "Mark Hired"** | 30 | In-app action | Yes (low trust) |
| **Application reaches `offer` then `hired`** | 20 | Pipeline state machine | Yes (low trust) |
| **Offer letter uploaded** (PDF parsed for salary/start date) | 15 | UI upload + LLM extraction | Mostly |
| **E-signature webhook** (DocuSign / Dropbox Sign / PandaDoc) | **40** | Direct integration | Hard to fake |
| **ATS push + ATS webhook** (Greenhouse / Lever / Ashby / Workday) | **45** | OAuth integration | No (ATS is source of truth) |
| **Background check triggered** (Checkr, GoodHire) | 25 | Integration | Hard to fake |
| **Reference check requests sent via L3xy** | 15 | In-app | Mostly |
| **Candidate self-confirmation email** | 30 | Outbound from L3xy: *"Did you accept the role at [Company]?"* | No |
| **Email thread phrase detection** ("I accepted", "first day Monday", "welcome to") | 20 | Inbox sync (with consent) | No |
| **LinkedIn drift detection** — candidate now lists tenant company as employer within 90 days of last L3xy touch | **50** | Existing `linkedin-profile-monitor.ts` | **No — this is the killer signal** |
| **Public hiring announcement scan** (press releases, LinkedIn posts) | 25 | SerpAPI / LinkedIn scraper | No |
| **Calendar invite for "first day" / "orientation"** | 20 | Calendar integration | No |
| **Payroll/onboarding webhook** (Rippling, Gusto, Deel) | **50** | Integration | **No — gold standard** |

**Combined attribution rule (`hire-attribution-engine.ts`, to be built):**
- Run continuously (every 6h) for any candidate who reached `screening` or beyond.
- Sum signal weights observed within an **18-month attribution window** from first L3xy touch.
- Score ≥ 80 → auto-bill; emit `hire.confirmed` event; trigger Stripe usage record.
- Score 50-79 → emit `hire.suspected`; email customer confirmation request; 14-day clock.
- Score < 50 → quarterly batch review.

### 7.3 The originating-touch lock (contractual + technical)

Beyond multi-signal detection, the contract itself does heavy lifting:

> *"Any Candidate first surfaced to Customer through the L3xy Platform — including via Sourcing, Screening, Outreach, or Platform Recommendations — and subsequently Hired by Customer (or by any of Customer's clients in the case of agency Customers) within eighteen (18) months of such first surfacing, regardless of the channel through which the Hire is ultimately formalized, shall constitute a Billable Hire under this Agreement."*

**Technical implementation:** every candidate-tenant pair gets an `originatingTouchAt` timestamp the first time the candidate appears in that tenant's pool. The 18-month window starts from that timestamp. The LinkedIn drift monitor (already built) is what detects the off-platform hire — if the candidate's current employer matches a tenant who saw that candidate within 18 months, the attribution engine fires.

This is the single most important sentence we will ever put in a customer contract. **Without it, the fraud surface is unbounded. With it, every off-platform hire becomes detectable through LinkedIn alone.**

### 7.4 Audit infrastructure (build now, regardless of billing)

Several gaps in the current audit trail need closing immediately because they're cheap and protect us in disputes:

| To build | File | Purpose |
|---|---|---|
| Add `hired_at`, `offer_extended_at`, `offer_accepted_at`, `attribution_score`, `attribution_signals[]` columns | `lib/db/schema/applications.ts` migration | Forensic record |
| Call `recordAudit()` on every stage transition into `offer` and `hired` | `routes/applications.ts` PUT handler | Immutable trail |
| Webhook receivers for DocuSign, Dropbox Sign, Greenhouse, Lever, Ashby, Rippling, Gusto, Checkr | `routes/webhooks/` | External corroboration sources |
| Candidate self-confirmation email automation triggered by stage = `offer` | new `hire-confirmation-engine.ts` | Independent candidate-side signal |
| LinkedIn drift cross-check on attribution candidates at 30/60/90/180 days post-last-touch | extend `linkedin-profile-monitor.ts` | Off-platform hire detection |
| `hire_attribution_events` table with full signal log per candidate-tenant-job | new schema | The bill-defense audit log |

### 7.5 Billing mechanics (the build to ship)

**Stripe stack:**
- **Stripe Billing** for monthly subscription fees (Pro $799/mo, etc.) — straightforward subscription objects, customer portal for self-serve.
- **Stripe Usage-Based Billing** for per-hire fees — meter the `hire.confirmed` event into a Stripe Usage Record. Monthly invoice rolls subscription + usage into a single line.
- **Stripe Tax** for global VAT/GST handling (especially Europe and India GST).
- **Local rails** where Stripe is weak: Razorpay for India INR billing, Pix for Brazil, Flutterwave/Paystack for Africa.

**Implementation phases:**

| Phase | Build | Effort estimate |
|---|---|---|
| **Phase 1 — minimum viable billing** (~2 weeks) | Stripe subscription billing, manual hire-event entry by sales-ops, monthly invoicing | Low |
| **Phase 2 — attribution engine v1** (~4 weeks) | `hire-attribution-engine.ts`, hired-at timestamps, audit calls, candidate self-confirmation email, e-signature webhook receivers (DocuSign + Dropbox Sign) | Medium |
| **Phase 3 — ATS integrations** (~6 weeks) | Greenhouse, Lever, Ashby, Workday OAuth + webhook ingestion. This is where attribution becomes high-confidence for enterprise customers. | Medium-high |
| **Phase 4 — LinkedIn drift cross-attribution** (~2 weeks) | Extend existing `linkedin-profile-monitor.ts` to flag drift events where the candidate's new employer matches a tenant in the 18-month window. **Highest leverage per dev hour of any item in this list.** | Low |
| **Phase 5 — payroll / HRIS integrations** (~6 weeks) | Rippling, Gusto, Deel, BambooHR webhook receivers. Gold-standard attribution for SMB customers using these systems. | Medium |
| **Phase 6 — Stripe usage metering + dispute workflow** (~3 weeks) | Auto-meter `hire.confirmed` to Stripe Usage Records. Build the 14-day dispute UI. Integrate with audit log for evidence presentation. | Medium |

**Total to a defensible billing system: ~5-6 months of focused engineering.** Phase 1+4 alone (4 weeks total) gets us to a credible "we caught you" position on most disputes via LinkedIn drift detection — that should be the immediate priority.

### 7.6 Operational defenses

Beyond technology:

1. **Quarterly attribution audit emails to customers.** "Per our records, the following candidates were active in your L3xy pipeline in the last 90 days. If any have been hired off-platform, please confirm." Forces honest annotation while it's fresh.
2. **Renewal-time reconciliation.** At every renewal, run a full LinkedIn drift sweep on all candidates the tenant ever touched. Surface any matches as part of the renewal conversation.
3. **Sales-ops "bill-back" workflow.** When LinkedIn drift detects an attributable hire that wasn't billed, sales-ops issues a back-billing invoice with the evidence packet (signal log + LinkedIn snapshot + first-touch timestamp). Customer can dispute within 14 days with counter-evidence.
4. **Public LinkedIn announcement scraper.** Engineering hires especially get announced ("Excited to join [Company] as Staff Engineer"). SerpAPI sweep at low cost.
5. **DNC + privacy compliance.** Every candidate-side confirmation email and LinkedIn check honors the existing DNC promise. Attribution is not a license to spam.

### 7.7 The economic case for building this now

| Scenario | Annual revenue (100 mid-market customers, 30 hires each) | Loss from un-tracked hires |
|---|---:|---:|
| **Today (no attribution)** | $99 × 12 × 100 platform = ~$120K (subscription only) | We collect $0 of the $750K in per-hire fees we earned |
| **Phase 1+4 only** (LinkedIn drift) | ~$120K + ~60% of $750K = **$570K** | $300K still leaking |
| **Phase 1-6 complete** | ~$120K + ~92% of $750K = **$810K** | $60K residual leakage (acceptable) |

**Building this is worth roughly $7,000 per customer per year in recovered revenue.** At 100 customers that's $700K ARR / year recovered, which pays for the entire 5-6 month build in the first quarter post-launch. The delta scales linearly with customer count — at 1,000 customers it's $7M ARR / year recovered.

> **The single most important takeaway of this document:** Building the hire attribution & billing layer is the highest-ROI engineering investment we can make in 2026. Everything else in the unit-economics model is theoretical until we can prove a hire happened and bill for it.

---

## 8. Sensitivity & risk

The above assumes 2026 LLM pricing. The two big sensitivities:

### 7.1 LLM cost trajectory

If frontier model prices fall 50% by 2027 (likely), our per-hire cost drops by ~$15-20 — margin expansion of ~3-4 percentage points without changing pricing.

If LLM pricing *rises* due to capacity constraints (less likely but possible), the AI interview line item ($3.50) is most exposed. We can fall back to text-only interviews ($0.30) at lower per-customer satisfaction but ~10× cost reduction.

### 7.2 External sourcing pricing

PDL and EnrichLayer have pricing power. If they raise rates 2× (a real scenario in a consolidating market), Tier 3 cost per candidate goes from $0.24 to $0.48. **For a mature tenant, this barely matters** — Tier 3 is 10-25% of sourcing. For a brand-new tenant it adds ~$50/hire (still 100× under market price).

This is exactly why the Living Talent Graph is the moat: it makes us *price-takers immune* to external API inflation.

### 7.3 Realistic worst-case cost-per-hire

Stack everything against us — frontier LLM doubles, PDL doubles, customer churns out before maturing — worst case is **~$170/hire**. Still a >70% gross margin at $500/hire pricing. The business model is robust.

---

## 9. Regional pricing & global markets

The L3xy product runs on USD-denominated infrastructure (LLM APIs, PDL, EnrichLayer, cloud compute) so our **marginal cost per hire is roughly flat across geographies — ~$45-$85 everywhere**. What changes dramatically is what customers will pay. A single global price (US-style $799/mo + $250/hire) leaves enormous TAM uncaptured outside North America and prices us out of the high-volume markets that are the fastest path to a global Living Talent Graph.

### 9.1 What customers pay today — by region

<!--REGIONS-->

| Region | In-house cost-per-hire | Agency norm | Local incumbent (price reference) |
|---|---|---|---|
| **United States / Canada** | $4,700 (SHRM) | 15-25% of first-year salary | LinkedIn Recruiter Corporate ~$10-15K/seat/yr |
| **United Kingdom** | £3,500-£5,000 | 15-25% | LinkedIn Recruiter ~£8-12K/seat/yr |
| **Western Europe (DE/FR/NL)** | €3,000-€4,500 | 20-30% (higher than US/UK) | StepStone, Personio recruiting modules ~€3-8K/yr |
| **Eastern Europe (PL/RO/CZ)** | €1,500-€2,500 | 15-20% | Pracuj.pl, eJobs, regional ATS €500-2K/yr |
| **Australia / New Zealand** | A$5,000-A$8,000 | 15-20% | Seek Talent Search ~A$8-12K/seat/yr |
| **GCC (UAE / Saudi / Qatar)** | $4,000-$8,000 (high salaries) | 15-25% | Bayt, GulfTalent ~$3-8K/yr |
| **Singapore / Hong Kong** | S$3,000-S$5,000 | 18-25% | JobStreet Premium ~S$3-6K/yr |
| **India** | ₹50K-₹150K (~$600-$1,800); tech roles ₹2-5L (~$2,400-$6,000) | **8.33% standard** (one month's salary) | Naukri RecruiterPlus ~₹50K-₹2L/yr (~$600-$2,400); LinkedIn Recruiter India ~$3K/seat/yr |
| **Pakistan / Bangladesh / Sri Lanka** | $300-$1,000 | 5-10% | Rozee.pk, Bdjobs ~$200-$800/yr |
| **SE Asia (PH / VN / ID / TH / MY)** | $500-$1,500 | 10-15% | JobStreet, Kalibrr, VietnamWorks ~$400-$2K/yr |
| **LATAM (BR / MX / AR / CO)** | R$4K-R$15K (~$800-$3,000) | 1-3 months' salary | Catho, Vagas.com, OCC Mundial ~$300-$1,500/yr |
| **Africa (NG / KE / ZA / EG)** | $400-$1,500 | 10-15% | LinkedIn (limited), BrighterMonday, MyJobMag ~$200-$800/yr |
| **Japan / South Korea** | ¥500K-¥1.5M (~$3,300-$10K) | 30-35% (highest globally) | Bizreach, Wantedly Direct Scout ~¥800K-¥3M/yr |

**Two regional patterns matter most:**
- **India + South Asia + Africa: agency fees are dramatically lower** (8.33% in India vs 15-25% in US), so the "we replace your agency" pitch lands smaller in absolute dollars but larger in *relative* savings vs. local incumbents like Naukri.
- **Japan/Korea: agency fees are dramatically higher** (30-35% of first-year salary). The agency-displacement pitch is *most* lucrative here per hire — but sales cycles are long, and Bizreach is entrenched.

### 9.2 Recommended regional pricing — Pro tier reference

We hold the global product unchanged and let pricing flex. PPP-adjusted, currency-localized, billed in local currency where Stripe/local rails support it.

| Region | Platform fee / mo | Per seat / mo | Per hire | Currency | vs US (PPP-adjusted) |
|---|---:|---:|---:|---|---|
| **US / Canada** | $799 | $199 | $250 | USD | baseline |
| **UK** | £649 | £159 | £199 | GBP | ~equal |
| **Western Europe** | €749 | €179 | €230 | EUR | ~equal |
| **Australia / NZ** | A$1,199 | A$299 | A$375 | AUD | ~equal |
| **Eastern Europe** | €399 | €99 | €120 | EUR | -45% |
| **GCC** | $799 | $199 | $250 | USD | ~equal (high salaries support US pricing) |
| **Singapore / HK** | S$899 | S$229 | S$299 | SGD | ~equal |
| **Japan** | ¥99,000 | ¥24,000 | ¥35,000 | JPY | ~equal (agency fees are higher, room to push) |
| **South Korea** | ₩999K | ₩249K | ₩330K | KRW | ~equal |
| **LATAM** | $349 | $89 | $120 | USD/local | -55% |
| **India** | **₹14,999** (~$180) | **₹2,999** (~$36) | **₹2,500** (~$30) | INR | -75% |
| **Pakistan / Bangladesh / Sri Lanka** | ~$99 | ~$24 | ~$20 | USD | -85% |
| **SE Asia (PH/VN/ID/TH/MY)** | $249 | $59 | $80 | USD/local | -65% |
| **Africa (NG/KE/ZA/EG)** | $179 | $39 | $50 | USD | -75% |

> **Pricing principle:** We are not racing local players to the bottom — we are pricing at **roughly 30-50% of the local incumbent's per-seat fee** and replacing 1.5-2× the work. The customer still saves money vs. their current spend, and we still earn a healthy gross margin because our cost-per-hire is the same everywhere.

### 9.3 Regional unit economics — typical mid-market customer (5 seats, 30 hires/year)

| Region | Annual revenue (Pro) | Our cost (mature) | Gross margin |
|---|---:|---:|---:|
| US / Canada | $9,588 + $11,940 + $7,500 = **$29,028** | ~$1,410 + ~$1,800 infra | **~89%** |
| UK | £7,788 + £9,540 + £5,970 = **£23,298** (~$28,500) | ~$1,800 | **~88%** |
| Western Europe | €8,988 + €10,740 + €6,900 = **€26,628** (~$28,800) | ~$1,800 | **~88%** |
| Singapore / GCC / Japan | ~$28,000-$32,000 | ~$1,800 | **~88%** |
| LATAM | $4,188 + $5,340 + $3,600 = **$13,128** | ~$1,800 | **~76%** |
| Eastern Europe | €4,788 + €5,940 + €3,600 = **€14,328** (~$15,500) | ~$1,800 | **~78%** |
| **India** | ₹179,988 + ₹179,940 + ₹75,000 = **₹434,928** (~$5,200) | ~$1,800 | **~52%** |
| SE Asia | $2,988 + $3,540 + $2,400 = **$8,928** | ~$1,800 | **~71%** |
| Africa | $2,148 + $2,340 + $1,500 = **$5,988** | ~$1,800 | **~63%** |
| Pakistan / South Asia | $1,188 + $1,440 + $600 = **$3,228** | ~$1,800 | **~44%** |

**Key reads:**
- Tier-1 markets (NA, UK, EU, GCC, ANZ, JP/KR): **>85% gross margin** — same model, same prices in PPP-adjusted local currency.
- Mid-tier markets (LATAM, EE): **~75-80%** — perfectly viable.
- High-volume / strategic markets (India, SE Asia, Africa): **~50-70%** — lower per-customer margin, but **massive volume potential** and these are the markets where the platform pool grows fastest.
- Lowest-tier (Pakistan, smaller South Asia): **~45%** — operate near break-even to seed the pool. Treat as customer-acquisition spend.

### 9.4 Why low-margin regions are still strategic

The Living Talent Graph is a **network**. Every tenant adds candidates to the platform pool. A ₹14,999/mo Indian customer adding 200 tech candidates a month is *more strategically valuable* to the network than a $799/mo US customer adding 30 — because:

1. **Pool depth wins searches.** A US recruiter searching for "Bangalore-based React engineer" gets results because the Indian tenants seeded the pool.
2. **Cross-border placements are the highest-margin transactions.** A US tenant hiring an Indian engineer pays full US per-hire pricing ($250) on a candidate that Indian tenants effectively contributed at zero CAC.
3. **PPP-priced markets compound the platform pool 5-10× faster** because more customers can afford to be on it.

**Strategic recommendation:** Treat Tier-1 markets as the revenue engine and South Asia / SE Asia / Africa as the **pool-growth engine**. Each subsidizes the other; together they form the moat.

### 9.5 Local sales motion considerations

| Market cluster | Sales motion | Payment rails | Customer support hours |
|---|---|---|---|
| NA / UK / ANZ | PLG + inside sales | Stripe USD/GBP/AUD | English, US/UK timezones |
| Western Europe | Inside sales, GDPR-first messaging | Stripe EUR + SEPA | English + DE/FR support tier |
| Eastern Europe | PLG, low-touch | Stripe EUR | English |
| GCC | Field sales, relationship-led | Stripe USD + local invoicing | English/Arabic, GMT+3/4 |
| Japan / Korea | Partner-led (long sales cycles) | Local invoice + bank transfer | JA/KO required, GMT+9 |
| India | PLG + Free tier acquisition + inside sales | Stripe INR + Razorpay backup | English + Hindi tier, IST |
| Pakistan / Bangladesh / Sri Lanka | PLG only, Free tier emphasized | Stripe USD (where supported) + Wise | English |
| SE Asia | PLG + regional partnerships (JobStreet integrations) | Stripe USD/SGD + GrabPay/local | English, regional timezones |
| LATAM | PLG + inside sales | Stripe USD/BRL/MXN + Pix in BR | EN/PT/ES, GMT-3 to -6 |
| Africa | PLG only, mobile-first UX critical | Stripe USD + Flutterwave/Paystack | English (FR for francophone) |

### 9.6 Phased global rollout

| Phase | Markets | Rationale |
|---|---|---|
| **Phase 1 (now)** | US, Canada, UK, Australia, India | Highest English-language LTV (NA/UK/AU) + highest pool-growth velocity (India) |
| **Phase 2 (+6 mo)** | Singapore, UAE, Western Europe (DE/FR/NL) | High-margin Tier-1 expansion; Singapore as APAC HQ |
| **Phase 3 (+12 mo)** | SE Asia (PH/VN/ID), LATAM (BR/MX), South Africa | Volume + pool-growth markets; partner with regional job boards |
| **Phase 4 (+18 mo)** | Eastern Europe, Japan, Korea | Localized UX & language support requirements |
| **Phase 5 (+24 mo)** | Pakistan, Bangladesh, Sri Lanka, broader Africa | Free-tier-first, near-cost pricing, pool-growth play |

---

## 10. Partnership revenue share & channel economics

The fastest way to populate the Living Talent Graph globally is **not** by hiring a 50-country sales team — it's by sharing the upside with partners who already own the customer relationships in those markets. This section defines the partnership program: who we share revenue with, how much, why it still works financially, and how we track attribution so partners actually get paid.

### 10.1 Why partnerships are central to the model

1. **Distribution.** Naukri, JobStreet, Bayt, Catho already own the recruiter relationship in their regions. We don't need to displace them — we need to be inside their tooling.
2. **Pool growth.** Each agency/RPO partner brings a candidate book that seeds the platform pool. An RPO running 200 hires/month generates 5,000+ candidates/month into the Living Graph.
3. **Enterprise reach.** Deloitte, Accenture, Korn Ferry, and regional SIs sell into accounts we cannot reach directly with PLG. Their fee is small relative to the ARR they unlock.
4. **Capital efficiency.** Channel CAC is fundamentally lower than direct CAC. A 25% lifetime rev share is cheaper than building inside-sales infrastructure for the same volume.

<!--PARTNERS-->

### 10.2 Partner types & rev-share structure

| Partner type | Target segment | Typical rev share | Term | What they bring | What we provide |
|---|---|---:|---|---|---|
| **Staffing agency / RPO** (white-label or co-branded resale) | SMB & mid-market direct hires | **30-40%** | Lifetime of customer | Existing recruiter relationships, candidate book | White-label UI, training, partner portal, MDF |
| **HR consultancy / SI** (Deloitte, Accenture, regional firms) | Enterprise (1,000+ employees) | **20-30%** | First 24 months | Enterprise sales motion, change-mgmt services | Co-sell support, SE resources, deal registration |
| **Regional reseller** (markets we have no presence in) | Regional SMB & mid-market | **30-40%** | Lifetime | Local language, currency, support, sales | Reseller portal, localized product, training |
| **ATS marketplace integration** (Greenhouse, Lever, Ashby, Workday) | Their installed base | **15-25%** | First 12 months | Distribution to thousands of orgs | Native integration, marketplace listing |
| **HRIS embedded partner** (Rippling, Gusto, Deel, BambooHR) | Their SMB customers | **20-30%** or revenue swap | Lifetime | Embedded distribution into HRIS workflow | Embedded experience, white-label option |
| **Job board partner** (Naukri, JobStreet, Bayt, Catho, Seek) | Their recruiter base | **20-30%** | Lifetime | Massive recruiter audience, regional brand | Co-branded "Smart Sourcing" feature, integration |
| **Affiliate / community / influencer** (HR thought leaders, newsletters, Slack communities) | Long tail | **15-20% first 12 mo** OR **$500-2K flat per signup** | First year | Top-of-funnel awareness | Tracking link, creative assets, leaderboard |
| **Tech integration partner** (background-check, e-sign, video-interview) | Cross-sell base | **Mutual referral** (10-15% each way) | Lifetime | Cross-sell distribution | Reciprocal listings + integration |

### 10.3 Margin impact at each rev-share level

Using the **mid-market customer @ Pro tier** (5 seats, 30 hires/year) reference customer from §9:

| Region | Direct ARR | Our cost | Direct margin | After 25% rev share | After 35% rev share |
|---|---:|---:|---:|---:|---:|
| US / Canada | $29,028 | ~$1,800 | **89%** | $19,971 net → **91% net margin** | $17,068 net → **89% net margin** |
| Western Europe | ~$28,800 | ~$1,800 | 88% | ~$19,800 net → **91% net margin** | ~$16,920 net → **89% net margin** |
| India | $5,200 | ~$1,800 | 52% | $3,900 net → **54% net margin*** | $3,380 net → **47% net margin*** |
| SE Asia | $8,928 | ~$1,800 | 71% | $6,696 net → **73% net margin** | $5,803 net → **69% net margin** |

> *India example: $5,200 × 0.75 = $3,900 net to L3xy. Of that, $3,900 - $1,800 cost = $2,100 contribution. $2,100 / $3,900 = **54% net margin** on the *retained* revenue. Partner takes the other $1,300 entirely as their margin (their cost to acquire and serve the customer is borne by them, not us).

**Counter-intuitive but critical insight:** **net margin on partner-sourced revenue is actually equal to or better than direct margin** because we don't bear the CAC, sales rep cost, or local support cost — the partner does. The 25-35% we share is essentially CAC-as-a-service.

### 10.4 Partner tier program — "L3xy Partner Network"

A formal three-tier program creates clear progression and concentrates investment on the partners that are actually producing. Tiers reset annually based on trailing-12-month L3xy-attributed ARR.

| Tier | Threshold (TTM L3xy ARR) | Rev share | Co-sell support | MDF | Other benefits |
|---|---:|---:|---|---|---|
| **Silver** | $0 - $50K | 20% lifetime | Self-serve only | None | Partner portal, training, tracking links |
| **Gold** | $50K - $250K | 25% lifetime | 1 partner manager (shared) | Up to $5K/yr | Marketplace listing, deal registration, beta features |
| **Platinum** | $250K+ | 30% lifetime + 5% accelerator on net-new logos | Dedicated partner manager + SE | Up to $25K/yr | Quarterly biz reviews, joint roadmap input, exec sponsorship, lead-share from L3xy direct pipeline |

**Special tier — Anchor Partners** (negotiated, e.g., a national ATS or RPO): up to **40% rev share + co-marketing investment**, in exchange for exclusivity in a region or integration depth (native embedded experience). Used sparingly — these are strategic agreements signed with the CEO, not the partner team.

### 10.5 Partner attribution & payment infrastructure

This re-uses the §7 multi-signal attribution engine. Same architecture, different signals.

| Signal | Weight | Source |
|---|---:|---|
| **Partner-specific signup link** (`l3xy.com/?ref=naukri-2026`) | 60 | URL attribution cookie + DB write |
| **Deal registration submitted by partner** (before customer signs) | 50 | Partner portal |
| **OAuth-style partner-mediated tenant creation** (partner's app provisions the tenant via API) | **80** | Partner API |
| **Co-sell email thread present in customer's communication history** | 25 | Email-domain match |
| **Customer self-attribution at signup** ("How did you hear about us?" → partner) | 15 | Onboarding form |

A customer is **partner-attributed** if total partner-signal weight is ≥ 50 within a 90-day attribution window from partner first touch. Once attributed, the partner earns rev share for the agreed term (lifetime or first-12-months).

**Schema additions** (extends `update_db.sql`):
- `partners` table (id, name, tier, default_rev_share, contact, payout_method, stripe_connect_id)
- `partner_attribution_events` (mirrors `hire_attribution_events`)
- `tenants.partner_id` + `tenants.partner_rev_share_pct` + `tenants.partner_attribution_term` columns
- `partner_payouts` table (period, gross_attributed_revenue, share_pct, payout_amount_cents, stripe_payout_id, status)

**Payment mechanics:**
- Stripe Connect for partner payouts — onboarding via OAuth, payouts via Express accounts.
- Monthly payout, net 30 (calculated on collected revenue, not invoiced — protects against churn-back).
- Partner portal shows: pipeline (open deals), active customers, MTD/QTD/YTD attributed ARR, expected vs. paid commission, dispute log.
- Tax compliance: 1099 generation in US, equivalent forms in other jurisdictions; Stripe Tax handles the heavy lifting.

### 10.6 The economic case — partner-led GTM at scale

Modeled scenario: **200 customers acquired in Year 1 via partners**, average customer = mid-market global blend (~$15,000 ARR), average rev share = 25%.

| Line item | Direct GTM | Partner GTM | Delta |
|---|---:|---:|---:|
| Gross ARR (200 customers) | $3.0M | $3.0M | — |
| Sales/marketing cost (CAC) | $1.5M (CAC ~$7,500/customer typical SaaS) | **$0** (partner bears cost) | -$1.5M |
| Partner rev share paid | $0 | $750K (25%) | +$750K |
| Customer support cost | $300K | $200K (partners handle Tier-1) | -$100K |
| Infra / COGS | $360K | $360K | — |
| **Net contribution** | **$840K (28%)** | **$1.69M (56%)** | **+$850K** |

Partner-led GTM produces **roughly 2× the contribution margin per dollar of revenue** at this stage, even after the 25% share. The crossover only inverts at very large customer ARR ($100K+) where the direct sales cost amortizes well — so the model is: **partner-led for SMB and mid-market, direct for enterprise.**

### 10.7 Margin floors, regional caps, and the kill-switch — making sure we don't go broke

A flat global rev-share scheme would bankrupt the partner program in low-margin regions. The 25-35% numbers in §10.2 work fine in Tier-1 markets, but they push Pakistan, Bangladesh, and parts of Africa into negative territory. This section defines the guardrails.

#### Hard floor: 35% net margin or no rev share

Every payout calculation is gated by this rule:

> **L3xy net margin on the customer's revenue, after rev share, must remain ≥ 35%.** If a proposed share would drop net margin below 35%, the share is automatically capped at the level that preserves 35%, with the customer flagged for manual partner-program review at quarter-end.

This is enforced by a database constraint on `partner_payouts.payout_amount_cents` calculated against `tenant.gross_collected_cents` and `tenant.cogs_cents` for the period.

#### Regional rev-share caps (override the §10.2 ranges)

Rev share scales **down** as customer ARR scales down. Tier-1 markets absorb 30-40%; Tier-3 markets cannot. The published `default_rev_share` in the partner contract is regionally indexed:

| Region | Max rev share — agency/RPO/reseller | Max — affiliate/community | Per-customer payout floor (no payout below this collected revenue) |
|---|---:|---:|---:|
| US / Canada / UK / ANZ / GCC / JP-KR | 35% | 20% | $0 (no floor) |
| Western Europe | 30% | 18% | $0 |
| Singapore / HK | 30% | 18% | $0 |
| Eastern Europe | 25% | 15% | $300 |
| LATAM | 25% | 15% | $250 |
| **India** | **20%** | **12%** | **₹15,000 (~$180)** |
| SE Asia | 20% | 12% | $200 |
| Africa | 15% | 10% | $200 |
| **Pakistan / Bangladesh / Sri Lanka** | **Flat fee only — $40-60 per paying signup** (no % share) | $25-40 flat | n/a |

> **Why flat fees in the lowest tier:** at Pakistan ARR (~$3,228), even a 10% share leaves us with ~14% contribution margin per customer — below the operational cost of administering the partner relationship. We pay a one-time flat acquisition fee instead, and the customer's lifetime value flows entirely to L3xy.

#### Break-even sensitivity — where does each region go negative?

For a mid-market Pro customer (5 seats, 30 hires/yr) with COGS of $1,800/yr:

| Region | ARR | Cost | Direct margin | Rev share that hits **35% net floor** | Rev share that hits **0% (break-even)** |
|---|---:|---:|---:|---:|---:|
| US / Canada | $29,028 | $1,800 | 89% | **>50%** (room to spare) | ~94% |
| Western Europe | $28,800 | $1,800 | 88% | >50% | ~94% |
| Singapore / GCC / Japan | ~$28,500 | $1,800 | 88% | >50% | ~94% |
| Eastern Europe | $15,500 | $1,800 | 88% | ~46% | ~88% |
| LATAM | $13,128 | $1,800 | 86% | ~38% | ~86% |
| **India** | $5,200 | $1,800 | 65% | **~24%** | ~65% |
| SE Asia | $8,928 | $1,800 | 80% | ~30% | ~80% |
| Africa | $5,988 | $1,800 | 70% | ~17% | ~70% |
| **Pakistan / Bangladesh / SL** | $3,228 | $1,800 | 44% | **~7%** (essentially zero) | ~44% |

Reading the table: in India, we can pay up to 24% rev share before our net margin drops below 35%. In Pakistan, the math doesn't even support 10% — hence the flat-fee model. **The §10.2 "30-40%" ranges only apply where the math allows it; in practice the regional caps in §10.7 are binding.**

#### Onboarding revenue floor (no payout on the first $X per customer)

The first 90 days of any new customer relationship cost L3xy real money: support tickets, onboarding calls, integration setup, free credits. Rev share starts only after the customer has cumulatively paid us **the equivalent of the regional per-customer payout floor** (last column of the table above). This protects against partners flooding the system with low-quality signups.

#### Spend-control mechanisms — keeping operational overhead minimal

| Mechanism | How |
|---|---|
| **Self-serve partner onboarding** | OAuth signup → automatic Stripe Connect Express creation → no human touch for Silver tier |
| **Batched monthly payouts** | One Stripe payout per partner per month — Stripe Express fees are flat per payout, so batching kills per-transaction fee dilution |
| **No MDF below Gold** | Silver tier gets training + portal only — zero cash spend |
| **Auto-generated 1099 / equivalent forms** | Stripe Connect handles US 1099s, equivalent forms in supported jurisdictions; zero accounting overhead |
| **Automated dispute resolution** | Same `attribution_disputes` workflow from §7 — partner submits evidence in portal, automated rules resolve 80%+ of cases without humans |
| **Hard MDF caps in contract** | Gold $5K/yr, Platinum $25K/yr, Anchor by deal — no exceptions, written into the partner agreement |
| **No co-marketing investment in Year 1** | Defer all co-branded content, events, ads until partner crosses Gold threshold ($50K TTM ARR) |
| **No dedicated CSM below Platinum** | Gold tier shares one partner manager across 20+ partners; Silver is fully self-serve |
| **Quarterly partner ROI review** | Any partner whose 12-mo gross attributed revenue × (1 - share %) - support cost - MDF spend < $0 is auto-demoted to Silver at the next quarterly review |

#### The kill-switch (unwind clause)

The partner agreement includes an explicit termination right:

> *"L3xy may terminate any Partner's status in the Partner Network with 30 days' notice if (a) the Partner's L3xy-attributed gross revenue over any trailing 12-month period is less than $0 net contribution to L3xy after sharing, support cost, and MDF spend, or (b) the Partner has been the originating party on any disputed attribution claim that was resolved in L3xy's favor on three or more occasions in any rolling 12-month period."*

Net effect: **no partner can bleed us indefinitely.** If a partner is net-negative for a year, we can drop them. If a partner repeatedly tries to claim attribution they don't deserve, we can drop them.

#### Summary — does the math work?

**Yes, but only with the regional caps and the 35% floor in place.** With the §10.7 guardrails:

- **Tier-1 customers** (US/UK/EU/JP/GCC/ANZ): direct margin 88-89% → after 30-35% share = **net margin 60-83%**. Comfortable.
- **Tier-2 customers** (LATAM, EE, Singapore): direct 80-86% → after 25% share = **net margin 73-81%**. Healthy.
- **Tier-3 customers** (India, SE Asia, Africa): direct 65-80% → after 12-20% share = **net margin 53-72%**. Acceptable.
- **Tier-4 customers** (Pakistan, Bangladesh, etc.): direct 44% → flat-fee partner model, no rev share → **net margin 44% retained**. Amortize partner acquisition cost over LTV.

Without these guardrails, the program loses money in Tier-3 and Tier-4. With them, every region clears 35% net margin. **Build the regional rev-share matrix into the database from day one — not as a future feature.**

### 10.8 Partner program rollout plan

| Phase | Partners | Effort | Expected ARR contribution by month 18 |
|---|---|---|---:|
| **Phase 0 (now → +60 days)** | Build partner portal, attribution engine, Stripe Connect onboarding, partner agreement templates | 4-6 weeks engineering + legal | — |
| **Phase 1 (+2 mo)** | Affiliate / influencer launch (low-touch, 15-20% first-year) | Marketing-led | ~$200K |
| **Phase 2 (+4 mo)** | ATS marketplace integrations (Greenhouse, Lever, Ashby) | 6 weeks engineering each | ~$500K |
| **Phase 3 (+6 mo)** | First 5-10 RPO / agency partners (handpicked, white-label) | Sales-led | ~$800K |
| **Phase 4 (+9 mo)** | Regional reseller deals (India, SE Asia, LATAM, GCC) — 1-2 per region | Sales-led, exclusive territories | ~$1.5M |
| **Phase 5 (+12 mo)** | HRIS embedded (Rippling, Gusto, Deel) — flagship partners | 8-12 weeks engineering each | ~$2M |
| **Phase 6 (+18 mo)** | SI / consultancy partnerships (Deloitte, Accenture, regional Big 4) for enterprise | Long sales cycle | ~$3M+ |

### 10.9 What we will NOT do

- **No double-dipping.** A customer can have at most one attributed partner. If two partners both have a claim, the deal-registration timestamp wins.
- **No back-dated rev share.** Rev share applies to attributed-after-launch customers, not the existing book.
- **No commission on partner-self-customers.** A partner can't sign themselves up as a customer through their own ref link to claim rev share.
- **No exclusivity by default.** Only Anchor Partners get territory or vertical exclusivity, and only with a minimum committed ARR.
- **No partner-rev-share on per-hire fees in Year 1.** Rev share applies to subscription only initially. Once the §7 attribution engine is mature (Phase 4-6 in §7), per-hire fees become eligible too.

> **Strategic recommendation:** Build the partner program as **Phase 0 of GTM, not Phase 5.** The attribution and payout infrastructure is ~6 weeks of engineering — comparable to a single major feature — but it unlocks every regional, vertical, and enterprise channel for the next decade. Build it before you need it.

---

## 11. Recommendations

1. **Build the hire-attribution & billing layer immediately** (see §7). This is the highest-ROI engineering investment in 2026 — without it, the per-hire fee model is theoretical. Phase 1 (Stripe subscription) + Phase 4 (LinkedIn drift cross-attribution) together are ~4 weeks and recover ~60% of leaked per-hire revenue.
2. **Launch with Model C (Hybrid) + Free tier.** Aggressive land-and-expand. Use the Free tier explicitly as a platform-pool acquisition channel.
3. **Don't optimize for margin in year one.** Optimize for *tenants on the network*. Each one makes the next one's pool bigger.
4. **Price regionally from day one** (see §9). A single global USD price is a strategic mistake — it gives up the world's biggest hiring markets to local incumbents. PPP-adjusted local pricing keeps us competitive globally without sacrificing Tier-1 margin.
5. **Treat India + SE Asia + Africa as pool-growth markets, not revenue markets.** Lower per-customer margin, higher strategic value. These regions feed the cross-border placement engine that produces the platform's highest-margin transactions.
6. **Publish a public ROI calculator on the marketing site.** "Replace your agency: enter your hiring volume, see your savings." Localize it per region — the agency-displacement story is huge in US/EU/JP and the Naukri-displacement story is huge in India.
7. **Negotiate volume discounts now with PDL and EnrichLayer.** At even modest scale (~100 tenants × ~200 Tier-3 candidates/mo) we move enough volume to halve list pricing.
8. **Re-price annually.** Track the cost trajectory chart religiously — when our cost-per-hire crosses $40, we have room to either drop price (defensive) or hold price and bank margin (offensive). Probably do the latter in Tier-1 markets; in Tier-3 markets, pass the savings to customers to widen the moat.
9. **Lock the 18-month originating-touch clause into every customer contract from contract v1.** This single sentence — combined with the LinkedIn drift monitor we already built — makes off-platform hires detectable and back-billable. It is the most important sentence in the entire commercial agreement.
10. **Build the L3xy Partner Network as Phase 0 of GTM, not Phase 5** (see §10). Six weeks of engineering for the partner portal, attribution engine, and Stripe Connect payouts unlocks regional, vertical, and enterprise channels for a decade. Partner-led GTM produces ~2× the contribution margin per revenue dollar at SMB/mid-market scale even after the 25% rev share, because the partner bears the CAC.

---

## Quick reference — one-pager

| Metric | Value |
|---|---|
| Cost per sourced candidate (mature tenant) | ~$0.10 |
| Cost per AI interview | ~$4.30 (incl. recording storage) |
| Cost per hire (new tenant) | ~$85 |
| Cost per hire (12-mo mature tenant) | ~$47 |
| Cost per hire (network-mature) | ~$42 |
| Recommended price per hire | $250 |
| Gross margin at recommended pricing | **~88%** |
| Customer market reference — US (in-house) | $4,700/hire |
| Customer market reference — US (agency) | $12K-$25K/hire |
| Customer market reference — India (agency, 8.33%) | $200-$500/hire (commodity), $2-5K (tech) |
| Customer market reference — Japan (agency) | 30-35% of salary, $3-10K+ |
| Mid-market customer ARR — US Pro tier | ~$29,000/yr (~89% margin) |
| Mid-market customer ARR — India Pro tier | ~$5,200/yr (~52% margin) |
| Mid-market customer ARR — SE Asia Pro tier | ~$9,000/yr (~71% margin) |
| Mid-market customer ARR — Western Europe Pro tier | ~$28,800/yr (~88% margin) |
| Partner rev share — Silver / Gold / Platinum tiers | 20% / 25% / 30% lifetime |
| Net margin on partner-sourced customer (after regional-capped share) | **~60-83% Tier-1 / ~53-72% Tier-3** |
| Hard net-margin floor enforced on every payout | **≥ 35%** |
| Partner-led GTM contribution margin (200-customer scenario) | **~56% vs. ~28% direct** |
| Regional rev-share caps | US/UK/EU 30-35% · India 20% · Africa 15% · Pakistan flat-fee only |
| Customer payback period | <1 quarter on first hire |

— *L3xy Inc., Internal & Board Use Only*
