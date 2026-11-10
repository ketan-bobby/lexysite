# Controlled workflow: review, synthetic identity clearance and held draft

The owner authorised continuation of the isolated fictional-profile pilot.
This acceptance is limited to `WO-2026-LIVE-MAIN-0013` and its existing workflow;
older Linx work orders and completed interviews were not changed.

## Workflow progress

1. Screening completed through an explicit test-only review of the saved source.
   The original 85/100, medium-confidence **hold** remains unchanged. Missing
   location, current employer and years of experience were not invented.
   Progression is not a real-candidate qualification decision or résumé screen.
2. Verification completed **only as synthetic controlled-inbox clearance**.
   The normal identity-resolution endpoint bound this clearance to the current
   workflow, journey, unchanged existing source and active recipient permission.
   The canonical candidate and identity record remain pending/unverified.
   The identity record's timestamp and review fields were not changed. No
   identity-provider assessment was repeated.
3. One native outreach execution created a draft with subject
   “Exciting TypeScript Backend Opportunity in Bengaluru.” It is
   `pending_approval`, not queued or sent. Engagement remains pending.
   Execution/contact authority was revoked after draft preparation. A later
   first send needs a separate explicit approval; this does not disable assisted
   sourcing or commercial recruiting.

The AI interview, human evaluation and human hiring decision remain pending.
No invitation or interview plan was created, and no candidate email was sent.
Synthetic evidence remains excluded from real hiring and learning evidence.

## Metering failure and repair

The native wrapper's new usage scope was correct, but the database's old area
constraint admitted only `unattributed` and `interview_unclassified`.
It therefore rejected labeled receipts during draft preparation. The saved
draft is not proof of complete provider telemetry; token counts, exact provider
request count and actual charges for this execution are not asserted.
The missing receipts were not reconstructed, and the paid action was not repeated.

Migration `0074_workflow_vendor_usage_labels.sql` preserves existing labels and
admits only bounded workflow identifiers and known native step names.
The current application's datastore was upgraded. No publication or separate
production migration is implied. Forced RLS, absence of application-role read
policies and the unknown-cost constraint remain intact.

The metering suite passed after the constraint repair. An additional isolated
transactional schema-upgrade test proves the original constraint rejects a
workflow label, the migration permits it while retaining legacy rows, and
security stays intact. The durable transport test proves labeled receipts
persist, ordinary calls remain unattributed, malformed step labels are rejected,
and application roles still cannot read the receipts. Fixture rows are removed;
no real provider request is made by these tests.

No models, prompts, provider routing, keys or pricing changed.
