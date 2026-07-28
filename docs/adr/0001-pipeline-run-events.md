# ADR 0001 — Persisting pipeline run events (and the run model we did NOT unify)

Status: Accepted
Date: 2026-07-05

## Context

The platform has **two** run/event models that grew up independently:

- **`pipeline_runs`** — the orchestrator's real, multi-agent runs. One row per full
  run for a job; per-agent steps live inline in a `stages` jsonb array, updated by
  `orchestrator._updatePipelineStage`. Its lifecycle **events were in-memory only**
  (`orchestrator.events`, capped, lost on every deploy). It is the *parent* grain.
- **`agent_runs` + `agent_run_events`** — a *flat, single-agent* model (currently
  only `agent_type = 'sourcing'`, and currently produced by `simulateSourcingRun`)
  with a fully **persisted, RLS'd event stream** and a `seq`-ordered polling contract.

They are **neither "the same concept twice" nor a clean parent/child**: different
grains, different entry points, one real and one simulated, no FK linking them.

Part 3 of the pipeline_runs auditability work needed pipeline runs to have a
**durable** event stream (surviving deploys) with the same tenant-safety and
non-blocking guarantees as `agent_run_events`.

## Decision

Adopt **Option B: a new `pipeline_run_events` table** (mirroring `agent_run_events`:
`tenant_id` + FORCE RLS, `seq` ordering, best-effort background writes) **plus a
read-side union view `run_activity_events`** that normalizes both event streams into
one shape (`run_id, run_type, tenant_id, event_type, timestamp, message, payload, …`).

- The **union view is the ONLY sanctioned read surface** for cross-run activity
  (documented in the view's `COMMENT` and in `SECURITY_PATTERNS`-style guidance).
  Consumers read the view and never care which table an event physically lives in.
- Writes are **non-blocking**: `emitPipelineRunEvent` uses the admin pool, computes
  `seq` in-statement, and swallows/logs any error — an event failure never fails or
  slows a run. The orchestrator emits fire-and-forget (`void`).
- **In-memory is demoted to a hot cache**: `GET /agents` and `GET /agents/runs` read
  persisted `pipeline_runs` (expanded per-agent) as the source of truth, using the
  in-memory buffer only to fill sub-second freshness / first-load fallback.
- **Concrete retention**: milestone events (`run_started`, `run_completed`,
  `run_failed`, `run_interrupted`, `step_completed`) are kept forever; non-milestone
  events (e.g. `step_started`) are pruned after 90 days, batched, best-effort.

## The road not taken — full unification onto `agent_runs`

We evaluated folding pipeline runs into `agent_runs` (a parent `agent_runs` row with
`parent_run_id` children per stage, all events in `agent_run_events`). We **deferred**
it because the blast radius is large and disproportionate to the goal:

1. Schema change to `agent_runs` (add `parent_run_id`, widen `agent_type`; its status
   enum has no `interrupted`, which pipeline_runs deliberately uses).
2. Rewriting the orchestrator's hot path (`_updatePipelineStage` jsonb → child rows +
   events).
3. Migrating every `pipeline_runs.stages` reader — the **Kanban board** and **job run
   history** reconstruct stage state from the jsonb.
4. Mixing real audit data with the simulated-sourcing demo under one contract that
   `run-view.tsx` + the decision queue assume is sourcing-shaped.

## Consequences / the future seam

`run_activity_events` is deliberately the seam. **If** full unification is ever done,
it re-points at the unified table and **consumers that read the view do not change**.
Today's pragmatism is therefore tomorrow's option, not tomorrow's mystery.
