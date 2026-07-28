# Lexy — Roadmap (Where We're Going & Why)

> Engineering documentation set · Doc 7 of 9
> Direction, not date-bound commitments. Each theme states the bet and why it
> matters relative to the north star (defensible hiring that gets smarter with use).

## Recently shipped (the foundation this builds on)

The "9-gap" arc closed the credibility gaps in the Intelligence Engine — these are
done and are the platform the roadmap stands on:

- Fairness & adverse-impact compliance (4/5ths, demographics firewall).
- Outcome labels & quality-of-hire capture (the training signal).
- Model versioning + backtest harness (safe promotion of scoring changes).
- Thin-data honesty & calibration labeling (confidence caps).
- Outcome-calibrated **learned scoring** (per-tenant weights).
- Real similar-hire **embedding** signal.
- Cross-tenant **global prior** (the network effect).
- **Sourcing provider adapter layer** (pluggable external sourcing + timeouts).

See Doc 8 (changelog) for the full record.

---

## Theme 1 — Deepen the moat: make the Intelligence Engine self-improving end-to-end

**The bet.** The learning loop exists (outcomes → learned weights → backtest →
promotion; thin tenants shrink to a global prior). The next leg is making that
loop *tighter and more visible*.

**Why.** The network effect is the defensible moat. Every increment that makes a
hire outcome improve future scores — faster and more measurably — compounds. This
is where engineering time has the highest strategic leverage.

**Direction.**
- Propagate `AbortSignal` into sourcing/enrichment adapters so a timeout actually
  cancels in-flight network work, not just unblocks orchestration.
- Richer outcome capture (post-hire performance pulses already exist at 30/90d) →
  feed quality-of-hire, not just hire/no-hire, into calibration.

  > **Read this before you treat quality-of-hire as "just an engineering task."**
  > This feedback loop is the single biggest dependency for everything else in
  > Theme 1 — learned weights, backtests, and the global prior are only as good as
  > the outcome labels feeding them, and quality-of-hire is the richest label we
  > can get. But the hard part is **not** the pipeline that ingests a 30/90-day
  > rating; it's **getting hiring managers to actually submit it.** That is a
  > product-design and change-management problem: the request has to be embedded
  > in a workflow they already use, timed and nudged well, and backed by customer
  > success driving adoption — engineering can build the capture mechanism, but it
  > won't produce signal on its own. Plan for it as a **joint product + CS +
  > engineering effort**, and expect label coverage (not code) to be the limiting
  > factor.
- Surface model lineage/versioning to recruiters ("this score uses your tenant's
  learned model, trained on N outcomes") to make the moat *legible* to buyers.

## Theme 2 — Observability & operational confidence

**The bet.** Move from logs-only to metrics + alerting on the AI/sourcing paths.

**Why.** As autonomy increases (autopilot outreach, auto-verification,
auto-scoring), "we'll read the logs if something looks off" stops scaling. We
already persist STT outcomes and alert on transcription quality; the same
discipline should cover provider skip-rates, scoring fallbacks, and queue health.

**Direction.**
- Persist provider skip/timeout/error rates to a metrics surface (today they're
  logs only) and alert when a provider degrades.
- Health dashboards for the AI job queue (depth, age, failure rate) and the
  schedulers.
- Promote the existing STT health/alerting pattern into a general AI-ops surface.

## Theme 3 — Trust, safety & compliance as a sellable surface

**The bet.** Turn the governance we already enforce internally into
customer-facing assurance.

**Why.** Enterprise/regulated hiring buys *defensibility*. We already have a
fairness firewall, audit trail, PII redaction, SOC2-readiness docs, and
client-facing evaluation exports. Packaging these as a coherent compliance story
is a revenue unlock, not just hygiene.

**Direction.**
- Continue toward SOC2 Type 1 → Type 2 (readiness doc exists).
- Self-serve fairness/adverse-impact reporting for tenant admins.
- Configurable autonomy policies per tenant (strict human-in-the-loop ↔ autopilot)
  exposed cleanly in the UI, backed by `lib/policies.ts`.

## Theme 4 — Scale the real-time interview pipeline

**The bet.** The live AI interview is the highest-stakes candidate moment and the
hardest to keep reliable under load.

**Why.** Most production incidents in this area were "fine in dev, froze under
concurrency/on mobile." We've added Azure account pooling, admission control,
per-account breakers, TTS watchdogs, and a mobile server-STT path. Continued
investment here directly protects conversion and brand.

**Direction.**
- Broaden device/browser coverage and graceful degradation (typing fallback
  already exists when the mic isn't heard).
- Tune pool sizing / admission thresholds from real concurrency metrics
  (ties into Theme 2).

## Theme 5 — Sourcing breadth & internal-first reach

**The bet.** More providers behind the adapter layer; internal-first stays the
default.

**Why.** Internal-first sourcing is a differentiator (cheaper + better candidate
experience). The adapter layer (Theme/Doc 4 E2) makes adding providers cheap and
safe. Each new provider widens reach without re-plumbing.

**Direction.**
- Generalize enrichment seeding beyond the hardcoded pdl+serp pair (see Doc 9).
- Additional discovery/enrichment providers as pure adapters.
- Smarter internal-pool ranking before any paid external call.

---

## How priorities are set

1. **Protect the moat** (Intelligence Engine + internal-first sourcing).
2. **Protect trust** (fairness, safety, tenant isolation, honesty of outputs).
3. **Reduce operational risk** as autonomy grows (observability).
4. **Widen reach** (sourcing breadth, interview reliability at scale).

A feature that doesn't serve one of these is a candidate for "later." When two
compete, the higher number wins.
