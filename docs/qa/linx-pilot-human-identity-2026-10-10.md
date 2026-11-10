# Linx pilot — existing human identity review

## Selected approach

The user selected the existing human-review path for the internal Linx pilot.
No external identity provider, new account, credential or model change is
required for that choice. Actual authorised staff review remains necessary;
choosing a process is not evidence that any candidate has been reviewed.

The current UI distinguishes:

- Real-person corroboration, with a staff acknowledgement that independent
  evidence was personally checked and AI advice alone was not relied upon.
- Synthetic controlled-inbox clearance, explicitly not verified identity.
- Unresolved identity, which does not authorise contact.

Saving identity review does not independently approve outreach, invitations,
offers or provider execution.

## Focused safety correction

Previously, an active approver could submit real-person corroboration for a
profile already classified as a synthetic fixture. The acknowledgement alone
did not enforce that classification.

The backend now rejects that request before identity or workflow writes. It
reuses the canonical real-candidate predicate, covering both the server-owned
fixture marker and earlier structured test-clearance audits. Classification
is not inferred from names, domains, work-order age or model output.

Synthetic test-only clearance still works, and ordinary real-person human
corroboration remains available. This is not a commercial feature restriction.
No old Linx records were rewritten or retroactively verified.

## Evidence

Two focused private-database HTTP tests completed successfully:

1. Canonical and legacy audit-only synthetic classifications reject
   corroboration with HTTP 409, without changing identity verification or
   workflow revision. Separate synthetic clearance still completes the test
   verification step without verifying identity.
2. The existing normal human-corroboration path preserves the AI advisory
   evidence; an unresolved review keeps contact blocked.

The broader journey run reported passing test bodies, including authorisation,
tenant ownership, concurrent revision handling and the fictional six-stage
journey, but exceeded its 120-second outer deadline before final completion.
It is not recorded as a clean full-suite completion. The focused rerun above
completed including cleanup, with outbound networking prohibited.

Changed-source lint and whitespace checks passed. No real identity-provider
request, candidate contact or human review of a live person was performed.
Models, providers, prompts, rubrics, pricing and external sourcing remain
unchanged. Multilingual human review and AWS-dependent verification stay pending.

The managed API workflow was restarted once after the change. Its build,
security/privacy checks and frozen-rubric guard passed, and the API is serving.
The pre-existing dormant-Stripe warning remained and its existing startup
admin-alert email ran; this change did not enable billing or send candidate mail.
