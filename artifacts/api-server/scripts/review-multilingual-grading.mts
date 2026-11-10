import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blindCsv,
  compareRatings,
  manifestSchema,
  prepareManifest,
  validateBaselineBinding,
} from "./multilingual-grading/review.mts";
import { contractSha256, liveRubric } from "./rubric-extract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(root, "../../generated-artifacts/multilingual-review");
const read = async (file: string) => {
  if ((await stat(file)).size > 2_000_000) throw new Error("Review input exceeds 2 MB");
  const bytes = await readFile(file);
  if (bytes.length > 2_000_000) throw new Error("Review input exceeds 2 MB");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};
const json = async (file: string) => JSON.parse((await read(file)).replace(/^\uFEFF/, ""));
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
const guide = () => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Lexy — blind grading review</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f3f6fa;color:#182b42;margin:0;padding:24px}
main{max-width:880px;margin:auto;background:white;padding:32px;border-radius:16px}
h1,h2{line-height:1.2}h1{font-size:30px}h2{margin-top:32px;font-size:22px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf3fa;padding:20px;border-radius:10px}
code{overflow-wrap:anywhere}li{margin:10px 0}.notice{border-left:4px solid #e6a23c;padding:12px 20px;background:#fff8e7}
@media(max-width:500px){body{padding:10px}main{padding:20px}h1{font-size:26px}}</style>
<main><p><strong>LEXY · Internal quality review</strong></p><h1>Blind interview-answer review</h1>
<p>40 synthetic text samples in ten selected languages. No real candidate data, audio or employment decisions.</p>
<p class="notice">The review sheet contains no AI scores or expected answer-class labels.
Share only the CSV and this guide with reviewers—not the private manifest, earlier AI results or comparison reports.
If you already saw the AI scores, disclose that. Do not claim a blind review.</p>
<h2>How to complete the CSV</h2><ol>
<li>Open/import as <strong>UTF-8 CSV</strong>. Keep sample IDs, digest, language, question, answer and English reference columns unchanged.</li>
<li>Use a generic anonymous <code>reviewer_alias</code>, such as <code>reviewer_a</code>. Do not enter names, emails, candidate information or credentials.</li>
<li>Review only languages you understand. Enter <code>yes</code> or <code>no</code> for <code>language_competent</code> and <code>ai_scores_unseen</code>.</li>
<li>Judge whether the question and answer preserve the meaning/facts of the English reference.
Set <code>translation_equivalent</code> to <code>yes</code>, <code>no</code> or <code>uncertain</code>.
Grammar/style differences alone are not translation failures.</li>
<li>Give your own integer <code>human_score</code> from 0–100 and a short evidence-based <code>rationale</code>.
A genuine zero is valid. If text cannot be assessed because competence or translation is inadequate, enter <code>unscorable</code> instead.</li>
<li>For an empty answer, enter <code>unscored</code> and <code>not_applicable</code> for translation.
Missing capture is not a zero-performance answer.</li>
<li>Leave all six reviewer fields blank for rows not reviewed. Do not partially fill a row.
Each reviewer should return their own CSV; two eligible aliases per sample are needed for complete submission coverage.</li>
</ol>
<h2>Use the current grading rubric</h2><pre>${escape(liveRubric())}</pre>
<p>Grade content, not accent, fluency, grammar, presentation style or STAR coaching.
Do not use age, gender, ethnicity, disability or other protected characteristics.</p>
<h2>What happens after review</h2>
<p>The local comparison check validates the original pack and saved AI baseline, preserves unscored values,
and flags AI/human differences or reviewer disagreements over 15 points for discussion.
That is a diagnostic threshold, not a new production rubric. It cannot change scores, prompts or hiring decisions.</p>
<p>Identity, language competence and blinding are self-attested. Complete CSV coverage does not prove independent reviewer identity
or certify language accuracy. The retained legacy AI run also lacks a fixture hash and usage receipts, so its comparisons remain provisional
and its cost remains unknown. No new AI calls are needed for this review.</p>
</main></html>`;

async function main() {
  const [action, ...files] = process.argv.slice(2);
  const currentContract = contractSha256();
  if (action === "prepare" && files.length === 1) {
    const m = prepareManifest(await json(files[0]), currentContract);
    const dir = path.join(outputRoot, m.packId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n", {
      mode: 0o600,
    });
    await writeFile(path.join(dir, "blind-review.csv"), "\uFEFF" + blindCsv(m));
    await writeFile(path.join(dir, "review-guide.html"), guide());
    console.log(`Prepared 40 blind samples; no human review or provider call performed.\n${dir}`);
    return;
  }
  if (action === "compare" && files.length >= 3) {
    const m = manifestSchema.parse(await json(files[0]));
    validateBaselineBinding(m, await json(files[1]), currentContract);
    const result = compareRatings(m, await Promise.all(files.slice(2).map(read)), currentContract);
    const status = !result.reviewRows
      ? "awaiting-human-review"
      : !result.coverageComplete
        ? "partial-review"
        : result.needsDiscussion
          ? "requires-human-resolution"
          : result.baselineFixtureBinding === "legacy-unverified"
            ? "provisional-comparison"
            : "submission-comparison-complete";
    const dir = path.join(outputRoot, m.packId);
    await mkdir(dir, { recursive: true });
    const output = path.join(dir, "comparison.json");
    await writeFile(output, JSON.stringify({ status, ...result }, null, 2) + "\n", { mode: 0o600 });
    console.log(
      `${status}; ${result.reviewRows} submitted review rows; certification=false.\n${output}`,
    );
    if (status !== "submission-comparison-complete") process.exitCode = 2;
    return;
  }
  throw new Error(
    "Usage: prepare <saved-live-result.json> | compare <manifest.json> <same-live-result.json> <review.csv> [more.csv]",
  );
}
main().catch(() => {
  // Invalid inputs may contain personal text. Do not echo cell values or raw
  // validation objects; inspect inputs locally with the documented schema.
  console.error(
    "Review input failed validation. Check UTF-8, unchanged pack/baseline, complete reviewer fields and duplicate entries.",
  );
  process.exitCode = 1;
});
