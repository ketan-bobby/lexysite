/** Candidate-visible configuration only; never expose grading or recruiter instructions. */
export function candidateInterviewConfiguration(
  plan: {
    id: string;
    title: string;
    interviewType: string;
    language: string | null;
    estimatedDurationMinutes: number | null;
    questions: unknown;
  },
  sessionLanguage: string | null,
) {
  const questions = Array.isArray(plan.questions) ? plan.questions : [];
  return {
    id: plan.id,
    title: plan.title,
    interviewType: plan.interviewType,
    language: sessionLanguage || plan.language,
    estimatedDurationMinutes: plan.estimatedDurationMinutes,
    // Spoken questions stay server-side. Coding candidates need their public
    // challenge text, examples and starter code, but not solutions/test cases.
    questions:
      plan.interviewType !== "programming"
        ? []
        : questions
            .filter((q) => q && typeof q === "object")
            .map((q) => ({
              id: q.id,
              title: q.title,
              description: q.description,
              difficulty: q.difficulty,
              estimatedMinutes: q.estimatedMinutes,
              starterCode: Object.fromEntries(
                Object.entries(q.starterCode ?? {}).filter(
                  ([language, code]) =>
                    /^(javascript|typescript|python|java|cpp|csharp|go|rust|ruby|swift|kotlin|sql)$/.test(
                      language,
                    ) && typeof code === "string",
                ),
              ),
              constraints: Array.isArray(q.constraints)
                ? q.constraints.filter((c: unknown) => typeof c === "string")
                : [],
              examples: Array.isArray(q.examples)
                ? q.examples
                    .filter((ex: any) => ex && typeof ex === "object")
                    .map((ex: any) => ({
                      input: ex.input,
                      output: ex.output,
                      explanation: ex.explanation,
                    }))
                : [],
            })),
  };
}
