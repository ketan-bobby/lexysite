import assert from "node:assert/strict";
import { test } from "node:test";
import {
  meetingQuestions,
  meetingTranscriptHash,
  meetingQuestionReviewInput,
  meetingQuestionEvidence,
  meetingUploadInput,
} from "./meeting-notes-core";

const transcript = "I test an API using validation and error handling. Tests protect the contract.";
const planned = "How do you test an API?\r\n\n What protects the contract? ";
const entry = {
  questionIndex: 0,
  status: "covered" as const,
  excerpt: "I test an API using validation and error handling.",
  note: "",
};
const input = (entries = [entry]) =>
  meetingQuestionReviewInput.parse({
    sourceHash: meetingTranscriptHash(transcript),
    previousRevision: null,
    entries,
  });

test("question lines retain wording, order and duplicates; upload rejects unbounded line lists", () => {
  assert.deepEqual(meetingQuestions(planned), [
    "How do you test an API?",
    "What protects the contract?",
  ]);
  assert.deepEqual(meetingQuestions("Same?\nSame?"), ["Same?", "Same?"]);
  const upload = {
    title: "Meeting",
    consent: "true",
    consentStatement: "Every participant consented.",
    plannedQuestions: Array(101).fill("Question?").join("\n"),
  };
  assert.equal(meetingUploadInput.safeParse(upload).success, false);
});

test("hash binds exact source, including punctuation and whitespace; blank source is absent", () => {
  assert.match(meetingTranscriptHash(transcript)!, /^[a-f0-9]{64}$/);
  assert.notEqual(meetingTranscriptHash(transcript), meetingTranscriptHash(transcript + "\n"));
  assert.equal(meetingTranscriptHash(null), null);
  assert.equal(meetingTranscriptHash("  "), null);
});

test("review request rejects server-owned attribution, scores, unknown statuses and malformed revisions", () => {
  assert.throws(() => meetingQuestionReviewInput.parse({ ...input(), reviewedBy: "someone" }));
  assert.throws(() =>
    meetingQuestionReviewInput.parse({ ...input(), entries: [{ ...entry, score: 99 }] }),
  );
  assert.throws(() =>
    meetingQuestionReviewInput.parse({ ...input(), entries: [{ ...entry, status: "approved" }] }),
  );
  assert.throws(() =>
    meetingQuestionReviewInput.parse({ ...input(), previousRevision: "old timestamp" }),
  );
  assert.throws(() =>
    meetingQuestionReviewInput.parse({ ...input(), entries: [{ ...entry, questionIndex: -1 }] }),
  );
});

test("covered/partial evidence has exact deterministic source offsets, including Unicode", () => {
  const [linked] = meetingQuestionEvidence(input(), planned, transcript);
  assert.equal(transcript.slice(linked!.evidenceStart!, linked!.evidenceEnd!), entry.excerpt);
  const source = "😀 தமிழில் API சோதனை செய்கிறேன். More context.";
  const unicode = input([{ ...entry, excerpt: "தமிழில் API சோதனை செய்கிறேன்." }]);
  const [evidence] = meetingQuestionEvidence(unicode, planned, source);
  assert.equal(evidence!.evidenceStart, 3);
  assert.equal(
    source.slice(evidence!.evidenceStart!, evidence!.evidenceEnd!),
    unicode.entries[0]!.excerpt,
  );
});

test("no invented, missing, repeated or duplicated evidence is silently accepted", () => {
  assert.throws(() =>
    meetingQuestionEvidence(input([{ ...entry, excerpt: "Never said" }]), planned, transcript),
  );
  assert.throws(() =>
    meetingQuestionEvidence(input([{ ...entry, excerpt: "" }]), planned, transcript),
  );
  assert.throws(() => meetingQuestionEvidence(input(), planned, `${transcript} ${transcript}`));
  assert.throws(() => meetingQuestionEvidence(input([entry, entry]), planned, transcript));
  assert.throws(() =>
    meetingQuestionEvidence(input([{ ...entry, questionIndex: 3 }]), planned, transcript),
  );
});

test("unreviewed questions stay absent; clearing is explicit; not-covered never invents evidence", () => {
  assert.deepEqual(meetingQuestionEvidence(input([]), planned, transcript), []);
  const review = meetingQuestionReviewInput.parse({
    ...input(),
    entries: [{ ...entry, status: "not_covered", excerpt: "" }],
  });
  assert.deepEqual(meetingQuestionEvidence(review, planned, transcript), [
    { ...review.entries[0], evidenceStart: null, evidenceEnd: null },
  ]);
  assert.throws(() =>
    meetingQuestionEvidence(
      { ...review, entries: [{ ...review.entries[0]!, excerpt: "I test" }] },
      planned,
      transcript,
    ),
  );
  assert.throws(() => meetingQuestionEvidence(input([]), "", transcript));
});
