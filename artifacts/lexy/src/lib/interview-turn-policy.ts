// This canonical policy is browser-safe: it imports no server/runtime dependencies.
export {
  isInterviewAudioClarification,
  interviewEvaluationWarning,
  isValidInterviewScore,
  INTERVIEW_SCORE_MODERATE,
  INTERVIEW_SCORE_STRONG,
} from "../../../api-server/src/lib/interview-turn-policy";
