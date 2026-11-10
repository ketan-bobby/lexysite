import { createHash, randomUUID, randomInt } from "node:crypto";
import { z } from "zod";
import { fixtures, caseKinds } from "./fixtures.mts";
import { parseCsv, writeCsv } from "./review-csv.mts";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fixtureDigest = () => digest(fixtures);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const score = z.number().int().min(0).max(100).nullable();
const sample = z
  .object({
    id: z.string().uuid(),
    locale: z.string(),
    kind: z.enum(["substantive", "thin", "refusal", "missing"]),
    question: z.string(),
    answer: z.string(),
    referenceQuestion: z.string(),
    referenceAnswer: z.string(),
    aiScore: score,
  })
  .strict();
export const manifestSchema = z
  .object({
    version: z.literal(1),
    packId: z.string().uuid(),
    evidence: z.literal("synthetic-unreviewed"),
    createdAt: z.string().datetime(),
    gradingContract: sha,
    fixtureDigest: sha,
    sourceRunId: z.string().uuid(),
    sourceDigest: sha,
    fixtureBinding: z.enum(["matched", "legacy-unverified"]),
    sourceReceiptsComplete: z.boolean(),
    samples: z.array(sample).length(40),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

const baselineSchema = z.object({
  mode: z.literal("live"),
  evidence: z.literal("synthetic-unreviewed"),
  runId: z.string().uuid(),
  frozenSource: z.object({ gradingContract: sha }),
  fixtureDigest: sha.optional(),
  results: z.array(
    z.object({
      locale: z.string(),
      kind: z.enum(["substantive", "thin", "refusal", "missing"]),
      score,
      receipts: z.array(z.object({ status: z.string() })),
    }),
  ),
});

export function prepareManifest(source: unknown, currentContract: string): Manifest {
  const run = baselineSchema.parse(source);
  if (run.frozenSource.gradingContract !== currentContract)
    throw new Error("Stale grading contract");
  if (run.fixtureDigest && run.fixtureDigest !== fixtureDigest())
    throw new Error("Stale fixture corpus");
  const samples: Manifest["samples"] = [];
  const used = new Set<string>();
  const english = fixtures.find((f) => f.locale === "en-US")!;
  for (const f of fixtures)
    for (const kind of caseKinds) {
      const rows = run.results.filter((r) => r.locale === f.locale && r.kind === kind);
      if (rows.length !== 1) throw new Error("Incomplete or duplicate baseline coverage");
      const key = `${f.locale}:${kind}`;
      used.add(key);
      if (kind === "missing" && rows[0].score !== null)
        throw new Error("Missing capture baseline was scored");
      const question = f.question,
        answer = kind === "missing" ? "" : f[kind];
      if ([question, answer].some((s) => /^[=+\-@\t\r]/.test(s)))
        throw new Error("Unsafe spreadsheet fixture");
      samples.push({
        id: randomUUID(),
        locale: f.locale,
        kind,
        question,
        answer,
        referenceQuestion: english.question,
        referenceAnswer: kind === "missing" ? "" : english[kind],
        aiScore: rows[0].score,
      });
    }
  if (run.results.some((r) => !used.has(`${r.locale}:${r.kind}`)))
    throw new Error("Unexpected baseline sample");
  for (let i = samples.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }
  return manifestSchema.parse({
    version: 1,
    packId: randomUUID(),
    evidence: "synthetic-unreviewed",
    createdAt: new Date().toISOString(),
    gradingContract: currentContract,
    fixtureDigest: fixtureDigest(),
    sourceRunId: run.runId,
    sourceDigest: digest(source),
    fixtureBinding: run.fixtureDigest ? "matched" : "legacy-unverified",
    sourceReceiptsComplete: run.results
      .filter((r) => r.kind !== "missing")
      .every((r) => r.receipts.some((a) => a.status === "succeeded")),
    samples,
  });
}

export const headers = [
  "pack_digest",
  "sample_id",
  "locale",
  "question",
  "answer",
  "english_reference_question",
  "english_reference_answer",
  "reviewer_alias",
  "language_competent",
  "ai_scores_unseen",
  "translation_equivalent",
  "human_score",
  "rationale",
];
const immutableCells = (m: Manifest, s: Manifest["samples"][number]) => [
  digest(m),
  s.id,
  s.locale,
  s.question,
  s.answer,
  s.referenceQuestion,
  s.referenceAnswer,
];

export function blindCsv(m: Manifest): string {
  return writeCsv([
    headers,
    ...m.samples.map((s) => [...immutableCells(m, s), "", "", "", "", "", ""]),
  ]);
}

type Rating = {
  sampleId: string;
  reviewer: string;
  competent: boolean;
  blind: boolean;
  translation: "yes" | "no" | "uncertain" | "not_applicable";
  score: number | null;
  rationale: string;
};

export function parseRatings(m: Manifest, csv: string): Rating[] {
  const rows = parseCsv(csv);
  if (JSON.stringify(rows.shift()) !== JSON.stringify(headers))
    throw new Error("Wrong review CSV headers");
  const ratings: Rating[] = [],
    seen = new Set<string>();
  for (const row of rows) {
    if (row.every((c) => c === "")) continue;
    if (row.length !== headers.length) throw new Error("Wrong review column count");
    const s = m.samples.find((v) => v.id === row[1]);
    if (!s || JSON.stringify(row.slice(0, 7)) !== JSON.stringify(immutableCells(m, s)))
      throw new Error("Altered template or foreign review pack");
    if (seen.has(s.id)) throw new Error("Duplicate sample row in reviewer file");
    seen.add(s.id);
    const editable = row.slice(7).map((v) => v.trim());
    if (editable.every((v) => !v)) continue;
    const [reviewer, competent, blind, translation, humanScore, rationale] = editable;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(reviewer)) throw new Error("Use an anonymous reviewer alias");
    if (!["yes", "no"].includes(competent) || !["yes", "no"].includes(blind))
      throw new Error("Competence and blinding require yes/no");
    if (!["yes", "no", "uncertain", "not_applicable"].includes(translation))
      throw new Error("Invalid translation judgment");
    if (!rationale || rationale.length > 2000) throw new Error("A brief rationale is required");
    let parsedScore: number | null = null;
    if (s.kind === "missing") {
      if (humanScore !== "unscored" || translation !== "not_applicable")
        throw new Error("Missing capture must remain unscored/not_applicable");
    } else {
      if (translation === "not_applicable")
        throw new Error("Captured text requires a translation judgment");
      if (humanScore === "unscorable" && (competent === "no" || translation !== "yes")) {
        parsedScore = null;
      } else {
        if (!/^(?:100|[1-9]?[0-9])$/.test(humanScore))
          throw new Error("Human score must be an integer from 0 to 100");
        parsedScore = Number(humanScore);
      }
    }
    ratings.push({
      sampleId: s.id,
      reviewer,
      competent: competent === "yes",
      blind: blind === "yes",
      translation: translation as Rating["translation"],
      score: parsedScore,
      rationale,
    });
  }
  return ratings;
}

/** Comparison, never authentication, certification or a hiring decision.
 * A 15-point difference flags discussion, not a replacement production rubric. */
export function compareRatings(m: Manifest, files: string[], currentContract: string) {
  if (m.gradingContract !== currentContract || m.fixtureDigest !== fixtureDigest())
    throw new Error("Stale review contract or corpus");
  const ratings = files.flatMap((csv) => parseRatings(m, csv));
  const ids = m.samples.map((s) => s.id),
    keys = m.samples.map((s) => `${s.locale}:${s.kind}`);
  if (new Set(ids).size !== 40 || new Set(keys).size !== 40)
    throw new Error("Invalid manifest coverage");
  const english = fixtures.find((f) => f.locale === "en-US")!;
  for (const s of m.samples) {
    const f = fixtures.find((v) => v.locale === s.locale);
    if (
      !f ||
      s.question !== f.question ||
      s.answer !== (s.kind === "missing" ? "" : f[s.kind]) ||
      s.referenceQuestion !== english.question ||
      s.referenceAnswer !== (s.kind === "missing" ? "" : english[s.kind])
    )
      throw new Error("Altered manifest sample");
  }
  const pairs = ratings.map((r) => `${r.sampleId}:${r.reviewer}`);
  if (new Set(pairs).size !== pairs.length) throw new Error("Duplicate reviewer/sample submission");
  const details = m.samples.map((s) => {
    const submitted = ratings.filter((r) => r.sampleId === s.id);
    const eligible = submitted.filter(
      (r) =>
        r.competent &&
        r.blind &&
        r.translation === (s.kind === "missing" ? "not_applicable" : "yes"),
    );
    const scores = eligible.flatMap((r) => (r.score === null ? [] : [r.score]));
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const gap = mean !== null && s.aiScore !== null ? Math.abs(mean - s.aiScore) : null;
    return {
      sampleId: s.id,
      locale: s.locale,
      submitted: submitted.length,
      eligible: eligible.length,
      aiScore: s.aiScore,
      meanSubmittedScore: mean,
      absoluteGap: gap,
      needsDiscussion:
        (gap !== null && gap > 15) ||
        (scores.length > 1 && Math.max(...scores) - Math.min(...scores) > 15),
      translationConcern: submitted.some(
        (r) => r.translation === "no" || r.translation === "uncertain",
      ),
      coverageComplete: eligible.length >= 2,
      submittedReviews: submitted.map((r) => ({
        reviewerAlias: r.reviewer,
        languageCompetenceSelfAttested: r.competent,
        blindReviewSelfAttested: r.blind,
        translationJudgment: r.translation,
        score: r.score,
        rationale: r.rationale,
      })),
    };
  });
  return {
    evidence: "self-attested-review-submissions",
    certification: false,
    packDigest: digest(m),
    reviewRows: ratings.length,
    baselineFixtureBinding: m.fixtureBinding,
    sourceReceiptsComplete: m.sourceReceiptsComplete,
    coverageComplete: details.every((d) => d.coverageComplete),
    needsDiscussion: details.some((d) => d.needsDiscussion || d.translationConcern),
    limitations: [
      "Reviewer identity, competence and blinding are self-attested, not independently verified.",
      "Two distinct eligible aliases per sample indicate submission coverage, not proof of two independent people.",
      "No audio, whole-language accuracy, employment decision or provider-cost certification.",
      ...(m.fixtureBinding === "legacy-unverified"
        ? ["Legacy AI run did not hash its fixture corpus; comparisons remain provisional."]
        : []),
      ...(!m.sourceReceiptsComplete
        ? ["Original AI usage receipts are incomplete; costs remain unknown."]
        : []),
    ],
    details,
  };
}

export function validateBaselineBinding(m: Manifest, source: unknown, currentContract: string) {
  if (digest(source) !== m.sourceDigest) throw new Error("Source baseline digest mismatch");
  const rebuilt = prepareManifest(source, currentContract);
  if (
    m.sourceRunId !== rebuilt.sourceRunId ||
    m.fixtureBinding !== rebuilt.fixtureBinding ||
    m.sourceReceiptsComplete !== rebuilt.sourceReceiptsComplete
  )
    throw new Error("Altered baseline metadata");
  for (const s of m.samples) {
    const expected = rebuilt.samples.find((r) => r.locale === s.locale && r.kind === s.kind);
    if (!expected || expected.aiScore !== s.aiScore) throw new Error("Altered AI baseline score");
  }
}
