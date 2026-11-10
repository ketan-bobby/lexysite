# Job creation and candidate-development privacy review

## Finding

The final flagged Class-B read was mislabelled as a scoring path. It is the
background lookup for candidate-private target-company role alerts:

- Select candidate identity and the candidate's company subscription list.
- Match the newly opened employer name against those subscriptions.
- Call the private role-alert emitter with candidate ID, job ID, company name
  and role title.

That lookup does not supply candidate evidence to the ICP agent, return
subscribers to the employer, create applications, or create candidate-job
intelligence. Cross-owner subscriptions are intentional for candidate-side
delivery; they do not authorize staff to read career profiles.

## Changes

The selection is now fully typed and still restricted to exactly candidate ID
and company preferences. Baseline, coaching, learning and narrative fields
must not be added to this projection or used as employer evidence.

A reproduced robustness bug was also fixed: one malformed persisted company
list or non-string element previously aborted the entire alert fan-out.
Malformed entries are now ignored without blocking other valid subscriptions.
This does not change valid matching, employer scoring, models or prompts.

## Verification

Four new HTTP regressions exercise the actual job router and development
database with disposable, uniquely identified fixtures. The ICP trigger and
private alert emitter are intercepted: no model call, provider send or
notification write to an existing candidate occurs.

They prove:

- Own- and foreign-tenant subscriptions produce only private alert callbacks;
  candidate IDs and baseline sentinels do not appear in the employer response.
- The only employer AI call receives the original factual job context.
  Changing private baseline content leaves that input unchanged.
- No application or candidate-job intelligence is created by this path.
- Malformed legacy preference data cannot starve valid alerts.
- Candidate-role callers cannot create jobs or trigger employer AI work.

The new suite, development privacy firewall, employer-presentation firewall
and assisted job baseline passed together: **21 tests, 21 passed, zero failed,
zero skipped**. The new suite is registered in the consolidated release runner.

API typecheck, build and build guards pass. The running API was restarted
successfully and its Class-B guard reports no remaining KNOWN GAP entries.
Targeted lint has zero errors (four pre-existing warnings in jobs.ts).
The public login page renders; job-creation privacy was verified by the HTTP
tests, not by that unauthenticated screenshot.

The original 49-group consolidated pass predates these and the compliance
analytics changes; it must not be presented as a rerun of the newer code.

## Review boundary

All six previously flagged analytics/job-creation review exceptions now have
verified controls. This is not a claim that every route, notification policy,
live provider or production installation has been fully verified.

The role-alert emitter's job-publication/confidentiality checks and candidate
contact-preference checks are separate notification-policy concerns. This
scoring review does not claim to have added those controls.
They have subsequently been implemented and verified separately in
`role-alert-safety-review.md`. The subscription lookup now lives in the
publication fan-out helper rather than the job-create callback.

No production access, schema migration, model, provider, prompt or approved
employer-presentation changes were made.
