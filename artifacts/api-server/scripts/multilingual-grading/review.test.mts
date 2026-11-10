import assert from "node:assert/strict";
import test from "node:test";
import { fixtures, caseKinds } from "./fixtures.mts";
import { parseCsv, writeCsv } from "./review-csv.mts";
import {
  blindCsv,
  compareRatings,
  fixtureDigest,
  headers,
  parseRatings,
  prepareManifest,
  validateBaselineBinding,
} from "./review.mts";

const contract = "a".repeat(64);
const baseline = () => ({
  mode: "live",
  evidence: "synthetic-unreviewed",
  runId: "11111111-1111-4111-8111-111111111111",
  frozenSource: { gradingContract: contract },
  fixtureDigest: fixtureDigest(),
  results: fixtures.flatMap((f) =>
    caseKinds.map((kind) => ({
      locale: f.locale,
      kind,
      score: kind === "missing" ? null : kind === "substantive" ? 95 : 10,
      receipts: kind === "missing" ? [] : [{ status: "succeeded" }],
    })),
  ),
});
const reviewed = (m: ReturnType<typeof prepareManifest>, alias: string) => {
  const rows = parseCsv(blindCsv(m));
  for (const row of rows.slice(1)) {
    const s = m.samples.find((v) => v.id === row[1])!;
    row.splice(
      7,
      6,
      alias,
      "yes",
      "yes",
      s.kind === "missing" ? "not_applicable" : "yes",
      s.kind === "missing" ? "unscored" : String(s.aiScore),
      "Synthetic unit-test review only.",
    );
  }
  return writeCsv(rows);
};

test("CSV round trips Unicode, commas, quotes, newlines, empty cells and BOM/CRLF", () => {
  const rows = [
    ["తెలుగు", 'a,"b"\nc', ""],
    ["العربية", "", "last"],
  ];
  assert.deepEqual(parseCsv("\uFEFF" + writeCsv(rows)), rows);
  assert.throws(() => parseCsv('"unterminated'), /Unterminated/);
  assert.throws(() => parseCsv('"a"x,b'), /Malformed/);
  assert.throws(() => parseCsv('a"b,c'), /Malformed/);
});

test("blind pack includes 40 opaque samples but no scores, feedback or expected-kind labels", () => {
  const m = prepareManifest(baseline(), contract);
  const csv = blindCsv(m);
  assert.equal(parseCsv(csv).length, 41);
  assert.ok(!headers.some((h) => /^(?:ai_score|feedback|kind)$/.test(h)));
  assert.ok(!csv.includes("substantive") && !csv.includes("thin") && !csv.includes("refusal"));
  assert.deepEqual(parseRatings(m, csv), []);
  assert.equal(compareRatings(m, [csv], contract).coverageComplete, false);
});

test("stale, duplicate, extra or incomplete baseline evidence fails", () => {
  assert.throws(() => prepareManifest(baseline(), "b".repeat(64)), /Stale grading/);
  const stale = baseline();
  stale.fixtureDigest = "b".repeat(64);
  assert.throws(() => prepareManifest(stale, contract), /Stale fixture/);
  const partial = baseline();
  partial.results.pop();
  assert.throws(() => prepareManifest(partial, contract), /Incomplete/);
  const duplicate = baseline();
  duplicate.results.push(duplicate.results[0]);
  assert.throws(() => prepareManifest(duplicate, contract), /duplicate/);
});

test("legacy corpus binding and missing receipts remain explicit, never repaired by human ratings", () => {
  const source = baseline() as Omit<ReturnType<typeof baseline>, "fixtureDigest"> & {
    fixtureDigest?: string;
  };
  delete source.fixtureDigest;
  source.results[0].receipts = [];
  const m = prepareManifest(source, contract);
  const result = compareRatings(
    m,
    [reviewed(m, "reviewer_a"), reviewed(m, "reviewer_b")],
    contract,
  );
  assert.equal(result.coverageComplete, true);
  assert.equal(result.certification, false);
  assert.equal(result.baselineFixtureBinding, "legacy-unverified");
  assert.equal(result.sourceReceiptsComplete, false);
  assert.ok(result.limitations.some((l) => /provisional/.test(l)));
});

test("foreign pack, altered text, malformed ratings and duplicate reviewers are rejected", () => {
  const m = prepareManifest(baseline(), contract);
  const csv = reviewed(m, "reviewer_a");
  assert.throws(() => parseRatings(prepareManifest(baseline(), contract), csv), /foreign/);
  for (const [column, value] of [
    [3, "changed question"],
    [11, "NaN"],
    [8, ""],
    [7, "person@example.com"],
    [12, ""],
  ] as const) {
    const rows = parseCsv(csv);
    rows[1][column] = value;
    assert.throws(() => parseRatings(m, writeCsv(rows)));
  }
  assert.throws(() => compareRatings(m, [csv, csv], contract), /Duplicate reviewer/);
  assert.throws(() => compareRatings(m, [csv], "b".repeat(64)), /Stale review/);
});

test("unblinded/unqualified/translation-concern submissions do not complete eligible coverage", () => {
  const m = prepareManifest(baseline(), contract);
  const rows = parseCsv(reviewed(m, "reviewer_a"));
  for (const row of rows.slice(1)) row[9] = "no";
  const result = compareRatings(m, [writeCsv(rows)], contract);
  assert.equal(result.coverageComplete, false);
  assert.ok(result.details.every((d) => d.eligible === 0 && d.meanSubmittedScore === null));
});

test("zero grades survive; missing capture cannot be graded as zero or 100", () => {
  const m = prepareManifest(baseline(), contract);
  const rows = parseCsv(reviewed(m, "reviewer_a"));
  const captured = rows.find((r) => m.samples.find((s) => s.id === r[1])?.kind === "refusal")!;
  captured[11] = "0";
  const result = compareRatings(m, [writeCsv(rows)], contract);
  assert.equal(result.details.find((d) => d.sampleId === captured[1])?.meanSubmittedScore, 0);
  const absent = rows.find((r) => m.samples.find((s) => s.id === r[1])?.kind === "missing")!;
  absent[11] = "0";
  assert.throws(() => parseRatings(m, writeCsv(rows)), /Missing capture/);
});

test("large AI/human disagreement is flagged, not silently substituted into hiring evidence", () => {
  const m = prepareManifest(baseline(), contract);
  const rows = parseCsv(reviewed(m, "reviewer_a"));
  const row = rows.find((r) => m.samples.find((s) => s.id === r[1])?.kind === "substantive")!;
  row[11] = "40";
  const result = compareRatings(m, [writeCsv(rows)], contract);
  assert.equal(result.needsDiscussion, true);
  assert.equal(m.samples.find((s) => s.id === row[1])?.aiScore, 95);
});

test("edited AI scores and baseline files cannot be substituted after reviewers see a pack", () => {
  const source = baseline(),
    m = prepareManifest(source, contract);
  validateBaselineBinding(m, source, contract);
  m.samples[0].aiScore = m.samples[0].aiScore === 99 ? 98 : 99;
  assert.throws(() => validateBaselineBinding(m, source, contract), /Altered AI/);
  const changed = baseline();
  changed.results[0].score = 50;
  assert.throws(() => validateBaselineBinding(m, changed, contract), /digest mismatch/);
});

test("unscorable translation and human disagreement stay visible even with complete submitted rows", () => {
  const m = prepareManifest(baseline(), contract);
  const rows = parseCsv(reviewed(m, "reviewer_b"));
  const bad = rows.find((r) => m.samples.find((s) => s.id === r[1])?.kind === "thin")!;
  bad[10] = "uncertain";
  bad[11] = "unscorable";
  const strong = rows.find((r) => m.samples.find((s) => s.id === r[1])?.kind === "substantive")!;
  strong[11] = "70";
  const result = compareRatings(m, [reviewed(m, "reviewer_a"), writeCsv(rows)], contract);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.needsDiscussion, true);
  assert.equal(result.details.find((d) => d.sampleId === bad[1])?.translationConcern, true);
  assert.equal(result.details.find((d) => d.sampleId === strong[1])?.absoluteGap, 12.5);
  assert.equal(result.details.find((d) => d.sampleId === strong[1])?.needsDiscussion, true);
});
