# Workflow-scoped candidate-login test recipient

## Scope

An explicitly acknowledged, admin-approved exception permits an owner-controlled
internal inbox registered as an active candidate-portal account. It applies to
one fictional tenant-pool profile, workflow and approved current journey for
one hour. It never promotes the login to staff, grants provider execution,
verifies identity or authorises an invitation.

Approve/revoke controls are available in the existing isolated live-pilot panel.
Approval permanently classifies the profile as synthetic for reporting and
future learning inputs. Revocation does not turn fictional evidence into real
hiring results. Existing active staff-inbox eligibility is unchanged.

## Authority checks

Creation and use require the approved isolated autonomous work order, current
approved journey, unchanged recipient and candidate, active portal account,
active authorised approver, current tenant/data scope and unexpired permission.
Pause/cancel, erasure, do-not-contact, independently verified identity, changed
briefs/accounts/recipients and malformed permission journals fail closed.

Revocation is available while paused. Actions already durably claimed retain
the existing in-flight semantics; permission does not authorise a resend.
Screening, identity review, held draft, first send and interview invitation
continue to require their separate approvals and prerequisites. Interested
does not itself cause an invitation.

## Checks

Four focused private-database HTTP integration tests passed before the complete
regression gate. They exercise authorisation, explicit acknowledgement,
idempotency, approval without execution, unchanged login roles, permanent
reporting exclusions, expiry/revocation, source/account/recipient changes,
corrupt/foreign/cross-job authority and synthetic identity/contact prerequisites.

Browser verification uses a disposable fixture with invalid-domain inboxes.
No real candidate is contacted or assessed by these permission tests.

## Acceptance in development

The completed regression gate passed 463 API tests across 39 files (415 other
API tests and 48 workflow-journey tests), 50 frontend logic tests, frontend
typecheck, API build/security guards, lint and formatting. The existing
project-wide API TypeScript debt is not claimed resolved; the new workflow
modules have no TypeScript diagnostics after rebuilding generated declarations.

One browser pass with a disposable admin and invalid-domain inbox confirmed
the unchecked attestation disables approval; checking it permitted one
approve-recipient request, which survived a reload. A separate revoke-recipient
request made it inactive on the next reload. Neither action activated screening
or contact, and the browser fixture was removed afterward.

Finally, authenticated approval on the prepared isolated pilot persisted its
one-hour exception for the explicitly selected inbox. The recipient login role
remained candidate, canonical verification remained pending, the profile was
classified synthetic, all six workflow steps remained pending, pilot agent
authority stayed inactive and the work order had zero outreach messages.
No live screening grant, candidate email or invitation was executed here.
