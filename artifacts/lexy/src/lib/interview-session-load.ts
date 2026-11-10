/** Bound the complete request, including reading its response body. */
export async function withInterviewLoadTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 12000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Loading the interview took too long. Please try again."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function interviewResumeState(session: {
  currentQuestionIndex?: number;
  answers?: { questionText?: string; answer?: string }[];
}) {
  const history: { role: "ai" | "candidate"; text: string }[] = [];
  for (const answer of session.answers ?? []) {
    if (answer.questionText) history.push({ role: "ai", text: answer.questionText });
    if (typeof answer.answer === "string") history.push({ role: "candidate", text: answer.answer });
  }
  const index = session.currentQuestionIndex;
  const nextQuestion =
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0
      ? index + 1
      : (session.answers?.length ?? 0) + 1;
  return { history, nextQuestion };
}

/** Presentation only: continuing still uses the existing authenticated /begin. */
export function interviewStartView(
  session: {
    startedAt?: string | null;
    status?: string;
    currentQuestionIndex?: number;
    answers?: unknown[];
  },
  totalQuestions: number,
) {
  const index = session.currentQuestionIndex;
  const saved = Math.max(
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : 0,
    Array.isArray(session.answers) ? session.answers.length : 0,
  );
  const resuming = Boolean(
    session.startedAt ||
    saved > 0 ||
    ["active", "paused", "resumed", "in_progress"].includes(session.status ?? ""),
  );
  const allAnswered = totalQuestions > 0 && saved >= totalQuestions;
  return {
    resuming,
    saved,
    nextQuestion: saved + 1,
    allAnswered,
    title: resuming ? (allAnswered ? "Finish your interview" : "Continue your interview") : null,
    action: resuming
      ? allAnswered
        ? "Finish interview"
        : "Continue interview"
      : "Start Interview with Lexy",
    pending: resuming
      ? allAnswered
        ? "Preparing closing steps…"
        : "Resuming interview…"
      : "Starting interview…",
  };
}
