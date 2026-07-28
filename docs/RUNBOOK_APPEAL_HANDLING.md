# Runbook — Appeal Handling (v1 stub)

**Status:** v1 stub. The endpoint and audit trail exist; operational workflow is manual until T+1.
**Owner:** Compliance · Recruiting Operations
**Related:** `AI_GOVERNANCE_ARCHITECTURE.md`, `AI_SYSTEM_CARD.md`

---

## 1. Scope

Under Colorado SB24-205 and the EU AI Act, a candidate who receives a consequential adverse decision has the right to:

1. Be informed that an AI system contributed to the decision.
2. Be told the principal reason for the decision.
3. **Appeal the decision to a human reviewer.**

This runbook documents how Lexy handles (3) in v1.

## 2. Receiving an appeal

Candidates submit appeals via:

```
POST /api/appeals/:applicationId
{
  "reason": "free-text candidate explanation (min 8 chars)",
  "contactEmail": "candidate@example.com"   // optional
}
```

The endpoint is **public by design** (a rejected candidate has no staff session). When called:

1. A row is inserted into `appeals_requests` with `status='received'`.
2. An immutable `appeal_requested` row is written to `decision_events`, capturing the prior `ai_recommendation`, prior `final_decision`, and the policy version that gated the original adverse outcome.
3. HTTP 202 is returned with the `appealId`.

> **Note:** v1 does **not** automatically email the recruiter, assign an owner, or start an SLA clock. Those are explicit T+1 deliverables (see §6).

## 3. Recruiter / compliance triage (v1 manual SOP)

1. Run the open-appeals query at the start of each business day:
   ```sql
   SELECT a.id, a.application_id, a.candidate_id, a.requested_by,
          a.reason, a.created_at, app.tenant_id, app.job_id
     FROM appeals_requests a
     JOIN applications app ON app.id = a.application_id
    WHERE a.status IN ('received', 'in_review')
    ORDER BY a.created_at;
   ```
   (Or use the admin queue page at `GET /api/appeals`.)
2. For each appeal, pull the candidate's full `decision_events` history:
   ```sql
   SELECT event_type, actor_kind, ai_recommendation, final_decision,
          rationale, attestation, policy_version_id, jurisdictions, created_at
     FROM decision_events
    WHERE application_id = '<application_id>'
    ORDER BY created_at;
   ```
3. Confirm whether the original adverse decision was AI-only, human-attested, or human-overridden. The `event_type` + `actor_kind` pair tells you which.
4. Assign a human reviewer (must be a different user than `final_decision_by` on the original decision, where possible).

## 4. Recording an outcome (v1 manual SQL)

Until the full UI ships, the reviewer records the outcome with two writes:

```sql
UPDATE appeals_requests
   SET status = 'upheld',   -- or 'overturned' or 'withdrawn'
       reviewer_user_id = '<user_id>',
       outcome_reason = '<text>',
       resolved_at = now()
 WHERE id = '<appeal_id>';

-- And an audit event (insert only — the table is append-only):
INSERT INTO decision_events
  (id, tenant_id, application_id, candidate_id, job_id,
   event_type, actor_user_id, actor_kind,
   rationale, attestation, policy_version_id, jurisdictions, payload)
VALUES
  (gen_random_uuid()::text, '<tenant>', '<app>', '<candidate>', '<job>',
   'appeal_completed', '<user_id>', 'tenant_admin',
   '<reviewer notes>',
   'I reviewed the AI recommendations and role-relevant candidate information before confirming this action.',
   '<policy_version_id>', ARRAY['US-CO'], '{"outcome":"upheld"}'::jsonb);
```

If the appeal **overturns** the original decision, the reviewer must also reverse the application state with `POST /api/applications/:id/human-decision` (e.g., `finalDecision: human_advance` with appeal-specific attestation text).

## 5. Candidate communication

In v1, candidate-facing communications are sent manually by Recruiting Operations. The template should:

* Acknowledge receipt within 1 business day of the appeal being filed.
* Communicate the outcome within 10 business days for jurisdictions that mandate an SLA (CO, EU). NYC LL144 does not mandate a specific timeline but requires the appeal pathway to exist.

## 6. T+1 — full operational workflow (planned)

* Automatic recruiter notification + SLA timer on `POST /appeals`.
* Admin UI: `/human-review/appeals` queue with assignment, status transitions, and outcome capture.
* Templated candidate emails (acknowledgment, in-review, outcome).
* Metrics dashboard: appeals received, time-to-decision, upheld vs overturned by jurisdiction.
* Webhook for tenant integrations.

## 7. Retention

`appeals_requests` and the related `decision_events` rows are retained for 7 years (SOC2 + LL144 + EU AI Act longest applicable retention). Deletion requests (right to erasure) are honoured per `docs/SOC2_CONTROLS.md` §Deletion.
