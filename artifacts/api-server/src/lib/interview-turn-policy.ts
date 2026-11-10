/**
 * Pure interview policy shared with the browser. No database/provider imports:
 * capture accounting and review warnings must agree on both sides.
 */
export const INTERVIEW_SCORE_STRONG = 85;
export const INTERVIEW_SCORE_MODERATE = 70;

export function isValidInterviewScore(score: unknown): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
}

/** Validate provider output; missing/malformed grades are not zero or 100. */
export function parseInterviewGrade(result: unknown): { score: number; feedback?: string } | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const grade = result as Record<string, unknown>;
  if (!isValidInterviewScore(grade.score)) return null;
  return {
    score: Math.round(grade.score),
    ...(typeof grade.feedback === "string" && grade.feedback.trim()
      ? { feedback: grade.feedback.trim() }
      : {}),
  };
}

export function interviewEvaluationWarning(
  score: unknown,
  recommendation: unknown,
  answers?: { score?: unknown; answer?: unknown }[],
  expectedQuestions?: unknown,
): string | null {
  const warnings: string[] = [];
  if (answers) {
    const assessed = answers.filter(
      (a) =>
        isValidInterviewScore(a.score) &&
        (!("answer" in a) || (typeof a.answer === "string" && !!a.answer.trim())),
    );
    const expected =
      typeof expectedQuestions === "number" &&
      Number.isInteger(expectedQuestions) &&
      expectedQuestions > 0
        ? Math.max(expectedQuestions, answers.length)
        : answers.length;
    if (!assessed.length) {
      warnings.push(
        "No valid graded answers support this assessment. Review the saved evidence; do not treat missing capture or failed grading as candidate performance.",
      );
    } else if (assessed.length < expected) {
      warnings.push(
        `Only ${assessed.length} of ${expected} answers have valid grades. This assessment is incomplete; review missing capture or failed grading before deciding.`,
      );
    }
    if (assessed.length && isValidInterviewScore(score)) {
      const mean = Math.round(
        assessed.reduce((sum, a) => sum + (a.score as number), 0) / assessed.length,
      );
      if (Math.abs(score - mean) > 1) {
        warnings.push(
          `The headline score ${score}/100 differs from the saved answer-grade average ${mean}/100. Review the evidence before deciding.`,
        );
      }
    }
  }
  const rec = typeof recommendation === "string" ? recommendation.toLowerCase() : "";
  const positive = ["yes", "advance"].includes(rec);
  const negative = ["no", "decline"].includes(rec);
  if (!isValidInterviewScore(score)) {
    warnings.push(
      "The recommendation has no valid interview score to compare. Review the saved evidence before deciding.",
    );
  } else if (positive && score < INTERVIEW_SCORE_MODERATE) {
    warnings.push(
      `Interview score ${score}/100 is below the moderate interview band (${INTERVIEW_SCORE_MODERATE}), but the AI recommends advancing. Review the answers and make an explicit human decision.`,
    );
  } else if (negative && score >= INTERVIEW_SCORE_STRONG) {
    warnings.push(
      `Interview score ${score}/100 is in the strong interview band, but the AI recommends declining. Review the answers and make an explicit human decision.`,
    );
  }
  return warnings.length ? warnings.join(" ") : null;
}

/** Only explicit audio-recapture requests, not skill gaps or technical follow-ups. */
export function isInterviewAudioClarification(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'");
  if (normalized.length > 600) return false;
  if (/\b(?:catch|caught) (?:an? |the )?(?:exception|error)\b/.test(normalized)) return false;
  const pairs: [RegExp, RegExp][] = [
    [
      /\b(?:not have caught|didn't catch|did not catch|couldn't hear|could not hear|didn't hear|did not hear|not have heard|audio was unclear)\b/,
      /\b(?:repeat|say .{0,40}again)\b/,
    ],
    [
      /(?:no (?:he )?(?:oído|entendido|escuchado)|no pude (?:oír|escuchar)|audio.{0,20}(?:claro|claridad))/,
      /(?:repetir|repite|repita)/,
    ],
    [
      /(?:pas (?:bien )?(?:entendu|compris)|n'ai pas (?:bien )?(?:entendu|compris)|audio.{0,20}clair)/,
      /(?:répéter|répétez|redire)/,
    ],
    [
      /(?:nicht (?:richtig |gut )?(?:gehört|verstanden)|audio.{0,20}unklar)/,
      /(?:wiederholen|noch einmal sagen)/,
    ],
    [/(?:não (?:ouvi|entendi|consegui ouvir)|áudio.{0,20}claro)/, /(?:repetir|repita)/],
    [/(?:सुन नहीं|नहीं सुन|सुनाई नहीं|ठीक से समझ नहीं)/, /(?:दोबारा|फिर से|दोहर)/],
  ];
  return pairs.some(([audio, repeat]) => audio.test(normalized) && repeat.test(normalized));
}

export interface ConversationAnswer {
  questionId: string;
  questionText?: string;
  answer: string;
  score: number | null;
  captureClarifications?: { questionText: string; previousAnswer: string; answer: string }[];
}

/** Returns new data only. The caller locks the row before using this function. */
export function accountInterviewTurn(
  answers: ConversationAnswer[],
  currentQuestionIndex: number,
  input: { questionText: string; answerText: string; turnNumber: number },
): { answers: ConversationAnswer[]; currentQuestionIndex: number; clarification: boolean } {
  if (!Number.isSafeInteger(input.turnNumber) || input.turnNumber < 1 || !input.answerText.trim()) {
    throw new Error("Invalid interview turn");
  }
  const clarification = isInterviewAudioClarification(input.questionText);
  if (clarification) {
    if (input.turnNumber !== currentQuestionIndex + 1 || !answers.length) {
      throw new Error("Audio clarification requires the preceding saved answer");
    }
    const previous = answers[answers.length - 1];
    if (previous.score != null) throw new Error("An assessed answer cannot be replaced");
    const captures = previous.captureClarifications ?? [];
    const last = captures[captures.length - 1];
    if (last?.questionText === input.questionText && last.answer === input.answerText) {
      return { answers, currentQuestionIndex, clarification };
    }
    return {
      answers: [
        ...answers.slice(0, -1),
        {
          ...previous,
          answer: input.answerText,
          captureClarifications: [
            ...captures,
            {
              questionText: input.questionText,
              previousAnswer: previous.answer,
              answer: input.answerText,
            },
          ],
        },
      ],
      currentQuestionIndex,
      clarification,
    };
  }
  const existing = answers.find((a) => a.questionId === `turn-${input.turnNumber}`);
  if (existing) {
    if (existing.questionText !== input.questionText || existing.answer !== input.answerText) {
      throw new Error("This interview turn is already saved");
    }
    return { answers, currentQuestionIndex, clarification };
  }
  if (input.turnNumber !== currentQuestionIndex + 1)
    throw new Error("Interview turn is out of sequence");
  return {
    answers: [
      ...answers,
      {
        questionId: `turn-${input.turnNumber}`,
        questionText: input.questionText,
        answer: input.answerText,
        score: null,
      },
    ],
    currentQuestionIndex: input.turnNumber,
    clarification,
  };
}
