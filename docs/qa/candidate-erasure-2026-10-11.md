# Candidate erasure verification — 11 October 2026

## Completed

- Admin hard deletion and staff/self-service anonymisation share a 60-table
  candidate cleanup inventory.
- Interview summaries, application-linked schedules, sourcing mirrors and
  workflow-event children are removed before their parents.
- Private learning, rewards, evaluations, disclosure, discovery and other
  candidate-linked copies are included.
- Snapshotting captures recordings, checkpoint prefixes, canonical résumés,
  hiring-manager résumé references and persisted avatar videos before deletion.
- The authorised cleanup restores the service role **within the existing
  transaction and database connection**. Ordinary application requests do not
  gain DELETE permission on the append-only learning reward ledger.
- Self/staff anonymisation clears additional verification, sponsorship and
  employer-domain fields. Tombstone emails use the complete candidate identifier
  to avoid same-prefix collisions.
- Retained applications have their private notes scrubbed. Historical
  hire/start/terminal stages are not rewritten as rejections.
- Deletion requests, immutable decision events and financial ledger records are
  explicitly retained. Their legal retention basis remains a human responsibility.
- Storage failures are reported as pending. Admins see a warning; a full-deletion
  confirmation email is not sent while storage cleanup is outstanding.

## Final checks

- Nine focused erasure tests passed over disposable database fixtures, with
  external HTTP integrations blocked and storage/email operations substituted.
- Covered actual self, staff and admin controllers; anonymous/candidate-role/
  foreign-tenant denials; same-tenant and foreign peer survival; transactional
  rollback; repeated-request handling; immutable decision and fee preservation;
  normal application-role cleanup; and file snapshot/failure handling.
- Immutable audit/fee fixture inserts were intentionally rolled back rather than
  committed. Cleanup uses exact fixture identifiers, not real Linx data.
- Two fairness-firewall tests passed after reviewing the erasure-only inventory
  exception. The shared erasure module does not read demographics for scoring.
- Live development schema drift check passed: 60 direct candidate tables match
  the shared purge inventory, with three explicit retention exceptions.
- Frontend typecheck, API build and its security/rubric guards passed.
- Lint completed with zero errors and 500 warnings; formatting passed.
- API and web workflows restarted successfully. A public login screenshot
  confirmed the app renders. This screenshot is not a protected erasure-UI test.

## Boundaries

The broader assisted run did not complete within the five-minute outer shell
deadline. Its initial failures were corrected and checked with the focused tests
above; do not label the entire assisted suite green.

No live AWS byte-deletion proof, production erasure, legal certification, real
candidate deletion or invitation email was performed. Model/provider/prompt
configuration was not changed.

Storage cleanup remains best effort after database commit. Durable automatic
retry receipts and account-level closure/resurrection prevention are separate
remaining work. A database fulfilment status alone is not proof that every file
or login-account identifier has been deleted.
