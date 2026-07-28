# Lexy — Release Summaries / Changelog

> Engineering documentation set · Doc 8 of 9
> What has been built, grouped by theme, newest-first. This is a curated
> engineering changelog (the "what shipped and why it mattered"), reconstructed
> from git history. It is not a per-commit dump — see `git log` for that.

---

## Intelligence Engine — the "9-gap" credibility arc (most recent major work)

This arc systematically closed the gaps that stood between "AI scores" and
*defensible, self-improving* AI scores. In rough order:

| Theme | What shipped | Why it mattered |
| --- | --- | --- |
| **Fairness & adverse impact** | 4/5ths analysis on (candidate, job) units, demographics firewall, `FAIRNESS_DIRECTIVE` + PII redaction on every scorer, `test:fairness` suite. | Legal/ethical floor for hiring AI; makes the product sellable into regulated hiring. |
| **Outcome labels & quality-of-hire** | Capture of hire/reject outcomes + post-hire pulses (30/90d). | Creates the *training signal* the learning loop needs. |
| **Model versioning & backtest harness** | `backtest.ts` re-runs history through a candidate config; only promotes if F1/precision improves. | Scoring changes must *earn* production; no silent quality regressions. |
| **Thin-data honesty & calibration** | Confidence breakdown, hard caps when critical signals missing, calibration labeling. | Honest uncertainty = trust = the whole "defensible" pitch. |
| **Learned scoring** | `learned-scoring.ts` per-tenant weights, sample-gated (≥25) + backtest-gated, never-throw fallback. | Each tenant's model adapts to its own outcomes. |
| **Similar-hire embedding signal** | Real embedding-based "looks like your past good hires" signal, backtested vs the LLM-vs-ICP baseline. | Stronger Fit signal grounded in the tenant's actual hires. |
| **Cross-tenant global prior** | Network-effect prior from pooled *sufficient statistics* (never raw rows); thin tenants shrink toward it. | The moat: product gets smarter the more it's used, privacy intact. |
| **Sourcing provider adapter layer** | Pluggable provider registry (PDL/SERP/GitHub/internal); env-disable; never-throw. | External sourcing becomes safe to extend and operate. |

**Follow-up fix (latest):** provider runs now race a **per-kind timeout**
(discovery 20s / enrichment 90s, env-overridable) so a *hung* provider can't block
the whole sourcing fan-out — graceful degradation previously only caught throws,
not hangs.

---

## Interview pipeline — reliability at scale

A long series of fixes hardening the highest-stakes candidate moment:

- **Azure speech scaling:** dedicated TTS vs STT accounts, account **pooling +
  admission control**, per-account/per-format circuit breaker — fixes
  concurrent-load STT latency.
- **TTS watchdog:** `speakText` always settles before the mic opens — fixes
  candidates frozen on Q1 ("Lexy not responding") on mobile.
- **Mobile STT path:** mic-only segments routed to server `/transcribe` (browser
  Web Speech can't run while the video recorder holds the mic); typing fallback
  when the mic isn't heard.
- **STT quality telemetry:** persisted `stt_transcribe_events` (survive restarts),
  automatic alerting on mobile transcription regressions, per-provider/per-format
  breakdown, admin **Transcription Health** dashboard, automatic retention/cleanup.
- **Recording reliability:** resumable S3 multipart uploads, keepalive save on
  unload, end-of-interview detection, per-question scoring at `/end`.
- **Audio-format routing** covered by automated tests; verified on real iOS/Android.

---

## Tenant isolation & data integrity

- RLS tenant-isolation hardening; documented data-leak surfaces and the
  subtree-visibility model.
- Candidate-score **source-of-truth** consistency (accrued intelligence wins;
  KPI counts match the lists they link to).
- Candidate **dedup** (one row per tenant+lower(email)); orphan intelligence-row
  resolution (no more "Unknown" cards).
- DNC exclusion across kanban / sourcing / candidate list with live cache
  invalidation.

---

## Outreach, inbox & engagement

- Multi-step drip outreach (campaigns, enrollments, sequences, autopilot) with
  AI-personalized drafts; **approval-required by default**, edit-before-approve.
- GenAI email auto-reply + 24h interview-invite flow with secure invite tokens.
- One-click candidate self-decline → auto-reject + DNC.
- Recruiter inbox with inbound-email inline-image rendering (SendGrid Inbound
  Parse + SES→SNS), reply classification, re-engagement agent.
- Anti-ghosting detection + nurture; weekly/recruiter digests; LinkedIn monitor.

---

## Connection Engine (additive, feature-flagged)

> **Status: dormant by default — treat as experimental scaffolding, not live
> product, unless a flag is explicitly on.** Both flags default to **off** (the
> code activates only when the env var equals the string `"true"`), and they are
> **not enabled in the current environment**. So the routes/logic are merged and
> ready but inert: no tenant gets Connection Engine behaviour until someone sets
> the flag. If you're touching this area, assume it's *off in production* and
> verify the flag before assuming any of it is running for real users.

- Employer-side `connectionStrengthScore` (0–100) from engagement events, fully
  isolated from core scoring (`ENABLE_CONNECTION_ENGINE`).
- Candidate-side co-pilot: hiring momentum, connection strength, next-best-action
  (`ENABLE_CANDIDATE_CONNECTION_ENGINE`).

---

## Monetization & multi-tenant business model

- Country-level **subscription module**: display pricing + automatic lifecycle
  (trial expiry, grace, reminders) via `paid_through` + grace windows.
- Stripe checkout for upgrades; self-serve email-verified trial signup.
- India pricing model + unit-economics modeling artifacts.
- 3-level tenant hierarchy (platform admin → enterprise/agency → branch/sub-client)
  with branch/sub-client management.

---

## AI infrastructure

- **AI job queue** (`ai_jobs`): DB partial-unique-index dedupe, background worker
  with `FOR UPDATE SKIP LOCKED`, `enqueueAiJob` returns null on failure.
- 10-agent orchestrator with canonical `AGENT_ORDER`; every run feeds the
  intelligence layer.
- AI governance: kill switch, tenant scoping, atomic-send, build-breaking
  `check:no-adverse-writes` guard.

---

## How to read the raw history

```bash
git --no-optional-locks log --oneline        # full commit record
git --no-optional-locks log --oneline <file> # history for one file
```

The recent Intelligence-Engine arc corresponds to a sequence of scoped tasks;
this document summarizes their *outcomes and rationale* so you don't have to
reconstruct intent from commit messages.
