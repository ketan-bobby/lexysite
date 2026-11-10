import { parseInterviewGrade } from "../../src/lib/interview-turn-policy";
import type { CaseKind } from "./fixtures.mts";

/** Render the extracted live template, never a separately maintained rubric.
 * Reject new interpolation slots rather than silently testing a stale contract. */
export function renderTemplate(source: string, values: Record<string, string>): string {
  if (!source.endsWith("`")) throw new Error("Expected extracted template terminator");
  return source
    .slice(0, -1)
    .replace(/\\n/g, "\n")
    .replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      if (!Object.hasOwn(values, key)) throw new Error(`Unknown grading slot: ${key}`);
      return values[key];
    });
}

export type GradeResult = { score: number; feedback?: string } | null;
export type Grader = (question: string, answer: string, locale: string) => Promise<unknown>;

/** Use an existing allowed step and put diagnostic identity in the workflow
 * segment. These labels do not refer to a real candidate or requisition. */
export function diagnosticUsageArea(runId: string, locale: string, kind: CaseKind) {
  const id = `grading_diag_${runId}_${locale}_${kind}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid diagnostic usage ID");
  return `workflow:${id}:ai_interview` as const;
}

/** Mirrors queued gradeAnswer's empty-input/error/validation behavior. */
export async function diagnosticGrade(
  question: string,
  answer: string,
  locale: string,
  grader: Grader,
): Promise<GradeResult> {
  if (!answer.trim()) return null;
  try {
    return parseInterviewGrade(await grader(question, answer.trim(), locale));
  } catch {
    return null;
  }
}

export function gradeIssues(kind: CaseKind, result: GradeResult): string[] {
  if (kind === "missing") return result === null ? [] : ["missing_capture_was_scored"];
  if (result === null) return ["unavailable_grade"];
  const issues: string[] = [];
  if (!result.feedback) issues.push("missing_feedback");
  if (kind === "refusal" && result.score >= 20) issues.push("refusal_not_below_20");
  if (kind === "thin" && result.score > 70) issues.push("generic_answer_above_average_band");
  if (kind === "substantive" && result.score < 75)
    issues.push("substance_below_existing_probe_floor");
  return issues;
}

/** Existing fairness probe uses a 10-point diagnostic difference.
 * This is a synthetic parity check, not an independently validated rubric. */
export function parityIssues(english: number | null, translated: number | null): string[] {
  if (english === null || translated === null) return ["parity_not_measurable"];
  return Math.abs(english - translated) > 10 ? ["translated_score_gap_over_10"] : [];
}
