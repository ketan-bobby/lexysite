import { isValidInterviewScore } from "./interview-turn-policy.js";

/** Normalize generated evidence without manufacturing a successful assessment. */
export interface InterviewSummaryResult {
  strengths: string[];
  weaknesses: string[];
  redFlags: string[];
  overallScore: number;
  recruiterSummary: string;
  recommendation: "yes" | "maybe" | "no";
}

export function resolveInterviewSummary(
  generated: unknown,
  answers: { score?: unknown; answer?: unknown }[],
  transcript: string,
): InterviewSummaryResult {
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    throw new Error("Interview summary returned an invalid result");
  }
  const summary = generated as Record<string, unknown>;
  const normalize = (value: string) =>
    value.normalize("NFKC").replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
  const candidateTranscript = answers
    .filter((a) => typeof a.answer === "string" && a.answer.trim())
    .map((a) => a.answer as string)
    .join("\n");
  if (!transcript.trim() || !candidateTranscript.trim()) {
    throw new Error("Interview summary has no captured candidate answers");
  }
  // Interviewer questions are not evidence that the candidate made a claim.
  const transcriptLower = normalize(candidateTranscript);
  const anchorOk = (value: string): boolean => {
    const quotes = [
      ...value.matchAll(
        /"([^"\n]{4,})"|“([^”\n]{4,})”|(?<![\p{L}\p{N}])'([^'\n]{4,})'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])‘([^’\n]{4,})’(?![\p{L}\p{N}])/gu,
      ),
    ].map((m) => normalize(m[1] ?? m[2] ?? m[3] ?? m[4]));
    return quotes.every((quote) => transcriptLower.includes(quote));
  };
  const anchorList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && anchorOk(item))
      : [];

  const scores = answers
    .filter((a) => typeof a.answer === "string" && a.answer.trim())
    .map((answer) => answer.score)
    .filter(isValidInterviewScore);
  if (!scores.length) {
    throw new Error("Interview summary has no valid assessment score");
  }
  const overallScore = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  const recommendation = summary.recommendation;
  if (recommendation !== "yes" && recommendation !== "maybe" && recommendation !== "no") {
    throw new Error("Interview summary has no valid hiring recommendation");
  }
  if (
    typeof summary.recruiterSummary !== "string" ||
    !summary.recruiterSummary.trim() ||
    !anchorOk(summary.recruiterSummary)
  ) {
    throw new Error("Interview summary has no supported narrative");
  }

  return {
    // Empty or filtered-out evidence stays empty; never replace it with praise.
    strengths: anchorList(summary.strengths),
    weaknesses: anchorList(summary.weaknesses),
    redFlags: anchorList(summary.redFlags),
    overallScore,
    recruiterSummary: summary.recruiterSummary.trim(),
    recommendation,
  };
}
