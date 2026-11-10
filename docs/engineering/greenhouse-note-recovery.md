# Evidence-based Greenhouse note recovery

## Purpose and scope

A provider can create a note and then fail to return a usable response. Lexy's
committed publication claim must survive that uncertainty. Recovery now lets the
exact employer's active administrator verify that an existing, matching approved
note is present without creating another note.

This is **note recovery only**. It does not reconcile invitation email acceptance
or delivery, release an absent-note claim, delete receipts, or resend anything.
An empty list, missing permission, timeout or mismatch is not proof that the
original write failed. Live provider acceptance has not been tested by the agent.

## Where to find it

Open the imported Greenhouse applicant's prepared-interview control:

1. Choose **Review Greenhouse write-back**.
2. Choose **Review saved note attempts**.
3. Review the attempt's mode and original claim-recorded time.
4. For a held, verifiable attempt, enter the existing numeric Greenhouse note ID.
5. Check the explicit evidence acknowledgement and select **Verify existing note**.

Editing the note ID clears acknowledgement. The button stays unavailable without
a valid ID and fresh acknowledgement. Published and previously verified attempts
show their receipt without a resend action. Recovery details are hidden on failed
authority reads and during revalidation rather than displaying stale private data.

## Evidence required

The saved receipt must have an intact original approval claim for the same
employer, job, workflow, import and interview. Current staff authority, employer
allocation, candidate privacy and import eligibility are checked before reading
provider evidence and again before changing the local receipt.

The server reads exactly `GET /v3/notes?ids=<one numeric ID>` through the allocated
direct Greenhouse connection. Notes require their own provider read permission.
The general ATS GET proxy still cannot list notes or accept arbitrary paths.
Managed-connector recovery is not enabled.

Verification requires exactly one note with:

- The entered safe numeric ID.
- The exact external candidate and application.
- `NOTE` classification and `admin_only_visible` visibility.
- A bounded body and subject whose canonical payload hash matches the original
  approved receipt, including its employer account reference.

The original payload is verified against its saved hash, not reconstructed from
a potentially changed current assessment. It is not necessary to overwrite old
approved content with the latest assessment to recover the old attempt.
Other note content is neither displayed nor copied into the local audit.

## What a successful recovery means

The matching approved note was observed in Greenhouse at verification time.
It does **not** prove which request or user originally created it, that it remains
unchanged indefinitely, or that any candidate email was delivered.

An append-only `ats.interview.note.reconciled` event preserves the original claim
reference and records the verifier, provider note ID and observation time. The
receipt points to that result. The original approval and uncertain outcome remain
in history. Concurrent verification records one reconciliation; replay of the same
saved note ID performs no new provider request. A different ID cannot replace a
saved result through this control.

After all original holds are resolved, a new, distinct note version may become
eligible for its own fresh explicit publication approval. Recovery never publishes
that version automatically. The original exact note remains deduplicated.

## API and storage

- `GET /api/jobs/:jobId/candidate-workflows/:workflowId/ats-imports/:recordId/interview-note-recovery`
  returns saved attempt summaries locally; no provider call.
- `POST` to that path accepts only
  `{ receiptId, reviewHash, noteId, acknowledge: true }`.

Both responses are private/no-store. Inputs and outputs use generated contracts.
The recovery review hash binds the current source authority, original receipt and
result identity. Stale reviews, foreign receipt IDs and interrupted authority are
refused. More than 100 saved attempts require administrative investigation rather
than silently hiding unresolved attempts.

Existing workflow audit and receipt tables are reused: **no migration**.
Candidate erasure deletes reconciliation events and receipts through the exact
candidate-owned session, including when the parent workflow belongs to someone
else. It does not delete notes in the external ATS.

The direct transport is pinned to Greenhouse, uses GET, rejects redirects and
unsafe IDs, bounds response size, uses a timeout and checks credential identity
before and after reading the response body. No arbitrary evidence URLs are fetched.

Official provider reference:
https://harvestdocs.greenhouse.io/reference/get_v3-notes

## Automated development verification

Synthetic tests cover:

- Fixed direct note-read endpoint and rejection before credential exchange of
  managed connections, multiple IDs, query injection, URLs and unsafe integers.
- Empty/multiple/malformed, wrong-ID, wrong-person, wrong-application, altered
  subject/body, email-classified and publicly visible notes retaining the hold.
- False acknowledgement, extra fields, stale reviews, foreign receipt IDs,
  role/tenant denial and unavailable capability before any provider read.
- Provider failures returning sanitized errors without changing receipts.
- Authority revision changes during the provider read preventing finalization.
- Concurrent recovery recording exactly one reconciliation.
- Reload and replay returning the persisted verified-existing result with no
  repeat provider lookup, note write or invitation send.
- New distinct content requiring separate fresh publication approval.
- Candidate erasure removing the indirect recovery event/receipt.

Policy/transport tests and development-database HTTP fixtures passed. Real
Greenhouse permissions, actual note formatting and real-account acceptance remain
for the team. Synthetic checks are not live-provider evidence.

A synthetic browser run rendered the actual nested note/recovery components. It
confirmed ID edits clear consent, a 503 preserves the hold with no automatic
retry, deliberate reapproval verifies once, reopening shows the saved result,
new content still needs fresh publication approval, and failed authority reads
hide cached details. At 390 px there was no horizontal overflow. All requests
were intercepted; no account login, provider access or database mutation was used.

## Team acceptance — not run

Use only the isolated dummy applicant and an employer-approved direct connection.

1. Confirm the credential grant can read notes; never share keys in the UI.
2. In an isolated fault-injection test, create a held publication whose matching
   note already exists remotely. Do not induce real candidate write failures.
3. Open the saved attempts. Verify expansion alone makes no provider requests.
4. Try a different applicant's or public note ID. Expect rejection and an
   unchanged hold, with no private provider content displayed.
5. Verify the correct existing note. Confirm the local result and single audit
   record while Greenhouse's note count remains unchanged.
6. Reload and repeat the request. Expect the saved result, not a second write.
7. Change the source or revoke authority while verification is in flight.
   Expect refusal before local finalization.
8. Confirm absence or provider permission failures never expose a release/resend
   option. Offers, ATS stages and candidate email remain unchanged.
