import { z } from "zod/v4";
import { fingerprint } from "../recruiting-workflows";

export const zohoReviewInput = z.strictObject({
  decision: z.enum(["advance", "hold", "decline"]),
  reason: z.string().trim().min(10).max(2000),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid(),
  confirm: z.literal(true),
});
export function interviewScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}
export function reviewRevision(evidenceHash: string, latestReviewId: string | null) {
  return fingerprint({ evidenceHash, latestReviewId });
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function reviewAnswers(value: unknown, questions: unknown) {
  const rows = Array.isArray(value) ? value : [];
  const plan = Array.isArray(questions) ? questions.map(obj) : [];
  let truncated = rows.length > 200;
  const answers = rows
    .slice(0, 200)
    .map((raw) => {
      const row = obj(raw);
      const question = plan.find((q) => q.id === row.questionId);
      const q = row.questionText ?? row.question ?? question?.text ?? question?.question;
      const a = row.answer ?? row.answerText;
      if (
        (typeof q === "string" && q.length > 16000) ||
        (typeof a === "string" && a.length > 16000)
      )
        truncated = true;
      return {
        question: typeof q === "string" ? q.slice(0, 16000) : "",
        answer: typeof a === "string" ? a.slice(0, 16000) : "",
        score: interviewScore(row.score),
      };
    })
    .filter((a) => a.question || a.answer);
  return { answers, truncated };
}
