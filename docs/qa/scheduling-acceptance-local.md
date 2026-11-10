# Scheduling acceptance: isolated local verification

## Result

All **269 checks passed**, with zero failed or skipped:

| Command (`@workspace/api-server`) | Passed | Boundary |
| --- | ---: | --- |
| `test:candidate-time-postgres` | 114 | Real PostgreSQL and HTTP in a private fixture schema |
| `test:google-calendar` | 46 | Calendar account, consent and read adapters |
| `test:outlook-calendar` | 55 | Consent, transport and controlled event operations |
| `test:google-operations` | 20 | Approved rescheduling/cancellation and uncertain outcomes |
| `test:google-invitations` | 20 | Explicit invitation approval and provider-attempt isolation |
| `test:candidate-google-meet` | 14 | Candidate-owned meeting publication and stale-state protection |

The development database was identified independently and its fingerprint
matched the application pool before fixture DDL. The database suite creates
and cleans an owned private namespace; it does not change customer appointments.
Provider calls use test doubles behind the existing network egress guard.

## Covered workflow

- Staff publish selected times; public booking capabilities expose only those
  times. Candidates cannot query staff free/busy or private panel identities.
- Booking rejects unoffered times, foreign identities, revoked/expired links,
  unapproved jobs and erased candidates.
- Concurrent choices produce one confirmation, event and scoped notification.
  Failed persistence rolls the confirmation back.
- Candidate time-change requests and withdrawal preserve the appointment until
  staff take an explicit scheduling action.
- Saved panels recheck current calendar availability, staff identity and consent
  at confirmation, including public booking and ordinary recruiter ownership.
- Provider invitations require explicit, current human approval. Lost provider
  replies remain uncertain and cannot silently resend.
- Google meeting-link publication checks candidate ownership and current booking
  evidence; controlled Google/Outlook operation tests cover event changes.
- Staff-provided Zoom links hide after relevant appointment changes. Replacement
  and removal retain replay protection; stale notices are private, scoped and
  deduplicated. Native cancellation does not cancel a Zoom meeting.

## What this does not prove

This is a local HTTP/database and provider-adapter acceptance pass, **not a new
signed-in browser run or a live Google/Outlook/Zoom acceptance test**. Existing
browser evidence remains separate. No invitation email, real provider event,
production migration or real appointment was created or changed by this pass.

Remaining release boundaries:

1. Connected-account acceptance must confirm real invitations, meeting links,
   rescheduling and cancellation with the participating staff.
2. Production schema/privacy rollout must be verified independently.
3. Automatic Zoom remains blocked by the previously observed Invalid client ID.
   Staff-provided links are not evidence of a working Zoom API integration.

No application code, AI configuration, billing behavior or authorization policy
needed modification. There was no failed check requiring a fix.

## Local command output

Ephemeral logs for this pass:

- `/tmp/scheduling-acceptance.log`
- `/tmp/scheduling-google.log`
- `/tmp/scheduling-outlook.log`
- `/tmp/scheduling-google-operations.log`
- `/tmp/scheduling-google-invitations.log`
- `/tmp/scheduling-candidate-meet.log`

Logs under `/tmp` are not durable release artifacts. Re-run the named commands
against an independently verified development target when fresh evidence is
needed; do not reuse a saved database fingerprint.
