export const VOICE_PROGRESS_DIMENSIONS = [
  "clarity_structure",
  "empathy_tone",
  "clarification",
  "action_accuracy",
  "channel_execution",
] as const;

export type VoiceProgressDimension = (typeof VOICE_PROGRESS_DIMENSIONS)[number];
export type VoiceProgressForm = "A" | "B";
export type VoiceProgressPhase = "baseline" | "progress";
export type VoiceProgressLevel = "not_comparable" | "not_observed" | "emerging" | "developing" | "consistent";

export type VoiceProgressFact = {
  id: string;
  patterns: string[];
};

export type VoiceProgressPrompt = {
  key: string;
  prompt: string;
  minimumNonSpaceCharacters: number;
  coveredDimensions: VoiceProgressDimension[];
  facts: VoiceProgressFact[];
  unsafePatterns: string[];
  recommendationLessonIds: Partial<Record<VoiceProgressDimension, string[]>>;
};

export type VoiceProgressFormDefinition = {
  form: VoiceProgressForm;
  comparisonFamilyVersion: string;
  rubricVersion: string;
  evaluatorVersion: string;
  prompts: VoiceProgressPrompt[];
};

export type VoiceProgressDimensionResult = {
  dimension: VoiceProgressDimension;
  level: Exclude<VoiceProgressLevel, "not_comparable">;
  observed: number;
  possible: number;
  evidence: string[];
  recommendationLessonIds: string[];
};

export type VoiceProgressEvaluation = {
  form: VoiceProgressForm;
  comparisonFamilyVersion: string;
  rubricVersion: string;
  evaluatorVersion: string;
  dimensions: VoiceProgressDimensionResult[];
  recommendations: string[];
  overallSummary: string;
};

export type VoiceProgressComparison = {
  comparable: boolean;
  reason: string;
  dimensions: Array<{
    dimension: VoiceProgressDimension;
    baselineLevel: VoiceProgressLevel;
    progressLevel: VoiceProgressLevel;
    observedDifference: "higher" | "same" | "lower" | "not_comparable";
    evidence: string[];
  }>;
};