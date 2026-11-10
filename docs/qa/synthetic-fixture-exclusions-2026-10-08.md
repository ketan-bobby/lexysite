# Synthetic-pilot evidence exclusions

## Scope

Explicit `internal_test` identity clearance now persists a server-owned synthetic
fixture marker alongside the existing workflow audit, atomically. It does not
verify identity, change contact eligibility, grant spend, or send any message.
Models, provider routing, commercial tiers and old work-order records are unchanged.
No database schema change or historical data rewrite is required.

Synthetic candidates are excluded from hiring-candidate counts, application and
interview aggregates, funnel/trend/score distribution, outcomes coverage,
recruiter performance, intelligence aggregates and fairness cohort reads.
The same eligibility predicate filters tenant training rows, global-prior
cohorts, retraining scheduling and successful-hire exemplars/backtesting inputs.
Actual operational usage and work-order inventory are not fictional hiring
outcomes and remain available/countable.

Names, domains, test-looking titles and age are not classification rules.
Ordinary candidate lists and controlled pilot execution remain available.
The existing identity-review label identifies synthetic clearance as test-only.

The canonical marker survives subsequent verification and applies across work
orders. Agent result payloads cannot create or override it. Existing identity
clearance audits also exclude earlier fixtures within the caller's authorised
workflow scope. Neither cancellation nor a later review makes fictional
evidence into real hiring evidence. Historical audit-only fixtures outside that
scope cannot be discovered through another tenant's private workflow records;
new canonical markers prevent this for future clearances.

This excludes inputs to future training; it does not retrain or modify previously
stored weights, priors or similar-hire activation models.

## Verification

The private synthetic-reporting integration suite passes all ten assertions:

- Seven real HTTP reporting surfaces retain exactly one genuine control while
  excluding erased/DNC candidates and two fully populated synthetic hires.
- A marker-based fixture and a historical audit-only fixture are both excluded.
- A synthetic-only tenant contributes no training rows, global cohort or
  retraining trigger; the real control still contributes.
- Verification refresh preserves the canonical marker and strips attempted
  agent-created classification.
- Successful-hire exemplars retain the real control vector, not an empty result.
- Null and orphan candidate links retain the existing predicate semantics.

The workflow identity integration also checks that actual clearance persists
the marker without verifying identity or automatically granting contact.
Tests use a private schema and the external-egress guard, not live candidate data.

The completed assisted-regression gate also passes: 455 API tests across 38
files, 50 frontend-logic tests, four runner-planning tests and five egress tests,
with no failures or skips. Frontend typecheck, API build/security guards, lint
(zero errors) and formatting (zero unformatted files) pass. The API service
restarted successfully and the unauthenticated app sign-in page renders.
This is not proof of every UI journey, live inbox delivery or a clean full API
TypeScript check.
