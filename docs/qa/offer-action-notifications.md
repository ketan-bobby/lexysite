# Native offer action notifications

## Scope and safety

- New explicit offer actions enroll the workflow for in-app alerts. Historical
  Linx work orders are not bulk-enrolled or changed.
- Preparation goes to the designated owner; review to the designated approver;
  approved/manual-send work to the designated sender. Uncertain delivery goes
  to available owners/senders without permitting resend.
- Unavailable operators trigger recovery alerts only for eligible employer
  tenant admins. Agency/platform admins are not surrogate offer authorities.
- Alerts contain no candidate names, compensation, legal terms or response
  tokens. Current candidate privacy, compliance, application linkage and staff
  eligibility are reused; obsolete actionable alerts are removed.
- Identical pending work preserves its existing read state. Changed tasks
  receive new alerts. Background checks run every five minutes to detect staff
  availability, stale sends, expiration and governance changes.
- Links open the assigned Offer Inbox item or the employer work order for
  ownership/governance review. The staff bell now shows the actual unread
  count. The notification page refreshes every 30 seconds and shows load errors.
- No email channel, provider request, approval, offer delivery, employment
  confirmation or fee action is performed by notifications.

## Verification

- Full real database/HTTP recruiting-workflow suite: **49 passed**.
- New tests cover future-only enrollment, exact recipient roles, idempotent
  replay, mark-read preservation, ownership recovery, DNC removal, and no sends.
- Shared-library and frontend typechecks passed.
- Changed-source lint has no errors. API build/security guards passed and both
  managed services restarted successfully.
- The API server's full TypeScript check remains blocked by its existing
  520-error baseline; no errors were reported in the files changed here.
- No signed-in browser acceptance pass was run for this minor notification UI
  change; backend behavior, existing link consumers and frontend types were
  checked. No real candidate contact or historical Linx mutation was performed.

## Remaining boundaries

This adds in-app action alerts, not provider delivery-status lookup or
email/digest reminders. Greenhouse integration and remaining real-provider/
identity evidence are separate work. Native offers remain human-operated.
