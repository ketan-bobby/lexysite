/** Browser capture choice only; this never changes server models or providers. */
export function shouldUseServerInterviewCapture(options: {
  language: string;
  userAgent: string;
  mobile: boolean;
  browserSpeechAvailable: boolean;
}): boolean {
  // All spoken answers use the existing language-aware server configuration.
  // Browser recognition alone is not reliable evidence for grading.
  void options;
  return true;
}

export function isInterviewGreetingOnly(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,!?،。！？，]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    /^(hi|hello|hey|good morning|good afternoon|good evening)( (lexy|lexi))?$/.test(normalized) ||
    [
      "namaste",
      "नमस्ते",
      "bonjour",
      "salut",
      "hola",
      "olá",
      "你好",
      "こんにちは",
      "வணக்கம்",
      "السلام عليكم",
    ].includes(normalized)
  );
}

/** Resume copy, not an LLM instruction. Never discard previous answers. */
export function interviewResumeGreeting(
  language: string,
  nextQuestion: number,
  total: number,
): string | null {
  if (!/^en(-|$)/i.test(language) || nextQuestion <= 1) return null;
  const welcome =
    "Hi, I'm Lexy, your AI interviewer. Welcome back. Your earlier answers are saved.";
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(nextQuestion)) {
    return `${welcome} We'll continue where you left off.`;
  }
  if (nextQuestion > total) {
    return `${welcome} All of your interview answers are saved. We'll finish the remaining closing steps.`;
  }
  return `${welcome} We'll continue with question ${nextQuestion} of ${total}.`;
}

/** Silence must not send ambient noise to STT and fabricate an answer.
 * An explicit Send still permits a soft-spoken answer below the VAD threshold. */
export function shouldTranscribeInterviewSegment(
  hadVoice: boolean,
  isFinal: boolean,
  manualFinal: boolean,
): boolean {
  return hadVoice || (isFinal && manualFinal);
}
