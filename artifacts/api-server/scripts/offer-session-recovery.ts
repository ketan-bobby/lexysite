import assert from "node:assert/strict";
import { assertDevelopmentTarget, cleanupOfferSessionFixture } from "./offer-session-fixture";
import {
  journalOwnerIsAlive,
  offerSessionOwnership,
  OfferSessionJournalStore,
} from "./offer-session-journal";

/** Explicit recovery only; no prefix scans and no expected identity from the journal itself. */
export async function recoverOfferSessionJournal(name: string, fingerprint: string | undefined) {
  await assertDevelopmentTarget(fingerprint);
  const store = new OfferSessionJournalStore();
  const journal = await store.read(name);
  assert.ok(journal.fingerprint === fingerprint, "Journal belongs to another verified target.");
  if (journal.state === "pending") {
    assert.ok(
      !(await journalOwnerIsAlive(journal.owner)),
      "Fixture owner is still running; cleanup refused.",
    );
  }
  await cleanupOfferSessionFixture(
    { ...journal, ownershipProof: offerSessionOwnership(journal) },
    journal.state === "cleaned",
  );
  await store.markCleaned(name, journal);
}
