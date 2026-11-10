import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, caseKinds } from "./multilingual-grading/fixtures.mts";
import {
  diagnosticGrade,
  diagnosticUsageArea,
  gradeIssues,
  parityIssues,
  renderTemplate,
} from "./multilingual-grading/policy.mts";
import { contractSha256, contractSpans } from "./rubric-extract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(root, "../../generated-artifacts/multilingual-grading");
const args = process.argv.slice(2);
if (args.some((a) => !["--live", "--dry-run", "--check-metering"].includes(a)) || args.length > 1) {
  throw new Error("Usage: check-multilingual-grading.mts [--dry-run | --live | --check-metering]");
}
if (args.includes("--check-metering")) {
  const { vendorUsageScope, meteredFetch } = await import("../src/lib/vendor-usage");
  const { dbAdmin, vendorUsageAttemptsTable, pool } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const area = diagnosticUsageArea(randomUUID(), "en-US", "thin");
  try {
    const fakeTransport: typeof fetch = async () =>
      new Response(
        JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const response = await vendorUsageScope.run({ tenantId: null, area }, () =>
      meteredFetch("openai_proxy", fakeTransport)("https://diagnostic.invalid/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "synthetic-receipt-path-only" }),
      }),
    );
    await response.json();
    const rows = await dbAdmin
      .select()
      .from(vendorUsageAttemptsTable)
      .where(eq(vendorUsageAttemptsTable.area, area));
    if (rows.length !== 1 || rows[0].status !== "succeeded" || rows[0].costStatus !== "unknown")
      throw new Error("Simulated durable receipt check failed");
    console.log(
      "[multilingual] simulated transport receipt persisted; no provider call or billing proof",
    );
  } finally {
    await dbAdmin.delete(vendorUsageAttemptsTable).where(eq(vendorUsageAttemptsTable.area, area));
    await pool.end();
  }
  process.exit(0);
}
const live = args.includes("--live");
const sourceHash = async () =>
  createHash("sha256")
    .update(await readFile(path.join(root, "src/lib/ai.ts")))
    .digest("hex");
const before = { gradingContract: contractSha256(), languageConfiguration: await sourceHash() };
const spans = new Map(contractSpans());
const userTemplate = spans.get("src/lib/ai-queue/handlers.ts#user-prompt")!;
const systemTemplate = spans.get("src/lib/ai-queue/handlers.ts#system-prompt")!;
const runId = randomUUID();
const report = {
  runId,
  createdAt: new Date().toISOString(),
  evidence: "synthetic-unreviewed",
  mode: live ? "live" : "dry-run",
  limitations: [
    "Not independently reviewed translations or human grading calibration.",
    "Text-only queued answer-grading diagnostic, with no interview focus directive.",
    "No microphone, STT, TTS, conversational adaptation, summary or end-to-end hiring certification.",
    "Provider receipts are observed usage, not reconciled billing or proof of preferred-provider availability.",
  ],
  frozenSource: before,
  fixtureDigest: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"),
  coverage: fixtures.map((f) => f.locale),
  languageCatalog: [] as {
    locale: string;
    preferredLlmProvider: string;
    fixtureCovered: boolean;
  }[],
  results: [] as {
    locale: string;
    kind: string;
    score: number | null;
    feedback: string | null;
    issues: string[];
    receipts: {
      provider: string;
      model: string | null;
      status: string;
      httpStatus: number | null;
      units: unknown;
    }[];
  }[],
  verdict: live ? "pending" : "not-run",
  gradingVerdict: live ? "pending" : "not-run",
  receiptVerdict: live ? "pending" : "not-run",
};
await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, `${runId}.json`);
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
await persist();

if (live) {
  const { generateJSON, resolveLangMeta, SUPPORTED_LANGUAGES } = await import("../src/lib/ai");
  const { FAIRNESS_DIRECTIVE } = await import("../src/lib/fairness");
  const { vendorUsageScope } = await import("../src/lib/vendor-usage");
  const { dbAdmin, vendorUsageAttemptsTable, pool } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  try {
    report.languageCatalog = Object.keys(SUPPORTED_LANGUAGES).map((locale) => ({
      locale,
      preferredLlmProvider: resolveLangMeta(locale).llmProvider,
      fixtureCovered: fixtures.some((f) => f.locale === locale),
    }));
    for (const fixture of fixtures) {
      if (!SUPPORTED_LANGUAGES[fixture.locale]) throw new Error("Unsupported fixture locale");
      for (const kind of caseKinds) {
        const area = diagnosticUsageArea(runId, fixture.locale, kind);
        const answer = kind === "missing" ? "" : fixture[kind];
        const result = await diagnosticGrade(
          fixture.question,
          answer,
          fixture.locale,
          async (question, ans, locale) => {
            const values = {
              "args.focusLine": "",
              "args.questionText": question,
              ans,
              langLabel: resolveLangMeta(locale).label,
              FAIRNESS_DIRECTIVE,
            };
            return vendorUsageScope.run({ tenantId: null, area }, () =>
              generateJSON(
                renderTemplate(userTemplate, values),
                renderTemplate(systemTemplate, values),
                locale,
              ),
            );
          },
        );
        const receipts = await dbAdmin
          .select({
            provider: vendorUsageAttemptsTable.provider,
            model: vendorUsageAttemptsTable.model,
            status: vendorUsageAttemptsTable.status,
            httpStatus: vendorUsageAttemptsTable.httpStatus,
            units: vendorUsageAttemptsTable.units,
          })
          .from(vendorUsageAttemptsTable)
          .where(eq(vendorUsageAttemptsTable.area, area));
        const issues = gradeIssues(kind, result);
        if (kind !== "missing" && !receipts.some((r) => r.status === "succeeded"))
          issues.push("successful_usage_receipt_missing");
        if (kind === "missing" && receipts.length) issues.push("missing_capture_called_provider");
        report.results.push({
          locale: fixture.locale,
          kind,
          score: result?.score ?? null,
          feedback: result?.feedback ?? null,
          issues,
          receipts,
        });
        await persist();
        console.log(
          `[multilingual] ${fixture.locale} ${kind}: ${result?.score ?? "unscored"} ${issues.join(",") || "OK"}`,
        );
      }
    }
    const baseline = report.results.find(
      (r) => r.locale === "en-US" && r.kind === "substantive",
    )!.score;
    for (const row of report.results.filter(
      (r) => r.kind === "substantive" && r.locale !== "en-US",
    ))
      row.issues.push(...parityIssues(baseline, row.score));
    const receiptIssue = (issue: string) =>
      ["successful_usage_receipt_missing", "missing_capture_called_provider"].includes(issue);
    report.gradingVerdict = report.results.some((r) => r.issues.some((i) => !receiptIssue(i)))
      ? "diagnostic-failed"
      : "diagnostic-passed";
    report.receiptVerdict = report.results.some((r) => r.issues.some(receiptIssue))
      ? "incomplete"
      : "observed";
    report.verdict = report.results.some((r) => r.issues.length)
      ? "diagnostic-failed"
      : "diagnostic-passed";
  } catch {
    report.verdict = "incomplete";
    await persist();
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
const after = { gradingContract: contractSha256(), languageConfiguration: await sourceHash() };
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error("Frozen grading/language source changed");
await persist();
console.log(`[multilingual] ${report.verdict}; report: ${output}`);
if (report.verdict === "diagnostic-failed") process.exitCode = 1;
